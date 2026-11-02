import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { LEDGER } from '../domain/chart-of-accounts.js';
import { toBusinessDate } from '../domain/business-date.js';
import { dec, round2, validateMoney } from '../domain/money.js';
import { classifyTransfer } from '../domain/legal-structure.js';
import { expensePaidByOwnerDualPostings, reimbursementPaymentDualPostings } from '../domain/reimbursement-rules.js';
import { postEntry, reverseEntry } from '../ledger/ledger-core.js';
import type { CreateReimbursementDto, ListReimbursementsQuery, PayReimbursementDto } from './reimbursements.dto.js';

/**
 * REEMBOLSOS: EL PROPIETARIO PAGA UN GASTO DE LA EMPRESA
 * ======================================================
 * El hecho: el propietario paga el hosting de FULLTECH con su tarjeta personal.
 *
 * Lo que este servicio garantiza (y las pruebas comprueban):
 *
 *  1. **El gasto se reconoce UNA vez**, en la empresa. En sus finanzas personales
 *     NO hay gasto: hay un derecho de cobro (1200) que compensa el dinero que
 *     salió de su cuenta. Si se registrara también como gasto personal, el mismo
 *     dinero se restaría dos veces de su patrimonio.
 *  2. **La devolución no es un gasto**: baja la deuda (2350) y desaparece el
 *     derecho de cobro. No se toca ninguna cuenta de resultado.
 *  3. **Todo es reversible** con asientos contrarios, nunca borrando.
 *  4. **Nada se inventa**: si la empresa y la cuenta personal pertenecen a la
 *     misma persona jurídica, esto no es un reembolso (es un traslado interno) y
 *     se rechaza; si la relación jurídica no está confirmada, se pide confirmarla.
 */
