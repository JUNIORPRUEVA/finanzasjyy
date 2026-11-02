import type { PrismaClient } from '../generated/prisma/client.js';
import { generateRandomPassword, hashPassword } from '../auth/password.js';
import { CHART_OF_ACCOUNTS } from '../domain/chart-of-accounts.js';
import { DEFAULT_CATEGORIES, INITIAL_ENTITIES } from '../domain/default-categories.js';

export interface StructuralSeedOptions {
  adminEmail?: string;
  adminName?: string;
  /**
   * Si se omite, se usa ADMIN_PASSWORD del entorno. Si tampoco existe, se
   * genera una contraseña aleatoria y se devuelve UNA sola vez para que el
   * usuario pueda copiarla (nunca se guarda en claro en la base de datos).
   */
  adminPassword?: string;
}

export interface StructuralSeedResult {
  adminEmail: string;
  adminCreated: boolean;
  generatedPassword?: string;
  ledgerAccounts: number;
  categories: number;
  entities: string[];
}

/**
 * SEMILLA ESTRUCTURAL DE FINANZA
 * ------------------------------
 * Crea la estructura imprescindible para operar:
 *   - catálogo contable (partida doble),
 *   - categorías por defecto,
 *   - las unidades financieras iniciales,
 *   - el usuario propietario y sus preferencias.
 *
 * NO crea saldos, movimientos ni importes: el usuario introduce sus cifras
 * reales. Cualquier dato de ejemplo vive exclusivamente en `demo-seed.ts`,
 * que se niega a ejecutarse en producción y marca la unidad como DEMO.
 *
 * Es idempotente: puede ejecutarse tantas veces como se quiera.
 */
/**
 * LÍNEA BASE CONTABLE (sin usuarios, sin unidades, sin datos)
 * ----------------------------------------------------------
 * Crea lo que NO puede faltar para que se pueda mover dinero:
 * el catálogo contable y las categorías por defecto.
 *
 * Por qué existe aparte: en producción se aplicaron las migraciones pero nunca
 * se ejecutó la semilla, así que el catálogo quedó VACÍO (0 cuentas contables) y
 * cualquier intento de crear una cuenta de banco fallaba con «cuenta contable no
 * encontrada». Este bloque se ejecuta en cada arranque de la API (es idempotente
 * y son ~90 upserts), de modo que un despliegue o una restauración nunca pueda
 * dejar la contabilidad sin estructura.
 */
export async function runLedgerBaseline(prisma: PrismaClient): Promise<{ ledgerAccounts: number; categories: number }> {
  for (const account of CHART_OF_ACCOUNTS) {
    await prisma.ledgerAccount.upsert({
      where: { code: account.code },
      create: {
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
        isSystem: true,
        isPostable: account.isPostable ?? true,
        description: account.description ?? null,
      },
      update: {
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
        isPostable: account.isPostable ?? true,
        description: account.description ?? null,
      },
    });
  }

  // Nota: `@@unique([entityId, name, kind])` no sirve para las categorías
  // globales porque en PostgreSQL los NULL no colisionan en un índice único.
  // Por eso se busca y se crea explícitamente.
  for (const category of DEFAULT_CATEGORIES) {
    const existing = await prisma.transactionCategory.findFirst({
      where: { entityId: null, name: category.name, kind: category.kind },
    });
    if (existing) {
      await prisma.transactionCategory.update({
        where: { id: existing.id },
        data: { defaultLedgerCode: category.defaultLedgerCode, isSystem: true },
      });
    } else {
      await prisma.transactionCategory.create({
        data: {
          entityId: null,
          name: category.name,
          kind: category.kind,
          defaultLedgerCode: category.defaultLedgerCode,
          isSystem: true,
          isActive: true,
        },
      });
    }
  }

  return { ledgerAccounts: CHART_OF_ACCOUNTS.length, categories: DEFAULT_CATEGORIES.length };
}

/**
 * PERSONAS JURÍDICAS: RELACIONES CONFIRMADAS
 * ------------------------------------------
 * Sólo rellena lo que el propietario confirmó expresamente:
 *
 *   · FULLTECH (o FULLTECH_PRINCIPAL) → sociedad FULLTECH S.R.L.
 *   · APPYRA → MISMA sociedad, y cuelga de FULLTECH como marca.
 *   · PERSONAL → persona física propietaria.
 *   · Todo lo demás (PHYTOEMAGRY, FULLPOS CLOUD…) se queda SIN CONFIRMAR a
 *     propósito: el sistema tiene que preguntar, no suponer. Tratarlas como
 *     parte de la SRL inventaría una relación que nadie ha verificado.
 *
 * Nunca sobrescribe una relación ya puesta a mano: si alguien corrigió algo, se
 * respeta. Es idempotente.
 */
