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
import { dec, validateMoney, type DecimalInput } from '../domain/money.js';
import { classifyTransfer } from '../domain/legal-structure.js';
import { ownerFundsPostings, type OwnerFundsNature } from '../domain/owner-funds-rules.js';
import { postEntry, type Tx } from '../ledger/ledger-core.js';
import { hashToken, stableStringify } from '../auth/tokens.js';
import type { CreateTransferDto, ListTransfersQuery } from './transfers.dto.js';

/**
 * TRANSFERENCIAS ENTRE CUENTAS
 * ----------------------------
 * Es una sola operación ATÓMICA: o salen y entran los dos movimientos, o no
 * pasa nada. Dos casos:
 *
 *  A) MISMA unidad financiera (banco → caja del mismo negocio)
 *     Un asiento: se carga la cuenta destino y se abona la de origen.
 *
 *  B) UNIDADES DISTINTAS (banco Fulltech → caja Phytoemagry, o negocio → bolsillo)
 *     Dos asientos que usan la CUENTA PUENTE 1150 (intercompañía):
 *       · En el origen: se carga 1150 y se abona el banco de origen.
 *       · En el destino: se carga la caja destino y se abona 1150.
 *     Así, al consolidar todas las unidades, la cuenta 1150 queda en CERO y
 *     la transferencia NUNCA aparece como ingreso ni infla el resultado.
 *
 * Una transferencia no genera ingreso ni gasto: sólo mueve dinero de sitio.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthenticatedUser, input: CreateTransferDto, meta: RequestMetaInfo) {
    if (input.fromAccountId === input.toAccountId) {
      throw new ValidationError('La cuenta de origen y la de destino deben ser distintas');
    }

    if (input.clientOperationId) {
      const existing = await this.prisma.transfer.findUnique({
        where: { clientOperationId: input.clientOperationId },
        include: { fromAccount: { select: { name: true } }, toAccount: { select: { name: true } } },
      });
      if (existing) {
        return this.present(existing, true);
      }
    }

    const [from, to] = await Promise.all([
      this.loadAccount(input.fromAccountId, 'origen'),
      this.loadAccount(input.toAccountId, 'destino'),
    ]);

    await this.access.assertCanWrite(user.userId, from.entityId);
    await this.access.assertCanWrite(user.userId, to.entityId);

    if (from.status === 'CLOSED' || to.status === 'CLOSED') {
      throw new ConflictError('No se puede transferir desde o hacia una cuenta cerrada');
    }
    if (from.currency !== to.currency) {
      throw new ValidationError(
        `No se pueden transferir montos entre monedas distintas (${from.currency} → ${to.currency}) sin un tipo de cambio explícito. Registre el cambio como dos operaciones.`,
      );
    }
    if (from.ledgerAccount.code === to.ledgerAccount.code && from.entityId === to.entityId) {
      throw new ValidationError('Las dos cuentas usan la misma cuenta contable: el movimiento no tendría efecto');
    }

    /**
     * FRONTERA JURÍDICA
     * -----------------
     * Antes de contabilizar nada se decide si este movimiento cruza o no entre
     * personas jurídicas distintas (ver `domain/legal-structure.ts`). No se
     * decide comparando identificadores de unidad: se decide con la persona
     * jurídica de cada una, que es un dato validado.
     *
     *   · Misma unidad               → un asiento (nada que clasificar).
     *   · Misma persona jurídica     → dos asientos con la cuenta puente 1150,
     *                                  que es interna y queda en cero al
     *                                  consolidar esa sociedad.
     *   · Personas distintas         → se RECHAZA: mover dinero entre FULLTECH y
     *                                  el propietario es retirada, retribución,
     *                                  reembolso o préstamo, y hay que
     *                                  clasificarlo antes de contabilizarlo.
     *   · Relación sin confirmar     → se RECHAZA y se pide confirmarla.
     */
    const classification = classifyTransfer(from.entity, to.entity);

    /**
     * «DINERO PARA MÍ»
     * ---------------
     * Sacar dinero de una empresa hacia una cuenta personal es justo el caso
     * que NO se puede contabilizar sin saber qué es. Antes se rechazaba sin más
     * y el usuario se quedaba sin forma de reflejar el dinero; ahora, si dice
     * qué es (`nature`), se contabiliza con su asiento correcto en cada unidad
     * (ver `domain/owner-funds-rules.ts`). Si no lo dice, se sigue rechazando.
     */
    let ownerFunds: OwnerFundsNature | null = null;
    if (input.nature) {
      if (classification.relation !== 'DIFFERENT_LEGAL_ENTITY') {
        throw new ValidationError(
          classification.relation === 'SAME_LEGAL_ENTITY'
            ? 'Estas dos unidades son de la misma persona jurídica: es un traslado interno, no «dinero para mí».'
            : classification.reason,
        );
      }
      if (from.entity.type === 'PERSONAL') {
        throw new ValidationError(
          'El dinero para usted se saca de una empresa, no de sus finanzas personales.',
        );
      }
      if (to.entity.type !== 'PERSONAL') {
        throw new ValidationError('La cuenta que recibe el dinero tiene que ser de sus finanzas personales.');
      }
      if (input.nature === 'LOAN' && !input.documentRef?.trim()) {
        throw new ValidationError(
          'Un préstamo de la empresa al propietario tiene que estar documentado: indique la referencia del contrato.',
        );
      }
      ownerFunds = input.nature;
    } else if (!classification.allowed) {
      throw new ValidationError(classification.reason);
    }

    const amount = validateMoney(input.amount, { field: 'importe de la transferencia' });
    const businessDate = toBusinessDate(input.businessDate);
    const isCrossEntity = from.entityId !== to.entityId;
    /**
     * La referencia del préstamo se guarda en la descripción además de en la
     * auditoría: es el documento que sostiene la deuda, y tiene que poder
     * encontrarlo quien mire el movimiento.
     */
    const descripcion =
      ownerFunds && input.documentRef?.trim()
        ? `${input.description.trim()} (ref. ${input.documentRef.trim()})`
        : input.description.trim();
    const clientOperationId =
      input.clientOperationId ?? `trf_${hashToken(stableStringify({ t: Date.now(), r: Math.random() })).slice(0, 40)}`;

    const created = await this.prisma.inMoneyTransaction(async (tx) => {
      let sourceEntryId: string;
      let targetEntryId: string;

      if (!isCrossEntity) {
        // Caso A: un único asiento dentro de la misma unidad financiera.
        const entry = await postEntry(tx, {
          entityId: from.entityId,
          businessDate,
          description: input.description.trim(),
          sourceType: 'TRANSFER',
          lines: [
            {
              ledgerCode: to.ledgerAccount.code,
              financialAccountId: to.id,
              debit: amount,
              memo: `Entrada por transferencia desde ${from.name}`,
            },
            {
              ledgerCode: from.ledgerAccount.code,
              financialAccountId: from.id,
              credit: amount,
              memo: `Salida por transferencia hacia ${to.name}`,
            },
          ],
          createdByUserId: user.userId,
        });
        sourceEntryId = entry.id;
        targetEntryId = entry.id;
      } else if (ownerFunds) {
        /**
         * «DINERO PARA MÍ»: dos asientos con la contrapartida que corresponde a
         * la naturaleza elegida, no con la cuenta puente. Aquí el dinero SÍ
         * cambia de dueño, así que el puente dejaría escondida la operación.
         */
        const postings = ownerFundsPostings({
          nature: ownerFunds,
          amount,
          sourceLedgerCode: from.ledgerAccount.code,
          sourceAccountId: from.id,
          targetLedgerCode: to.ledgerAccount.code,
          targetAccountId: to.id,
          memo:
            ownerFunds === 'WITHDRAWAL'
              ? `Dinero para el propietario: ${descripcion}`
              : `Préstamo de ${from.entityName} al propietario: ${descripcion}`,
        });

        const sourceEntry = await postEntry(tx, {
          entityId: from.entityId,
          businessDate,
          description: descripcion,
          sourceType: 'TRANSFER',
          lines: postings.source,
          createdByUserId: user.userId,
        });

        const targetEntry = await postEntry(tx, {
          entityId: to.entityId,
          businessDate,
          description: `${descripcion} (desde ${from.entityName})`,
          sourceType: 'TRANSFER',
          lines: postings.target,
          createdByUserId: user.userId,
        });

        sourceEntryId = sourceEntry.id;
        targetEntryId = targetEntry.id;
      } else {
        // Caso B: dos asientos unidos por la cuenta puente intercompañía.
        const sourceEntry = await postEntry(tx, {
          entityId: from.entityId,
          businessDate,
          description: `${input.description.trim()} (salida hacia ${to.entityName})`,
          sourceType: 'TRANSFER',
          lines: [
            {
              ledgerCode: LEDGER.INTERCOMPANY,
              debit: amount,
              memo: `Transferencia a ${to.entityName}`,
            },
            {
              ledgerCode: from.ledgerAccount.code,
              financialAccountId: from.id,
              credit: amount,
              memo: `Salida por transferencia hacia ${to.name}`,
            },
          ],
          createdByUserId: user.userId,
        });

        const targetEntry = await postEntry(tx, {
          entityId: to.entityId,
          businessDate,
          description: `${input.description.trim()} (entrada desde ${from.entityName})`,
          sourceType: 'TRANSFER',
          lines: [
            {
              ledgerCode: to.ledgerAccount.code,
              financialAccountId: to.id,
              debit: amount,
              memo: `Entrada por transferencia desde ${from.name}`,
            },
            {
              ledgerCode: LEDGER.INTERCOMPANY,
              credit: amount,
              memo: `Transferencia desde ${from.entityName}`,
            },
          ],
          createdByUserId: user.userId,
        });

        sourceEntryId = sourceEntry.id;
        targetEntryId = targetEntry.id;
      }

      const transfer = await tx.transfer.create({
        data: {
          entityId: from.entityId,
          fromAccountId: from.id,
          toAccountId: to.id,
          amount,
          currency: from.currency,
          businessDate,
          description: ownerFunds ? descripcion : input.description.trim(),
          status: 'POSTED',
          isCrossEntity,
          clientOperationId,
          createdByUserId: user.userId,
        },
      });

      await tx.financialTransaction.create({
        data: {
          entityId: from.entityId,
          // «Dinero para mí» es un retiro del propietario y así debe aparecer en
          // su informe; un préstamo no es un retiro, así que queda como salida
          // de dinero sin tocar resultados.
          kind: ownerFunds === 'WITHDRAWAL' ? 'OWNER_WITHDRAWAL' : 'TRANSFER_OUT',
          status: 'POSTED',
          accountId: from.id,
          transferId: transfer.id,
          journalEntryId: sourceEntryId,
          amount,
          currency: from.currency,
          businessDate,
          description: `${input.description.trim()} → ${to.name}`,
          clientOperationId: `${clientOperationId}:out`,
          deviceId: input.deviceId ?? meta.deviceId ?? null,
          recordedOffline: input.recordedOffline ?? false,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await tx.financialTransaction.create({
        data: {
          entityId: to.entityId,
          kind: 'TRANSFER_IN',
          status: 'POSTED',
          accountId: to.id,
          transferId: transfer.id,
          journalEntryId: targetEntryId,
          amount,
          currency: to.currency,
          businessDate,
          description: `${input.description.trim()} ← ${from.name}`,
          clientOperationId: `${clientOperationId}:in`,
          deviceId: input.deviceId ?? meta.deviceId ?? null,
          recordedOffline: input.recordedOffline ?? false,
          syncStatus: 'CONFIRMED',
          syncedAt: new Date(),
          createdByUserId: user.userId,
        },
      });

      await this.audit.record(
        {
          userId: user.userId,
          action: 'transfer.created',
          entityType: 'Transfer',
          entityId: transfer.id,
          businessId: sourceEntryId,
          after: {
            fromAccountId: from.id,
            toAccountId: to.id,
            amount: amount.toFixed(2),
            isCrossEntity,
            // Queda registrado POR QUÉ se pudo contabilizar así: no es lo mismo
            // un traslado interno de la misma sociedad que un movimiento entre
            // sociedades (que ni siquiera llega aquí).
            legalRelation: classification.relation,
            postingStrategy: classification.posting,
            ownerFundsNature: ownerFunds,
            documentRef: input.documentRef ?? null,
            sourceEntryId,
            targetEntryId,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return transfer;
    });

    const hydrated = await this.prisma.transfer.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        fromAccount: { select: { id: true, name: true, entityId: true } },
        toAccount: { select: { id: true, name: true, entityId: true } },
        entity: { select: { id: true, code: true, name: true } },
      },
    });

    return this.present(hydrated, false);
  }

  async list(user: AuthenticatedUser, query: ListTransfersQuery) {
    const entityIds = await this.access.resolveScope(user.userId, query.entityId);
    const limit = Math.min(200, query.limit ?? 50);
    const page = query.page ?? 1;

    const where: Prisma.TransferWhereInput = {
      OR: [
        { entityId: { in: entityIds } },
        { fromAccount: { entityId: { in: entityIds } } },
        { toAccount: { entityId: { in: entityIds } } },
      ],
      fromAccountId: query.accountId ? query.accountId : undefined,
      businessDate:
        query.from || query.to
          ? {
              gte: query.from ? toBusinessDate(query.from) : undefined,
              lte: query.to ? toBusinessDate(query.to) : undefined,
            }
          : undefined,
    };

    const [rows, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where,
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          fromAccount: { select: { id: true, name: true, entityId: true } },
          toAccount: { select: { id: true, name: true, entityId: true } },
          entity: { select: { id: true, code: true, name: true } },
          // Quién hizo el traspaso: también lleva firma.
          createdBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.transfer.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.present(row, false)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total },
    };
  }

  private async loadAccount(accountId: string, label: string) {
    const account = await this.prisma.financialAccount.findUnique({
      where: { id: accountId },
      include: {
        ledgerAccount: { select: { code: true, name: true } },
        entity: { select: { id: true, code: true, name: true, currency: true, type: true, legalEntityId: true } },
      },
    });
    if (!account) {
      throw new NotFoundError(`Cuenta ${label}`, accountId);
    }
    return {
      id: account.id,
      name: account.name,
      status: account.status,
      currency: account.currency,
      entityId: account.entityId,
      entityName: account.entity.name,
      entity: account.entity,
      ledgerAccount: account.ledgerAccount,
    };
  }

  private present(
    transfer: {
      id: string;
      entityId: string;
      fromAccountId: string;
      toAccountId: string;
      amount: DecimalInput;
      currency: string;
      businessDate: Date;
      description: string;
      status: string;
      isCrossEntity: boolean;
      clientOperationId: string;
      createdAt: Date;
      fromAccount?: { id?: string; name: string; entityId?: string };
      toAccount?: { id?: string; name: string; entityId?: string };
      entity?: { id: string; code: string; name: string };
    },
    duplicate: boolean,
  ) {
    return {
      id: transfer.id,
      entityId: transfer.entityId,
      entity: transfer.entity,
      fromAccountId: transfer.fromAccountId,
      toAccountId: transfer.toAccountId,
      fromAccount: transfer.fromAccount,
      toAccount: transfer.toAccount,
      amount: dec(transfer.amount).toFixed(2),
      currency: transfer.currency,
      businessDate: transfer.businessDate,
      description: transfer.description,
      status: transfer.status,
      isCrossEntity: transfer.isCrossEntity,
      clientOperationId: transfer.clientOperationId,
      createdAt: transfer.createdAt,
      /** Deja claro para el cliente que esto no es ingreso ni gasto. */
      affectsProfitAndLoss: false,
      ...(duplicate ? { duplicate: true } : {}),
    };
  }

  /**
   * Comprueba que la cuenta puente intercompañía quedó en cero.
   *
   * Se comprueba DOS veces porque responden a preguntas distintas:
   *
   *  · **Global**: ¿alguna transferencia quedó registrada a medias? (una salida
   *    sin su entrada, por ejemplo por un corte a mitad).
   *  · **Por persona jurídica**: dentro de una misma sociedad, el puente 1150 es
   *    una cuenta INTERNA y tiene que quedar en cero al consolidar. Si no queda
   *    en cero, o hay un movimiento incompleto, o hay dinero cruzando entre
   *    sociedades por un camino que no debería existir.
   *
   * Ese segundo control es justo el que faltaba: antes el puente se anulaba
   * sumando TODAS las unidades, así que un movimiento entre dos sociedades
   * distintas podía quedar escondido detrás del cero global.
   */
  async intercompanyCheck(user: AuthenticatedUser) {
    const entityIds = await this.access.listAccessibleEntityIds(user.userId);
    const lines = await this.prisma.journalLine.findMany({
      where: { ledgerAccount: { code: LEDGER.INTERCOMPANY }, entry: { entityId: { in: entityIds } } },
      select: { debit: true, credit: true, entry: { select: { entityId: true } } },
    });

    const debit = lines.reduce((acc, line) => acc.plus(line.debit), dec(0));
    const credit = lines.reduce((acc, line) => acc.plus(line.credit), dec(0));
    const balance = debit.minus(credit);

    // Saldo del puente agrupado por persona jurídica de la unidad del asiento.
    const entities = await this.prisma.financialEntity.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, code: true, name: true, legalEntityId: true, legalEntity: { select: { code: true, name: true } } },
    });
    const entityById = new Map(entities.map((entity) => [entity.id, entity]));

    const porPersona = new Map<
      string,
      { legalEntityCode: string | null; legalEntityName: string | null; debit: ReturnType<typeof dec>; credit: ReturnType<typeof dec> }
    >();
    for (const line of lines) {
      const entity = entityById.get(line.entry.entityId);
      const key = entity?.legalEntity?.code ?? '__SIN_CONFIRMAR__';
      const current =
        porPersona.get(key) ??
        {
          legalEntityCode: entity?.legalEntity?.code ?? null,
          legalEntityName: entity?.legalEntity?.name ?? null,
          debit: dec(0),
          credit: dec(0),
        };
      current.debit = current.debit.plus(line.debit);
      current.credit = current.credit.plus(line.credit);
      porPersona.set(key, current);
    }

    const byLegalEntity = [...porPersona.entries()].map(([key, value]) => {
      const saldo = value.debit.minus(value.credit);
      return {
        legalEntityCode: value.legalEntityCode,
        legalEntityName: value.legalEntityName ?? (key === '__SIN_CONFIRMAR__' ? 'Unidades sin relación confirmada' : key),
        debit: value.debit.toFixed(2),
        credit: value.credit.toFixed(2),
        balance: saldo.toFixed(2),
        balanced: saldo.isZero(),
      };
    });

    return {
      ledgerCode: LEDGER.INTERCOMPANY,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balance: balance.toFixed(2),
      balanced: balance.isZero(),
      byLegalEntity,
      balancedByLegalEntity: byLegalEntity.every((row) => row.balanced),
      explanation: balance.isZero()
        ? 'Todas las transferencias entre unidades están completas: el consolidado no infla ingresos.'
        : 'Hay transferencias entre unidades registradas a medias. Revise el detalle abajo.',
      movements: lines.length,
    };
  }

  /**
   * Vista previa de una operación entre dos cuentas SIN registrarla.
   *
   * La usa la pantalla de «Mover dinero» para avisar ANTES de que el usuario
   * rellene todo: si las dos unidades son de sociedades distintas, el traspaso
   * no se puede contabilizar y hay que decirlo desde el principio, no después de
   * pulsar «Registrar».
   */
  async previewRelation(user: AuthenticatedUser, fromAccountId: string, toAccountId: string) {
    const [from, to] = await Promise.all([
      this.loadAccount(fromAccountId, 'origen'),
      this.loadAccount(toAccountId, 'destino'),
    ]);
    await this.access.assertCanRead(user.userId, from.entityId);
    await this.access.assertCanRead(user.userId, to.entityId);

    const classification = classifyTransfer(from.entity, to.entity);
    return {
      relation: classification.relation,
      allowed: classification.allowed,
      posting: classification.posting,
      code: classification.code,
      reason: classification.reason,
      fromEntity: { id: from.entityId, name: from.entityName },
      toEntity: { id: to.entityId, name: to.entityName },
    };
  }
}