@Injectable()
export class ReimbursementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // 1. Registrar el gasto pagado por el propietario
  // -------------------------------------------------------------------------
  async create(user: AuthenticatedUser, dto: CreateReimbursementDto, meta: RequestMetaInfo) {
    const amount = validateMoney(dto.amount, { field: 'importe pagado por el propietario' });
    const businessDate = toBusinessDate(dto.businessDate);
    const clientOperationId =
      dto.clientOperationId ?? `rmb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    // Reintento del mismo envío (móvil sin conexión): no se duplica nada.
    const existing = await this.prisma.ownerReimbursement.findUnique({
      where: { clientOperationId },
      include: this.include(),
    });
    if (existing) {
      return this.present(existing, true);
    }

    const company = await this.prisma.financialEntity.findUnique({
      where: { id: dto.companyEntityId },
      select: { id: true, code: true, name: true, type: true, legalEntityId: true, currency: true },
    });
    if (!company) {
      throw new NotFoundError('Unidad financiera', dto.companyEntityId);
    }
    if (company.type === 'PERSONAL') {
      throw new ValidationError(
        'El gasto es de un negocio: elija la unidad de negocio que queda debiendo el dinero.',
      );
    }

    const ownerAccount = await this.loadAccount(dto.ownerAccountId);
    if (ownerAccount.entityId === company.id) {
      throw new ValidationError('El dinero no puede salir de la misma unidad que debe el reembolso.');
    }
    if (ownerAccount.entity.type !== 'PERSONAL') {
      throw new ValidationError(
        `El dinero tiene que salir de una cuenta de sus finanzas personales y la cuenta elegida es de «${ownerAccount.entity.name}».`,
      );
    }
    if (ownerAccount.status !== 'ACTIVE') {
      throw new ConflictError('La cuenta personal elegida no está activa');
    }
    if (ownerAccount.currency !== company.currency) {
      throw new ValidationError(
        `No se puede reembolsar entre monedas distintas (${company.currency} → ${ownerAccount.currency}).`,
      );
    }

    // Frontera jurídica: esto sólo tiene sentido entre sujetos distintos.
    const relation = classifyTransfer(company, ownerAccount.entity);
    if (relation.relation === 'SAME_LEGAL_ENTITY') {
      throw new ValidationError(
        'La cuenta personal y la empresa son de la misma persona jurídica: esto es un traslado interno, no un reembolso.',
      );
    }
    if (relation.relation === 'UNKNOWN') {
      throw new ValidationError(relation.reason);
    }

    await this.access.assertCanWrite(user.userId, company.id);
    await this.access.assertCanWrite(user.userId, ownerAccount.entityId);

    const expenseLedgerCode = await this.resolveExpenseLedgerCode(dto.categoryId, company.id);

    const postings = expensePaidByOwnerDualPostings({
      amount,
      expenseLedgerCode,
      ownerLedgerCode: ownerAccount.ledgerAccount.code,
      ownerAccountId: ownerAccount.id,
      memo: dto.description.trim(),
    });

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      const companyEntry = await postEntry(tx, {
        entityId: company.id,
        businessDate,
        description: dto.description.trim(),
        sourceType: 'TRANSACTION',
        lines: postings.company,
        createdByUserId: user.userId,
      });

      const ownerEntry = await postEntry(tx, {
        entityId: ownerAccount.entityId,
        businessDate,
        description: `${dto.description.trim()} (pagado para ${company.name})`,
        sourceType: 'TRANSACTION',
        lines: postings.owner,
        createdByUserId: user.userId,
      });

      // Movimiento visible en la empresa: el gasto, con su categoría.
      await tx.financialTransaction.create({
        data: {
          entityId: company.id,
          kind: 'OWNER_PAID_COMPANY_EXPENSE',
          status: 'POSTED',
          // La cuenta física que movió el dinero es la personal: es la única que
          // existe en este hecho (la empresa no tocó ningún banco suyo).
          accountId: ownerAccount.id,
          categoryId: dto.categoryId ?? null,
          journalEntryId: companyEntry.id,
          amount,
          currency: company.currency,
          businessDate,
          description: dto.description.trim(),
          method: dto.method ?? null,
          clientOperationId,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      // Movimiento visible en las finanzas personales: sale el dinero y nace el
      // derecho de cobro. NO lleva categoría de gasto A PROPÓSITO, y su tipo es
      // distinto del de la empresa para que un informe consolidado no cuente la
      // misma operación dos veces.
      await tx.financialTransaction.create({
        data: {
          entityId: ownerAccount.entityId,
          kind: 'OWNER_ADVANCE_TO_COMPANY',
          status: 'POSTED',
          accountId: ownerAccount.id,
          categoryId: null,
          journalEntryId: ownerEntry.id,
          amount,
          currency: ownerAccount.currency,
          businessDate,
          description: `${dto.description.trim()} (a cuenta de ${company.name})`,
          method: dto.method ?? null,
          clientOperationId: `${clientOperationId}:owner`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      const reimbursement = await tx.ownerReimbursement.create({
        data: {
          companyEntityId: company.id,
          ownerEntityId: ownerAccount.entityId,
          ownerAccountId: ownerAccount.id,
          categoryId: dto.categoryId ?? null,
          description: dto.description.trim(),
          originalAmount: amount,
          currency: company.currency,
          businessDate,
          status: 'OPEN',
          companyEntryId: companyEntry.id,
          ownerEntryId: ownerEntry.id,
          clientOperationId,
        },
        include: this.include(),
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'reimbursement.created',
          entityType: 'OwnerReimbursement',
          entityId: reimbursement.id,
          businessId: companyEntry.id,
          after: {
            companyEntityId: company.id,
            ownerEntityId: ownerAccount.entityId,
            ownerAccountId: ownerAccount.id,
            amount: amount.toFixed(2),
            expenseLedgerCode,
            companyEntryId: companyEntry.id,
            ownerEntryId: ownerEntry.id,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return reimbursement;
    });

    return this.present(created, false);
  }

  // -------------------------------------------------------------------------
  // 2. La empresa devuelve el dinero
  // -------------------------------------------------------------------------
  async pay(user: AuthenticatedUser, reimbursementId: string, dto: PayReimbursementDto, meta: RequestMetaInfo) {
    const reimbursement = await this.prisma.ownerReimbursement.findUnique({
      where: { id: reimbursementId },
      include: { ...this.include(), payments: { select: { id: true } } },
    });
    if (!reimbursement) {
      throw new NotFoundError('Reembolso', reimbursementId);
    }
    if (reimbursement.status === 'VOIDED') {
      throw new ConflictError('Este reembolso está anulado');
    }
    if (reimbursement.status === 'SETTLED') {
      throw new ConflictError('Este reembolso ya está devuelto por completo');
    }

    await this.access.assertCanWrite(user.userId, reimbursement.companyEntityId);
    await this.access.assertCanWrite(user.userId, reimbursement.ownerEntityId);

    /**
     * IDEMPOTENCIA ANTES QUE NADA
     * ---------------------------
     * Un reintento del mismo pago tiene que devolver el resultado que ya existe,
     * no volver a validarlo: si se validara primero, el segundo intento se
     * encontraría con que «ya sólo quedan 200» y respondería 400 a un pago que en
     * realidad sí se hizo. El identificador de operación es la prueba.
     */
    if (dto.clientOperationId) {
      const yaHecho = await this.prisma.ownerReimbursementPayment.findUnique({
        where: { clientOperationId: dto.clientOperationId },
      });
      if (yaHecho) {
        return this.present(
          await this.prisma.ownerReimbursement.findUniqueOrThrow({ where: { id: reimbursementId }, include: this.include() }),
          true,
        );
      }
    }

    const pending = round2(reimbursement.originalAmount).minus(round2(reimbursement.settledAmount));
    const amount = dto.amount ? validateMoney(dto.amount, { field: 'importe a devolver' }) : pending;
    if (amount.lte(0)) {
      throw new ValidationError('El importe a devolver debe ser mayor que cero');
    }
    if (amount.gt(pending)) {
      throw new ValidationError(
        `Quedan ${pending.toFixed(2)} pendientes de devolver y se intentó devolver ${amount.toFixed(2)}.`,
      );
    }

    const companyAccount = await this.loadAccount(dto.companyAccountId);
    if (companyAccount.entityId !== reimbursement.companyEntityId) {
      throw new ValidationError('La cuenta de la que sale el dinero no es de la empresa que debe el reembolso');
    }
    if (companyAccount.status !== 'ACTIVE') {
      throw new ConflictError('La cuenta de la empresa elegida no está activa');
    }
    if (companyAccount.isCreditCard) {
      throw new ValidationError(
        'Una devolución no puede salir de una tarjeta de crédito: use la cuenta desde la que realmente paga.',
      );
    }
    if (companyAccount.currency !== reimbursement.currency) {
      throw new ValidationError('La cuenta de la empresa usa otra moneda');
    }

    const ownerAccount = await this.loadAccount(reimbursement.ownerAccountId);
    const businessDate = toBusinessDate(dto.businessDate);
    const clientOperationId =
      dto.clientOperationId ?? `rmbpay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    const existing = await this.prisma.ownerReimbursementPayment.findUnique({ where: { clientOperationId } });
    if (existing) {
      return this.present(await this.prisma.ownerReimbursement.findUniqueOrThrow({ where: { id: reimbursementId }, include: this.include() }), true);
    }

    const postings = reimbursementPaymentDualPostings({
      amount,
      companyLedgerCode: companyAccount.ledgerAccount.code,
      companyAccountId: companyAccount.id,
      ownerLedgerCode: ownerAccount.ledgerAccount.code,
      ownerAccountId: ownerAccount.id,
      memo: `Devolución de ${reimbursement.description}`,
    });

    const settledTotal = round2(reimbursement.settledAmount).plus(amount);

    const updated = await this.prisma.inMoneyTransaction(async (tx) => {
      const companyEntry = await postEntry(tx, {
        entityId: reimbursement.companyEntityId,
        businessDate,
        description: `Devolución al propietario: ${reimbursement.description}`,
        sourceType: 'TRANSACTION',
        lines: postings.company,
        createdByUserId: user.userId,
      });

      const ownerEntry = await postEntry(tx, {
        entityId: reimbursement.ownerEntityId,
        businessDate,
        description: `Cobro de ${companyAccount.entity.name}: ${reimbursement.description}`,
        sourceType: 'TRANSACTION',
        lines: postings.owner,
        createdByUserId: user.userId,
      });

      await tx.financialTransaction.create({
        data: {
          entityId: reimbursement.companyEntityId,
          kind: 'OWNER_REIMBURSEMENT_PAYMENT',
          status: 'POSTED',
          accountId: companyAccount.id,
          journalEntryId: companyEntry.id,
          amount,
          currency: reimbursement.currency,
          businessDate,
          description: `Devolución al propietario: ${reimbursement.description}`,
          clientOperationId,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await tx.financialTransaction.create({
        data: {
          entityId: reimbursement.ownerEntityId,
          kind: 'OWNER_REIMBURSEMENT_PAYMENT',
          status: 'POSTED',
          accountId: ownerAccount.id,
          journalEntryId: ownerEntry.id,
          amount,
          currency: reimbursement.currency,
          businessDate,
          description: `Devolución de ${companyAccount.entity.name}: ${reimbursement.description}`,
          clientOperationId: `${clientOperationId}:owner`,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await tx.ownerReimbursementPayment.create({
        data: {
          reimbursementId,
          companyAccountId: companyAccount.id,
          ownerAccountId: ownerAccount.id,
          amount,
          businessDate,
          companyEntryId: companyEntry.id,
          ownerEntryId: ownerEntry.id,
          clientOperationId,
        },
      });

      const result = await tx.ownerReimbursement.update({
        where: { id: reimbursementId },
        data: {
          settledAmount: settledTotal,
          status: settledTotal.gte(round2(reimbursement.originalAmount)) ? 'SETTLED' : 'PARTIAL',
        },
        include: this.include(),
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'reimbursement.paid',
          entityType: 'OwnerReimbursement',
          entityId: reimbursementId,
          businessId: companyEntry.id,
          after: {
            amount: amount.toFixed(2),
            companyAccountId: companyAccount.id,
            ownerAccountId: ownerAccount.id,
            settledAmount: settledTotal.toFixed(2),
            companyEntryId: companyEntry.id,
            ownerEntryId: ownerEntry.id,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return result;
    });

    return this.present(updated, false);
  }

  // -------------------------------------------------------------------------
  // 3. Anulación controlada
  // -------------------------------------------------------------------------
  async void(user: AuthenticatedUser, reimbursementId: string, reason: string, meta: RequestMetaInfo) {
    if (!reason || reason.trim().length < 5) {
      throw new ValidationError('Explique por qué se anula (mínimo 5 caracteres): queda en la auditoría');
    }
    const reimbursement = await this.prisma.ownerReimbursement.findUnique({
      where: { id: reimbursementId },
      include: { payments: { select: { id: true } } },
    });
    if (!reimbursement) {
      throw new NotFoundError('Reembolso', reimbursementId);
    }
    if (reimbursement.status === 'VOIDED') {
      throw new ConflictError('Este reembolso ya está anulado');
    }
    if (reimbursement.payments.length > 0) {
      throw new ConflictError(
        'Este reembolso ya tiene devoluciones registradas. Anule primero las devoluciones: borrar el gasto original dejaría el dinero sin explicación.',
      );
    }

    await this.access.assertCanWrite(user.userId, reimbursement.companyEntityId);
    await this.access.assertCanWrite(user.userId, reimbursement.ownerEntityId);

    await this.prisma.inMoneyTransaction(async (tx) => {
      const businessDate = toBusinessDate();
      // Se reversan los DOS asientos: el gasto y la salida de dinero personal.
      await reverseEntry(tx, {
        entryId: reimbursement.companyEntryId,
        reason: reason.trim(),
        businessDate,
        createdByUserId: user.userId,
      });
      await reverseEntry(tx, {
        entryId: reimbursement.ownerEntryId,
        reason: reason.trim(),
        businessDate,
        createdByUserId: user.userId,
      });

      await tx.financialTransaction.updateMany({
        where: { clientOperationId: { in: [reimbursement.clientOperationId, `${reimbursement.clientOperationId}:owner`] } },
        data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason.trim() },
      });

      await tx.ownerReimbursement.update({
        where: { id: reimbursementId },
        data: { status: 'VOIDED' },
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'reimbursement.voided',
          entityType: 'OwnerReimbursement',
          entityId: reimbursementId,
          after: { reason: reason.trim() },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.present(
      await this.prisma.ownerReimbursement.findUniqueOrThrow({ where: { id: reimbursementId }, include: this.include() }),
      false,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Consulta
  // -------------------------------------------------------------------------
  async list(user: AuthenticatedUser, query: ListReimbursementsQuery) {
    const entityIds = await this.access.listAccessibleEntityIds(user.userId);
    const limit = Math.min(200, query.limit ?? 50);
    const page = query.page ?? 1;

    const where: Prisma.OwnerReimbursementWhereInput = {
      companyEntityId: query.companyEntityId ? query.companyEntityId : { in: entityIds },
      status: query.status ? (query.status as 'OPEN' | 'PARTIAL' | 'SETTLED' | 'VOIDED') : undefined,
    };

    const [rows, total, pending] = await Promise.all([
      this.prisma.ownerReimbursement.findMany({
        where,
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: this.include(),
      }),
      this.prisma.ownerReimbursement.count({ where }),
      this.prisma.ownerReimbursement.findMany({
        where: { ...where, status: { in: ['OPEN', 'PARTIAL'] } },
        select: { originalAmount: true, settledAmount: true, companyEntityId: true, companyEntity: { select: { name: true } } },
      }),
    ]);

    const porEmpresa = new Map<string, { name: string; pending: ReturnType<typeof dec> }>();
    for (const row of pending) {
      const current = porEmpresa.get(row.companyEntityId) ?? { name: row.companyEntity.name, pending: dec(0) };
      current.pending = current.pending.plus(round2(row.originalAmount).minus(round2(row.settledAmount)));
      porEmpresa.set(row.companyEntityId, current);
    }

    return {
      data: rows.map((row) => this.present(row, false)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        /** Lo que las empresas deben al propietario ahora mismo. */
        pendingTotal: [...porEmpresa.values()].reduce((acc, row) => acc.plus(row.pending), dec(0)).toFixed(2),
        pendingByCompany: [...porEmpresa.entries()].map(([entityId, row]) => ({
          entityId,
          entityName: row.name,
          pending: row.pending.toFixed(2),
        })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  /** Categoría de gasto → cuenta 5xxx/6xxx. Sin categoría se usa «otros gastos». */
  private async resolveExpenseLedgerCode(categoryId: string | undefined, companyEntityId: string): Promise<string> {
    if (!categoryId) {
      return LEDGER.OTHER_OPERATING_EXPENSE;
    }
    const category = await this.prisma.transactionCategory.findUnique({
      where: { id: categoryId },
      select: { name: true, kind: true, defaultLedgerCode: true, entityId: true, isActive: true },
    });
    if (!category) {
      throw new NotFoundError('Categoría', categoryId);
    }
    if (category.entityId && category.entityId !== companyEntityId) {
      throw new ValidationError('La categoría no pertenece a la empresa que debe el reembolso');
    }
    if (category.kind !== 'EXPENSE') {
      throw new ValidationError(`La categoría «${category.name}» es de ingresos y aquí se necesita una de gastos.`);
    }
    if (!category.isActive) {
      throw new ConflictError(`La categoría «${category.name}» está desactivada`);
    }
    return category.defaultLedgerCode ?? LEDGER.OTHER_OPERATING_EXPENSE;
  }

  private async loadAccount(accountId: string) {
    const account = await this.prisma.financialAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        entityId: true,
        currency: true,
        status: true,
        isCreditCard: true,
        ledgerAccount: { select: { code: true, name: true } },
        entity: { select: { id: true, code: true, name: true, type: true, legalEntityId: true } },
      },
    });
    if (!account) {
      throw new NotFoundError('Cuenta financiera', accountId);
    }
    return account;
  }

  private include() {
    return {
      companyEntity: { select: { id: true, code: true, name: true } },
      ownerEntity: { select: { id: true, code: true, name: true } },
      ownerAccount: { select: { id: true, name: true, entityId: true } },
      category: { select: { id: true, name: true } },
      payments: {
        select: {
          id: true,
          amount: true,
          businessDate: true,
          companyAccountId: true,
          ownerAccountId: true,
          createdAt: true,
        },
        orderBy: { businessDate: 'asc' as const },
      },
    } satisfies Prisma.OwnerReimbursementInclude;
  }

  private present(
    row: Prisma.OwnerReimbursementGetPayload<{ include: ReturnType<ReimbursementsService['include']> }>,
    duplicate: boolean,
  ) {
    const pending = round2(row.originalAmount).minus(round2(row.settledAmount));
    return {
      id: row.id,
      companyEntity: row.companyEntity,
      ownerEntity: row.ownerEntity,
      ownerAccount: row.ownerAccount,
      category: row.category,
      description: row.description,
      originalAmount: round2(row.originalAmount).toFixed(2),
      settledAmount: round2(row.settledAmount).toFixed(2),
      pending: pending.isNegative() ? '0.00' : pending.toFixed(2),
      currency: row.currency,
      businessDate: row.businessDate,
      status: row.status,
      /** Deja claro que esto no es un gasto personal ni un ingreso. */
      affectsPersonalResult: false,
      payments: row.payments.map((payment) => ({
        ...payment,
        amount: round2(payment.amount).toFixed(2),
      })),
      createdAt: row.createdAt,
      ...(duplicate ? { duplicate: true } : {}),
    };
  }
}
