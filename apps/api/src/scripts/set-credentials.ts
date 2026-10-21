/**
 * CLI: fija el correo y la contraseña del propietario (o de quien se indique).
 *
 *   node dist/scripts/set-credentials.js --owner --email=nuevo@correo.com
 *   node dist/scripts/set-credentials.js --email=actual@correo.com --nuevo-email=nuevo@correo.com
 *
 * La contraseña se lee de la ENTRADA ESTÁNDAR, nunca de la línea de órdenes: así
 * no queda en el historial del shell ni en la lista de procesos del servidor.
 *
 *   printf '%s' 'mi-clave' | node dist/scripts/set-credentials.js --owner --email=yo@correo.com
 *
 * POR QUÉ EXISTE
 * --------------
 * FINANZA no tiene recuperación por correo (no hay servidor de correo). Cuando el
 * propietario quiere que su cuenta sea «la suya» —su correo, su contraseña— hay
 * que poder hacerlo desde el servidor, sin endpoints de red que permitan a
 * cualquiera cambiar credenciales.
 *
 * LO QUE HACE, EN ORDEN
 * ---------------------
 *  1. Localiza al usuario (el propietario más antiguo con `--owner`, o por correo).
 *  2. Cambia el correo si se indica (comprobando que no esté ocupado).
 *  3. Fija la contraseña con el MISMO algoritmo que el resto de la aplicación.
 *  4. Desbloquea la cuenta y cierra sus sesiones abiertas.
 *  5. Lo deja escrito en la auditoría, como cualquier acción sensible.
 */
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { hashPassword, isPasswordStrongEnough } from '../auth/password.js';

interface Options {
  owner: boolean;
  email?: string;
  nuevoEmail?: string;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { owner: false };
  for (const argument of argv) {
    if (argument === '--owner') {
      options.owner = true;
    } else if (argument.startsWith('--email=')) {
      options.email = argument.slice('--email='.length).trim().toLowerCase();
    } else if (argument.startsWith('--nuevo-email=')) {
      options.nuevoEmail = argument.slice('--nuevo-email='.length).trim().toLowerCase();
    }
  }
  return options;
}

/** Lee todo lo que llegue por la entrada estándar (la contraseña). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const partes: Buffer[] = [];
  for await (const trozo of process.stdin) {
    partes.push(Buffer.from(trozo as Buffer));
  }
  return Buffer.concat(partes).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida.');
  }

  const options = parseOptions(process.argv.slice(2));
  const password = await readStdin();
  if (password.length === 0) {
    throw new Error(
      'Falta la contraseña. Se pasa por la entrada estándar: printf \'%s\' \'la-clave\' | node dist/scripts/set-credentials.js --owner --email=...',
    );
  }
  const strength = isPasswordStrongEnough(password);
  if (!strength.ok) {
    throw new Error(strength.reason ?? 'Contraseña demasiado débil');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const user = options.owner
      ? await prisma.user.findFirst({ where: { role: 'OWNER' }, orderBy: { createdAt: 'asc' } })
      : options.email
        ? await prisma.user.findUnique({ where: { email: options.email } })
        : null;

    if (!user) {
      throw new Error(
        options.owner
          ? 'No hay ningún usuario con rol OWNER en la base de datos.'
          : 'Indique el usuario con --owner o con --email=<correo actual>.',
      );
    }

    if (options.nuevoEmail && options.nuevoEmail !== user.email) {
      const ocupado = await prisma.user.findUnique({ where: { email: options.nuevoEmail }, select: { id: true } });
      if (ocupado && ocupado.id !== user.id) {
        throw new Error(`Ya existe otro usuario con el correo ${options.nuevoEmail}`);
      }
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(options.nuevoEmail ? { email: options.nuevoEmail } : {}),
        passwordHash: await hashPassword(password),
        failedLoginCount: 0,
        lockedUntil: null,
        isActive: true,
      },
    });

    const revoked = await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'CREDENTIALS_SET_BY_ADMIN' },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actorType: 'SYSTEM',
        action: 'auth.credentials.set_by_admin',
        entityType: 'User',
        entityId: user.id,
        beforeJson: { email: user.email },
        afterJson: { email: updated.email, sessionsRevoked: revoked.count },
        ip: 'local',
        userAgent: 'scripts/set-credentials',
      },
    });

    console.log('');
    console.log('=== Credenciales actualizadas ===');
    console.log(`  Usuario           : ${updated.name}`);
    console.log(`  Correo            : ${updated.email}`);
    console.log(`  Rol               : ${updated.role}`);
    console.log(`  Sesiones cerradas : ${revoked.count}`);
    console.log('  Auditoría         : registrado (auth.credentials.set_by_admin)');
    console.log('');
    console.log('  Entre con ese correo y esa contraseña. Cámbiela en Ajustes → Seguridad.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error('No se pudieron fijar las credenciales:');
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error('');
  process.exit(1);
});