export async function runLegalStructureSeed(prisma: PrismaClient): Promise<{ legalEntities: string[]; linked: string[] }> {
  const srl = await prisma.legalEntity.upsert({
    where: { code: 'FULLTECH_SRL' },
    create: {
      code: 'FULLTECH_SRL',
      name: 'FULLTECH S.R.L.',
      kind: 'COMPANY',
      notes: 'Sociedad de responsabilidad limitada formalmente constituida.',
    },
    update: { name: 'FULLTECH S.R.L.', kind: 'COMPANY' },
  });

  const propietario = await prisma.legalEntity.upsert({
    where: { code: 'PROPIETARIO' },
    create: {
      code: 'PROPIETARIO',
      name: 'El propietario (persona física)',
      kind: 'INDIVIDUAL',
      notes: 'Finanzas personales del propietario. Sujeto jurídico distinto de la SRL.',
    },
    update: { name: 'El propietario (persona física)', kind: 'INDIVIDUAL' },
  });

  const linked: string[] = [];

  const asignar = async (codes: string[], legalEntityId: string) => {
    for (const code of codes) {
      const entity = await prisma.financialEntity.findFirst({ where: { code } });
      if (!entity || entity.legalEntityId) {
        continue;
      }
      await prisma.financialEntity.update({ where: { id: entity.id }, data: { legalEntityId } });
      linked.push(entity.code);
    }
  };

  // La sociedad, por cualquiera de los dos códigos con los que se ha creado.
  await asignar(['FULLTECH', 'FULLTECH_PRINCIPAL'], srl.id);
  await asignar(['PERSONAL'], propietario.id);

  // APPYRA: misma sociedad y, además, marca que cuelga de FULLTECH.
  const fulltech = await prisma.financialEntity.findFirst({ where: { code: { in: ['FULLTECH', 'FULLTECH_PRINCIPAL'] } } });
  const appyra = await prisma.financialEntity.findFirst({ where: { code: 'APPYRA_SISTEMAS' } });
  if (appyra && !appyra.legalEntityId) {
    await prisma.financialEntity.update({
      where: { id: appyra.id },
      data: { legalEntityId: srl.id, parentEntityId: fulltech?.id ?? null },
    });
    linked.push(appyra.code);
  }

  return { legalEntities: [srl.code, propietario.code], linked };
}


export async function runStructuralSeed(
  prisma: PrismaClient,
  options: StructuralSeedOptions = {},
): Promise<StructuralSeedResult> {
  const adminEmail = (options.adminEmail ?? process.env.ADMIN_EMAIL ?? 'admin@finanza.local').toLowerCase();
  const adminName = options.adminName ?? process.env.ADMIN_NAME ?? 'Propietario';

  // ---------------- 1 y 2. Catálogo contable y categorías -----------------
  await runLedgerBaseline(prisma);

  // ---------------------- 3. Usuario propietario ------------------------
  let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  let generatedPassword: string | undefined;
  let adminCreated = false;

  if (!admin) {
    const plainPassword =
      options.adminPassword ?? process.env.ADMIN_PASSWORD ?? generateRandomPassword(20);
    if (!options.adminPassword && !process.env.ADMIN_PASSWORD) {
      generatedPassword = plainPassword;
    }
    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        name: adminName,
        passwordHash: await hashPassword(plainPassword),
        role: 'OWNER',
        isActive: true,
      },
    });
    adminCreated = true;
  }

  await prisma.userPreference.upsert({
    where: { userId: admin.id },
    create: { userId: admin.id },
    update: {},
  });

  // ------------------- 4. Unidades financieras iniciales -----------------
  const entityCodes: string[] = [];
  for (const entity of INITIAL_ENTITIES) {
    const created = await prisma.financialEntity.upsert({
      where: { code: entity.code },
      create: {
        code: entity.code,
        name: entity.name,
        type: entity.type,
        description: entity.description,
        ownerUserId: admin.id,
        currency: process.env.DEFAULT_CURRENCY ?? 'DOP',
        timezone: process.env.BUSINESS_TIMEZONE ?? 'America/Santo_Domingo',
        isActive: true,
      },
      update: {
        name: entity.name,
        description: entity.description,
      },
    });
    entityCodes.push(created.code);

    await prisma.entityMember.upsert({
      where: { entityId_userId: { entityId: created.id, userId: admin.id } },
      create: { entityId: created.id, userId: admin.id, role: 'OWNER' },
      update: { role: 'OWNER' },
    });
  }

  // ---------- 5. Personas jurídicas (relaciones confirmadas) ----------
  await runLegalStructureSeed(prisma);

  return {
    adminEmail,
    adminCreated,
    generatedPassword,
    ledgerAccounts: CHART_OF_ACCOUNTS.length,
    categories: DEFAULT_CATEGORIES.length,
    entities: entityCodes,
  };
}
