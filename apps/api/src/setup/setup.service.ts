import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, ValidationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { postEntry, type JournalLineInput } from '../ledger/ledger-core.js';
import { ACCOUNT_TYPE_LEDGER, LEDGER } from '../domain/chart-of-accounts.js';
import { businessDateToIso, businessToday, toBusinessDate } from '../domain/business-date.js';
import { dec, round2, sum, validateMoney } from '../domain/money.js';
import type { OrganizeMoneyDto } from './setup.dto.js';

/**
 * CONCILIACIÓN INICIAL — «ORGANIZAR MI DINERO»
 * -------------------------------------------
 * Registra la situación REAL del usuario en un momento dado:
 *
 *   · cuánto efectivo y cuánto en cada banco,
 *   · qué deudas tiene (préstamos, tarjetas),
 *   · qué le deben,
 *   · qué compromisos paga cada mes.
 *
 * Cómo se contabiliza (y por qué así):
 *
 *   Todos los saldos iniciales y las deudas PREVIAS se registran contra la cuenta
 *   3400 «Saldo de apertura» (patrimonio), NO contra ingresos ni gastos:
 *
 *       Banco          50.000   (debe)   ← dinero que existe hoy
 *       Préstamo 2200  20.000   (haber)  ← deuda que ya existía
 *       Apertura 3400  30.000   (haber)  ← patrimonio neto real
 *
 *   Consecuencia buscada: el panel del mes no muestra un ingreso inventado de
 *   50.000 ni un gasto inventado de 20.000. El resultado del día y del mes sigue
 *   siendo el de la actividad real; la posición de apertura se ve como
 *   patrimonio, que es lo que es.
 *
 *   Una deuda NO se presenta como dinero disponible, y el efectivo contado no se
 *   presenta como beneficio.
 *
 * Es idempotente por construcción: si una unidad ya tiene asiento de apertura,
 * el asistente se niega a repetirlo (no hay forma de duplicar el patrimonio).
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Estado actual: qué falta por registrar
  // -------------------------------------------------------------------------

  async status(user: AuthenticatedUser, entityId?: string) {
    const entityIds = await this.access.resolveScope(user.userId, entityId);

    const [entities, accounts, openingEntries, loans, receivables, payables, recurrings, closings] =
      await Promise.all([
        this.prisma.financialEntity.findMany({
          where: { id: { in: entityIds } },
          select: { id: true, code: true, name: true, type: true, currency: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.financialAccount.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, status: { not: 'CLOSED' } },
          _count: { _all: true },
        }),
        this.prisma.journalEntry.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, sourceType: 'OPENING_BALANCE' },
          _count: { _all: true },
          _max: { businessDate: true },
        }),
        this.prisma.loan.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, status: 'ACTIVE' },
          _count: { _all: true },
        }),
        this.prisma.receivable.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
          _count: { _all: true },
        }),
        this.prisma.payable.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
          _count: { _all: true },
        }),
        this.prisma.recurringObligation.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, status: 'ACTIVE' },
          _count: { _all: true },
        }),
        this.prisma.dailyClosing.groupBy({
          by: ['entityId'],
          where: { entityId: { in: entityIds }, closedAt: { not: null } },
          _count: { _all: true },
        }),
      ]);

    const countOf = (rows: Array<{ entityId: string; _count: { _all: number } }>, id: string) =>
      rows.find((row) => row.entityId === id)?._count._all ?? 0;

    const perEntity = entities.map((entity) => {
      const opening = openingEntries.find((row) => row.entityId === entity.id);
      return {
        ...entity,
        accounts: countOf(accounts, entity.id),
        openingBalancePosted: (opening?._count._all ?? 0) > 0,
        openingBalanceDate: opening?._max.businessDate ? businessDateToIso(opening._max.businessDate) : null,
        loans: countOf(loans, entity.id),
        receivables: countOf(receivables, entity.id),
        payables: countOf(payables, entity.id),
        recurrings: countOf(recurrings, entity.id),
        closings: countOf(closings, entity.id),
      };
    });

    const anyConfigured = perEntity.some((entity) => entity.openingBalancePosted);
    const anyAccount = perEntity.some((entity) => entity.accounts > 0);
    const anyDebt = perEntity.some((entity) => entity.loans + entity.payables > 0);
    const anyCommitment = perEntity.some((entity) => entity.recurrings > 0);
    const anyClosing = perEntity.some((entity) => entity.closings > 0);

    const checklist = [
      {
        key: 'accounts',
        label: 'Registrar cuánto dinero hay (efectivo y bancos)',
        done: anyAccount,
        detail: 'Cuentas creadas en alguna unidad financiera.',
      },
      {
        key: 'opening_balances',
        label: 'Confirmar los saldos iniciales',
        done: anyConfigured,
        detail: 'Los saldos se registran contra el patrimonio (3400), no como ingresos.',
      },
      {
        key: 'debts',
        label: 'Anotar lo que debo y lo que me deben',
        done: anyDebt,
        detail: 'Préstamos, tarjetas, cuentas por pagar y por cobrar.',
      },
      {
        key: 'commitments',
        label: 'Anotar los compromisos de cada mes',
        done: anyCommitment,
        detail: 'Alquiler, internet, nómina, suscripciones...',
      },
      {
        key: 'first_closing',
        label: 'Hacer el primer cierre diario',
        done: anyClosing,
        detail: 'Es lo que confirma día a día que el saldo cuadra.',
      },
    ];

    return {
      generatedAt: new Date().toISOString(),
      businessDate: businessDateToIso(businessToday()),
      needsSetup: !anyConfigured,
      entities: perEntity,
      checklist,
      pending: checklist.filter((step) => !step.done).map((step) => step.label),
      message: anyConfigured
        ? 'Ya hay saldos iniciales registrados. Si necesita añadir cuentas, use la pantalla de Cuentas.'
        : 'Todavía no hay saldos iniciales: la aplicación no puede saber cuánto dinero tiene hasta que lo declare.',
    };
  }

  // -------------------------------------------------------------------------
  // Guardar la situación real
  // -------------------------------------------------------------------------

  async organize(user: AuthenticatedUser, dto: OrganizeMoneyDto, meta: RequestMetaInfo) {
    if (dto.confirm !== true) {
      throw new ValidationError(
        'Falta la confirmación de la conciliación inicial. Revise los importes y confirme para guardarlos.',
      );
    }

    const accounts = dto.accounts ?? [];
    const loans = dto.loans ?? [];
    const receivables = dto.receivables ?? [];
    const payables = dto.payables ?? [];
    const recurrings = dto.recurrings ?? [];

    if (accounts.length + loans.length + receivables.length + payables.length + recurrings.length === 0) {
      throw new ValidationError('No hay nada que registrar: indique al menos una cuenta, deuda o compromiso.');
    }

    const businessDate = dto.asOfDate ? toBusinessDate(dto.asOfDate) : businessToday();

    // ------------------------------- Permisos ------------------------------
    const entityIds = [
      ...new Set([
        ...accounts.map((row) => row.entityId),
        ...loans.map((row) => row.entityId),
        ...receivables.map((row) => row.entityId),
        ...payables.map((row) => row.entityId),
        ...recurrings.map((row) => row.entityId),
      ]),
    ];
    for (const entityId of entityIds) {
      await this.access.assertCanWrite(user.userId, entityId);
    }

    // ------------------- Salvaguarda contra duplicados ---------------------
    const alreadyConfigured = await this.prisma.journalEntry.groupBy({
      by: ['entityId'],
      where: { entityId: { in: entityIds }, sourceType: 'OPENING_BALANCE' },
      _count: { _all: true },
    });
    if (alreadyConfigured.length > 0) {
      const entities = await this.prisma.financialEntity.findMany({
        where: { id: { in: alreadyConfigured.map((row) => row.entityId) } },
        select: { name: true },
      });
      throw new ConflictError(
        `Estas unidades ya tienen saldos iniciales registrados: ${entities.map((row) => row.name).join(', ')}. ` +
          'Registrarlos otra vez duplicaría el patrimonio. Para añadir o ajustar una cuenta, use la pantalla de Cuentas.',
      );
    }

    // -------------------- Nombres de cuenta repetidos ----------------------
    const existingNames = await this.prisma.financialAccount.findMany({
      where: { entityId: { in: entityIds } },
      select: { entityId: true, name: true },
    });
    const existingKeys = new Set(existingNames.map((row) => `${row.entityId}|${row.name.toLowerCase()}`));
    const claimedKeys = new Set<string>();
    for (const account of accounts) {
      const key = `${account.entityId}|${account.name.trim().toLowerCase()}`;
      if (existingKeys.has(key) || claimedKeys.has(key)) {
        throw new ValidationError(
          `Ya existe una cuenta llamada «${account.name}» en esa unidad financiera. Use otro nombre o registre el saldo desde la pantalla de Cuentas.`,
        );
      }
      claimedKeys.add(key);
    }

    // ----------------------- Cuentas contables ----------------------------
    const requiredCodes = new Set<string>([
      ...accounts.map((account) => ACCOUNT_TYPE_LEDGER[account.type] ?? LEDGER.CASH),
      LEDGER.OPENING_BALANCE,
      LEDGER.LOAN_PAYABLE,
      LEDGER.LOAN_GIVEN,
      LEDGER.RECEIVABLE,
      LEDGER.PAYABLE,
      LEDGER.CREDIT_CARD,
    ]);
    const ledgerAccounts = await this.prisma.ledgerAccount.findMany({
      where: { code: { in: [...requiredCodes] } },
      select: { id: true, code: true, name: true, normalBalance: true },
    });
    const ledgerByCode = new Map(ledgerAccounts.map((row) => [row.code, row]));
    const requireLedger = (code: string) => {
      const found = ledgerByCode.get(code);
      if (!found) {
        throw new ValidationError(`El catálogo contable no tiene la cuenta ${code}. Ejecute la semilla (npm run db:seed).`);
      }
      return found;
    };

    // ------------------------- Cálculo por unidad -------------------------
    const perEntity: Array<{
      entityId: string;
      debits: ReturnType<typeof dec>;
      credits: ReturnType<typeof dec>;
      cash: ReturnType<typeof dec>;
      debts: ReturnType<typeof dec>;
      equity: ReturnType<typeof dec>;
      accounts: number;
      journalEntryId: string;
      entrySequence: number;
    }> = [];

    const result = await this.prisma.inMoneyTransaction(async (tx) => {
      const createdAccounts: Array<{ id: string; entityId: string; name: string }> = [];
      let entries = 0;

      for (const entityId of entityIds) {
        const entityAccounts = accounts.filter((row) => row.entityId === entityId);
        const entityLoans = loans.filter((row) => row.entityId === entityId);
        const entityReceivables = receivables.filter((row) => row.entityId === entityId);
        const entityPayables = payables.filter((row) => row.entityId === entityId);

        const lines: JournalLineInput[] = [];
        let cash = dec(0);
        let debts = dec(0);
        /** Dinero que le deben a la unidad (activo, pero no es efectivo disponible). */
        let receivablesTotal = dec(0);
        /** Dinero que la unidad prestó y sigue pendiente de cobro. */
        let loansGiven = dec(0);

        // 1. Cuentas de dinero (activo) y tarjetas de crédito (pasivo).
        for (const account of entityAccounts) {
          const ledgerCode = ACCOUNT_TYPE_LEDGER[account.type] ?? LEDGER.CASH;
          const ledger = requireLedger(ledgerCode);
          const balance = validateMoney(account.openingBalance, {
            field: `saldo de «${account.name}»`,
            allowZero: true,
          });

          const created = await tx.financialAccount.create({
            data: {
              entityId,
              name: account.name.trim(),
              type: account.type,
              ledgerAccountId: ledger.id,
              // IMPORTANTE: el saldo inicial se registra como ASIENTO (línea de
              // abajo), no en esta columna. El saldo de una cuenta se calcula
              // como `openingBalance + movimientos del libro mayor`: si se
              // rellenaran las dos cosas, el dinero declarado contaría DOS VECES
              // (50.000 se verían como 100.000). Una sola fuente de verdad: el libro.
              openingBalance: dec(0),
              openingDate: businessDate,
              isCreditCard: account.type === 'CREDIT_CARD',
              notes:
                account.notes ??
                `Saldo declarado en la conciliación inicial: ${balance.toFixed(2)} (registrado como asiento de apertura)`,
            },
            select: { id: true, entityId: true, name: true },
          });
          createdAccounts.push(created);

          if (!balance.isZero()) {
            const isLiability = ledger.normalBalance === 'CREDIT';
            lines.push({
              ledgerCode,
              financialAccountId: created.id,
              ...(isLiability ? { credit: balance } : { debit: balance }),
              memo: `${isLiability ? 'Deuda' : 'Saldo'} inicial de ${account.name.trim()}`,
            });
            if (isLiability) {
              debts = round2(debts.plus(balance));
            } else {
              cash = round2(cash.plus(balance));
            }
          }
        }

        // 2. Préstamos y deudas ya existentes: su contrapartida es el patrimonio
        //    de apertura, porque el dinero (o el bien) ya se recibió antes de
        //    empezar a usar la aplicación. Nunca ingreso del período.
        for (const loan of entityLoans) {
          const principal = validateMoney(loan.principalAmount, { field: `capital de «${loan.name}»` });
          const isDebt = loan.direction === 'PAYABLE';
          lines.push({
            ledgerCode: isDebt ? LEDGER.LOAN_PAYABLE : LEDGER.LOAN_GIVEN,
            ...(isDebt ? { credit: principal } : { debit: principal }),
            memo: `${isDebt ? 'Deuda' : 'Préstamo otorgado'} inicial: ${loan.name.trim()}`,
          });
          if (isDebt) {
            debts = round2(debts.plus(principal));
          } else {
            loansGiven = round2(loansGiven.plus(principal));
          }

          await tx.loan.create({
            data: {
              entityId,
              direction: loan.direction,
              name: loan.name.trim(),
              principalAmount: principal,
              currentBalance: principal,
              annualRatePct: loan.annualRatePct ? dec(loan.annualRatePct) : null,
              interestType: loan.interestType ?? (loan.annualRatePct ? 'SIMPLE' : 'NONE'),
              paymentFrequency: loan.paymentFrequency ?? 'MONTHLY',
              installmentAmount: loan.installmentAmount ? dec(loan.installmentAmount) : null,
              installmentCount: loan.installmentCount ?? null,
              startDate: loan.startDate ? toBusinessDate(loan.startDate) : businessDate,
              firstDueDate: loan.nextDueDate ? toBusinessDate(loan.nextDueDate) : null,
              nextDueDate: loan.nextDueDate ? toBusinessDate(loan.nextDueDate) : null,
              status: 'ACTIVE',
              notes: loan.notes ?? 'Registrado en la conciliación inicial',
            },
          });
        }

        // 3. Le deben dinero: es un activo, no un ingreso.
        for (const receivable of entityReceivables) {
          const amount = validateMoney(receivable.originalAmount, { field: 'importe por cobrar' });
          lines.push({
            ledgerCode: LEDGER.RECEIVABLE,
            debit: amount,
            memo: `Por cobrar: ${receivable.description.trim()}`,
          });
          receivablesTotal = round2(receivablesTotal.plus(amount));
          await tx.receivable.create({
            data: {
              entityId,
              description: receivable.description.trim(),
              originalAmount: amount,
              settledAmount: dec(0),
              issueDate: receivable.issueDate ? toBusinessDate(receivable.issueDate) : businessDate,
              dueDate: receivable.dueDate ? toBusinessDate(receivable.dueDate) : null,
              status: 'PENDING',
              notes: receivable.notes ?? null,
            },
          });
        }

        // 4. Debe dinero: es un pasivo, no un gasto.
        for (const payable of entityPayables) {
          const amount = validateMoney(payable.originalAmount, { field: 'importe por pagar' });
          lines.push({
            ledgerCode: LEDGER.PAYABLE,
            credit: amount,
            memo: `Por pagar: ${payable.description.trim()}`,
          });
          debts = round2(debts.plus(amount));
          await tx.payable.create({
            data: {
              entityId,
              description: payable.description.trim(),
              originalAmount: amount,
              settledAmount: dec(0),
              issueDate: payable.issueDate ? toBusinessDate(payable.issueDate) : businessDate,
              dueDate: payable.dueDate ? toBusinessDate(payable.dueDate) : null,
              status: 'PENDING',
              notes: payable.notes ?? null,
            },
          });
        }

        // 5. Compromisos recurrentes (no generan asiento: son una plantilla de
        //    aviso; el asiento se crea al registrar cada pago).
        for (const recurring of recurrings.filter((row) => row.entityId === entityId)) {
          const amount = validateMoney(recurring.amount, { field: `importe de «${recurring.name}»` });
          await tx.recurringObligation.create({
            data: {
              entityId,
              name: recurring.name.trim(),
              direction: recurring.direction ?? 'PAYABLE',
              amount,
              frequency: recurring.frequency,
              nextDueDate: toBusinessDate(recurring.nextDueDate),
              categoryId: recurring.categoryId ?? null,
              remindDaysBefore: recurring.remindDaysBefore ?? 3,
              status: 'ACTIVE',
              notes: recurring.notes ?? null,
            },
          });
        }

        if (lines.length === 0) {
          continue;
        }

        // 6. Cierre del asiento de apertura: la diferencia va al patrimonio.
        const debits = sum(lines.map((line) => line.debit ?? 0));
        const credits = sum(lines.map((line) => line.credit ?? 0));
        const difference = round2(debits.minus(credits));
        if (difference.isNegative()) {
          lines.push({
            ledgerCode: LEDGER.OPENING_BALANCE,
            debit: difference.abs(),
            memo: 'Patrimonio de apertura',
          });
        } else if (difference.greaterThan(0)) {
          lines.push({
            ledgerCode: LEDGER.OPENING_BALANCE,
            credit: difference,
            memo: 'Patrimonio de apertura',
          });
        }

        const entry = await postEntry(tx, {
          entityId,
          businessDate,
          description: `Conciliación inicial al ${businessDateToIso(businessDate)}`,
          sourceType: 'OPENING_BALANCE',
          lines,
          createdByUserId: user.userId,
        });
        entries += 1;

        const totalDebits = sum(lines.map((line) => line.debit ?? 0));
        const totalCredits = sum(lines.map((line) => line.credit ?? 0));

        // Patrimonio neto declarado = activos − pasivos.
        // El efectivo declarado NO es beneficio, y las deudas NO son dinero
        // disponible: por eso se muestran por separado y nunca sumados.
        const equity = round2(cash.plus(receivablesTotal).plus(loansGiven).minus(debts));

        perEntity.push({
          entityId,
          debits: totalDebits,
          credits: totalCredits,
          cash,
          debts,
          equity,
          accounts: entityAccounts.length,
          journalEntryId: entry.id,
          entrySequence: entry.sequence,
        });
      }

      await this.audit.record(
        {
          userId: user.userId,
          action: 'setup.organize_money',
          entityType: 'FinancialEntity',
          entityId: entityIds[0],
          after: {
            asOfDate: businessDateToIso(businessDate),
            entities: entityIds.length,
            accounts: createdAccounts.length,
            loans: loans.length,
            receivables: receivables.length,
            payables: payables.length,
            recurrings: recurrings.length,
            entries,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { createdAccounts, entries };
    });

    const entities = await this.prisma.financialEntity.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, name: true, code: true },
    });
    const nameById = new Map(entities.map((row) => [row.id, row.name]));

    const totalDebits = sum(perEntity.map((row) => row.debits));
    const totalCredits = sum(perEntity.map((row) => row.credits));

    return {
      asOfDate: businessDateToIso(businessDate),
      accountsCreated: result.createdAccounts.length,
      loansCreated: loans.length,
      receivablesCreated: receivables.length,
      payablesCreated: payables.length,
      recurringsCreated: recurrings.length,
      entriesPosted: result.entries,
      perEntity: perEntity.map((row) => ({
        entityId: row.entityId,
        entityName: nameById.get(row.entityId) ?? null,
        accounts: row.accounts,
        cash: row.cash.toFixed(2),
        debts: row.debts.toFixed(2),
        equity: row.equity.toFixed(2),
        debits: row.debits.toFixed(2),
        credits: row.credits.toFixed(2),
        journalEntryId: row.journalEntryId,
        entrySequence: row.entrySequence,
      })),
      totals: {
        debits: totalDebits.toFixed(2),
        credits: totalCredits.toFixed(2),
      },
      message:
        'Situación inicial registrada. Los saldos se han contabilizado como patrimonio de apertura: ' +
        'no aparecen como ingresos del mes, y las deudas no cuentan como dinero disponible.',
    };
  }

  /** Comprueba si una unidad puede usar el asistente (no tiene apertura previa). */
  async canRunFor(entityId: string): Promise<boolean> {
    const existing = await this.prisma.journalEntry.count({
      where: { entityId, sourceType: 'OPENING_BALANCE' },
    });
    return existing === 0;
  }
}

export type SetupTransaction = Prisma.TransactionClient;
