import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/http.decorators.js';
import type { RequestMetaInfo } from '../common/request-meta.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../security/access.service.js';
import { LEDGER } from '../domain/chart-of-accounts.js';
import { toBusinessDate } from '../domain/business-date.js';
import { dec, round2 } from '../domain/money.js';
import { accountBalance } from '../ledger/ledger-core.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import type {
  ConfirmReconciliationDto,
  DismissReconciliationDto,
  ListReconciliationQuery,
  PreviewReconciliationDto,
} from './reconciliation.dto.js';

/**
 * CONCILIACIÓN GUIADA DE CUENTAS
 * ==============================
 * La pregunta que responde: «el banco dice X y FINANZA dice Y, ¿qué hago?».
 *
 * Las cuatro reglas que no se rompen nunca:
 *
 *  1. **Mirar no cambia nada.** `preview` no escribe: compara y explica. Se puede
 *     usar todos los días sin miedo.
 *  2. **El saldo no se escribe a mano.** Si hay diferencia y se decide corregir,
 *     se crea un **asiento** (con su motivo), nunca un número puesto a dedo.
 *  3. **Nada de ingresos ni gastos inventados.** La corrección usa las cuentas de
 *     diferencia que ya existen: faltante (8010), sobrante (4920) o redondeo
 *     (8020). Y el sentido del asiento lo decide el SIGNO de la diferencia, no el
 *     usuario.
 *  4. **Se puede no ajustar.** Una diferencia puede ser un movimiento que aún no
 *     ha llegado; entonces se deja constancia (`DISMISSED`) y se espera. Finanzas
 *     reales no se fuerzan para que cuadren hoy.
 *
 * Y una regla de sentido común que evita el error más caro: **el saldo de una
 * cuenta personal no es todo del propietario**. Si en esa cuenta hay dinero de
 * una empresa (custodia), el disponible es menor. La conciliación lo dice.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly transactions: TransactionsService,
  ) {}

  /** Diferencia por debajo de medio céntimo se considera cero. */
  private static readonly TOLERANCIA = dec('0.005');

  /**
   * LAS SEIS RAZONES POR LAS QUE PUEDE HABER DIFERENCIA
   * --------------------------------------------------
   * Cinco de ellas NO se arreglan con un asiento: se arreglan corrigiendo la
   * causa (apuntando el movimiento, anulando el duplicado, corrigiendo el saldo
   * inicial…). Sólo la última —diferencia real ya revisada y autorizada— puede
   * generar un ajuste. Así una duda nunca se convierte en un gasto o un ingreso.
   */
  private static readonly CAUSAS = [
    {
      value: 'UNRECORDED_MOVEMENT',
      label: 'Falta apuntar un movimiento',
      hint: 'Está en el banco y no en FINANZA: apúntelo en Movimientos.',
      allowsAdjustment: false,
    },
    {
      value: 'PENDING_TRANSFER',
      label: 'Un traspaso que aún no ha llegado',
      hint: 'Salió de una cuenta y todavía no ha entrado en la otra: revise Traspasos.',
      allowsAdjustment: false,
    },
    {
      value: 'OPENING_BALANCE_ERROR',
      label: 'El saldo inicial estaba mal',
      hint: 'Si la cuenta no tiene movimientos, corríjalo en Cuentas y bancos.',
      allowsAdjustment: false,
    },
    {
      value: 'DUPLICATE_MOVEMENT',
      label: 'Hay un movimiento duplicado',
      hint: 'Anule el duplicado en Movimientos: no hace falta ningún ajuste.',
      allowsAdjustment: false,
    },
    {
      value: 'UNIDENTIFIED',
      label: 'Todavía no lo sé',
      hint: 'Se anota la diferencia y se espera. No se toca ningún saldo.',
      allowsAdjustment: false,
    },
    {
      value: 'AUTHORIZED_CASH_DIFFERENCE',
      label: 'Diferencia real revisada (ajuste autorizado)',
      hint: 'Sólo si ya lo comprobó y asume la diferencia. Genera un asiento y queda en la auditoría.',
      allowsAdjustment: true,
    },
  ];

  // -------------------------------------------------------------------------
  // 1. Comparar y explicar (no escribe nada)
  // -------------------------------------------------------------------------
  async preview(user: AuthenticatedUser, accountId: string, dto: PreviewReconciliationDto) {
    const cuenta = await this.cargarCuenta(user, accountId);
    const asOf = dto.asOf ? toBusinessDate(dto.asOf) : toBusinessDate();

    const saldoLibro = dec((await accountBalance(this.prisma, { financialAccountId: accountId })).balance);
    const custodia = await this.custodiaPendiente(accountId);
    const informado = round2(dto.informedBalance.replace(',', '.'));
    const diferencia = informado.minus(saldoLibro);

    const cuadra = diferencia.abs().lte(ReconciliationService.TOLERANCIA);
    /**
     * EL SIGNO DEPENDE DE LA NATURALEZA DEL SALDO
     * ------------------------------------------
     * En una cuenta de activo (banco, caja) el saldo es dinero: si el banco tiene
     * MÁS, es un sobrante. En una tarjeta el saldo es DEUDA: si el banco dice
     * MÁS, hay más deuda, que no es lo mismo que «sobra dinero». Llamarlo igual
     * sería una trampa para quien lea el aviso.
     */
    const esPasivo = cuenta.ledgerAccount.normalBalance === 'CREDIT';
    const direccion = cuadra
      ? 'MATCH'
      : esPasivo
        ? diferencia.isNegative()
          ? 'LESS_DEBT'
          : 'MORE_DEBT'
        : diferencia.isNegative()
          ? 'SHORTAGE'
          : 'OVERAGE';
    const disponible = saldoLibro.minus(custodia);

    return {
      account: {
        id: cuenta.id,
        name: cuenta.name,
        entityId: cuenta.entityId,
        entityName: cuenta.entity.name,
        currency: cuenta.currency,
        isCreditCard: cuenta.isCreditCard,
        isLiability: esPasivo,
        allowOverdraft: cuenta.allowOverdraft,
      },
      asOf,
      /** Lo que dice el libro mayor. */
      ledgerBalance: saldoLibro.toFixed(2),
      /** Lo que dice el banco (lo que ha informado el usuario). */
      informedBalance: informado.toFixed(2),
      /** Parte del saldo que es de empresas: no es del propietario. */
      custody: custodia.toFixed(2),
      /** Lo que de verdad puede usar. */
      available: disponible.toFixed(2),
      /** informado − libro. */
      difference: diferencia.toFixed(2),
      direction: direccion,
      matches: cuadra,
      /** Qué puede estar pasando, en lenguaje llano. */
      explanations: this.explicar({ cuadra, esPasivo, diferencia, custodia, saldoLibro, cuenta }),
      /**
       * Las seis razones posibles. La interfaz las ofrece como opciones; sólo la
       * última puede acabar en asiento (y el servidor lo vuelve a comprobar).
       */
      causes: ReconciliationService.CAUSAS,
      /**
       * Qué haría falta para cuadrarlo, SIN ejecutarlo. Se calcula con el signo
       * de la diferencia y la naturaleza de la cuenta; el usuario no elige el
       * sentido del asiento, sólo si lo autoriza.
       */
      proposal: cuadra ? null : this.propuesta({ diferencia, esPasivo, cuenta }),
    };
  }

  /** Asiento que cuadraría la cuenta, según su naturaleza. */
  private propuesta(input: {
    diferencia: ReturnType<typeof dec>;
    esPasivo: boolean;
    cuenta: { ledgerAccount: { code: string; name: string } };
  }) {
    const { diferencia, esPasivo } = input;
    const cuentaCode = input.cuenta.ledgerAccount.code;
    /** ¿Hay que SUBIR el saldo del libro para que coincida con el banco? */
    const sube = diferencia.gt(0);

    let debitCode: string;
    let creditCode: string;
    let ledgerName: string;

    if (!esPasivo) {
      // Activo: subir = debitar la cuenta; el sobrante va a 4920.
      //          bajar = acreditarla; el faltante va a 8010.
      debitCode = sube ? cuentaCode : LEDGER.CASH_SHORTAGE;
      creditCode = sube ? LEDGER.CASH_OVERAGE : cuentaCode;
      ledgerName = sube ? 'Sobrantes de caja' : 'Faltantes de caja';
    } else {
      // Pasivo (tarjeta): la deuda sube ACREDITANDO la cuenta. La contrapartida
      // es la cuenta de ajustes por diferencias, no un ingreso por «sobrante».
      debitCode = sube ? LEDGER.ROUNDING_ADJUSTMENT : cuentaCode;
      creditCode = sube ? cuentaCode : LEDGER.ROUNDING_ADJUSTMENT;
      ledgerName = 'Ajustes por diferencias';
    }

    const importe = diferencia.abs().toFixed(2);
    return {
      amount: importe,
      ledgerCode: debitCode === cuentaCode ? creditCode : debitCode,
      ledgerName,
      debitCode,
      creditCode,
      summary: esPasivo
        ? sube
          ? `La deuda de la tarjeta subirá ${importe} hasta coincidir con el banco, y esa diferencia se reconocerá como gasto por diferencias.`
          : `La deuda de la tarjeta bajará ${importe} hasta coincidir con el banco, y esa diferencia reducirá el gasto por diferencias.`
        : sube
          ? `Se reconocerá un sobrante de ${importe}. El saldo de la cuenta subirá hasta coincidir con el banco.`
          : `Se dará por perdido ${importe} como faltante. El saldo de la cuenta bajará hasta coincidir con el banco.`,
      /** Aviso honesto: esto SÍ mueve el resultado. */
      affectsResult: true,
      /** Sólo se puede solicitar con la causa «diferencia real autorizada». */
      requiresAuthorizedCause: true,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Confirmar: aquí sí se puede generar el asiento
  // -------------------------------------------------------------------------
  async confirm(user: AuthenticatedUser, accountId: string, dto: ConfirmReconciliationDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, (await this.cargarCuenta(user, accountId)).entityId);

    const vista = await this.preview(user, accountId, { informedBalance: dto.informedBalance, asOf: dto.asOf });

    // Si cuadra, no se toca nada: sólo se deja constancia de que se miró.
    if (vista.matches) {
      const fila = await this.prisma.accountReconciliation.create({
        data: {
          accountId,
          asOf: vista.asOf,
          informedBalance: dec(vista.informedBalance),
          ledgerBalance: dec(vista.ledgerBalance),
          custody: dec(vista.custody),
          difference: dec(0),
          status: 'CONFIRMED',
          cause: dto.cause ?? null,
          causeDetail: dto.notes ?? null,
          notes: dto.notes ?? null,
          confirmedAt: new Date(),
        },
      });

      await this.audit.record({
        userId: user.userId,
        action: 'account.reconciled',
        entityType: 'FinancialAccount',
        entityId: accountId,
        after: { asOf: vista.asOf, informedBalance: vista.informedBalance, balanced: true },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      return { reconciliation: this.present(fila), adjusted: false, message: 'La cuenta cuadra: no hacía falta ajustar nada.' };
    }

    const propuesta = vista.proposal!;

    /**
     * AQUÍ EMPIEZA LA PARTE QUE NO SE PUEDE SALTAR
     * -------------------------------------------
     * Una diferencia NO se convierte en gasto o ingreso por el hecho de existir.
     * Hay que decir POR QUÉ existe, y sólo la causa «diferencia real revisada y
     * autorizada» puede generar asiento. Las otras cinco se corrigen donde
     * corresponde (apuntar el movimiento, anular el duplicado…) o se anotan.
     *
     * La comprobación está aquí, en el servidor: no depende de que la interfaz
     * esconda o no un botón.
     */
    const causa = dto.cause;
    if (!causa) {
      throw new ValidationError(
        'Diga por qué existe la diferencia. Según la causa, se corrige el origen o se anota sin tocar el saldo.',
      );
    }
    if (causa !== 'AUTHORIZED_CASH_DIFFERENCE' || dto.authorized !== true) {
      const guia = ReconciliationService.CAUSAS.find((fila) => fila.value === causa);
      throw new ValidationError(
        `${guia?.hint ?? 'Esta diferencia no se ajusta con un asiento.'} Si sólo quiere dejar constancia, guarde la revisión SIN ajustar: no se tocará ningún saldo.`,
      );
    }

    // Aquí SÍ se va a contabilizar: el motivo deja de ser opcional.
    const motivo = (dto.reason ?? '').trim();
    if (motivo.length < 10) {
      throw new ValidationError(
        'Explique la causa de la diferencia (mínimo 10 caracteres): va a generar un asiento y queda en la auditoría',
      );
    }

    // El asiento de ajuste se crea con el servicio de movimientos: así obtiene
    // idempotencia, auditoría, asiento cuadrado y anulación por reverso.
    const movimiento = await this.transactions.create(
      user,
      {
        entityId: vista.account.entityId,
        kind: 'ADJUSTMENT',
        accountId,
        amount: propuesta.amount,
        businessDate: vista.asOf.toISOString().slice(0, 10),
        description: `Conciliación con el banco: ${propuesta.ledgerName.toLowerCase()}`,
        adjustmentDebitCode: propuesta.debitCode,
        adjustmentCreditCode: propuesta.creditCode,
        adjustmentReason: motivo,
      },
      meta,
    );

    const fila = await this.prisma.accountReconciliation.create({
      data: {
        accountId,
        asOf: vista.asOf,
        informedBalance: dec(vista.informedBalance),
        ledgerBalance: dec(vista.ledgerBalance),
        custody: dec(vista.custody),
        difference: dec(vista.difference),
        status: 'CONFIRMED',
        cause: causa,
        causeDetail: dto.notes ?? motivo,
        journalEntryId: movimiento.journalEntryId ?? null,
        notes: dto.notes ?? motivo,
        confirmedAt: new Date(),
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'account.reconciled',
      entityType: 'FinancialAccount',
      entityId: accountId,
      businessId: movimiento.id,
      after: {
        asOf: vista.asOf,
        informedBalance: vista.informedBalance,
        ledgerBalance: vista.ledgerBalance,
        difference: vista.difference,
        journalEntryId: movimiento.journalEntryId,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      reconciliation: this.present(fila),
      adjusted: true,
      transactionId: movimiento.id,
      message: propuesta.summary,
    };
  }

  // -------------------------------------------------------------------------
  // 3. «Lo he visto y no ajusto» (la diferencia se queda, con constancia)
  // -------------------------------------------------------------------------
  async dismiss(user: AuthenticatedUser, accountId: string, dto: DismissReconciliationDto, meta: RequestMetaInfo) {
    await this.access.assertCanWrite(user.userId, (await this.cargarCuenta(user, accountId)).entityId);
    const vista = await this.preview(user, accountId, { informedBalance: dto.informedBalance, asOf: dto.asOf });

    const fila = await this.prisma.accountReconciliation.create({
      data: {
        accountId,
        asOf: vista.asOf,
        informedBalance: dec(vista.informedBalance),
        ledgerBalance: dec(vista.ledgerBalance),
        custody: dec(vista.custody),
        difference: dec(vista.difference),
        status: 'DISMISSED',
        cause: dto.cause ?? 'UNIDENTIFIED',
        causeDetail: dto.notes.trim(),
        notes: dto.notes.trim(),
      },
    });

    await this.audit.record({
      userId: user.userId,
      action: 'account.reconciliation_dismissed',
      entityType: 'FinancialAccount',
      entityId: accountId,
      after: { asOf: vista.asOf, difference: vista.difference, cause: dto.cause ?? 'UNIDENTIFIED', notes: dto.notes.trim() },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const guia = ReconciliationService.CAUSAS.find((fila) => fila.value === (dto.cause ?? 'UNIDENTIFIED'));
    return {
      reconciliation: this.present(fila),
      message: `Guardado sin tocar ningún saldo. ${guia?.hint ?? ''} `.trim(),
    };
  }

  // -------------------------------------------------------------------------
  // 4. Historial
  // -------------------------------------------------------------------------
  async history(user: AuthenticatedUser, accountId: string, query: ListReconciliationQuery) {
    const cuenta = await this.cargarCuenta(user, accountId);
    const limit = Math.min(100, query.limit ?? 20);

    const filas = await this.prisma.accountReconciliation.findMany({
      where: { accountId, status: query.status ? (query.status as 'DRAFT' | 'CONFIRMED' | 'DISMISSED') : undefined },
      orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    return {
      account: { id: cuenta.id, name: cuenta.name },
      data: filas.map((fila) => this.present(fila)),
    };
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async cargarCuenta(user: AuthenticatedUser, accountId: string) {
    const cuenta = await this.prisma.financialAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        entityId: true,
        currency: true,
        status: true,
        isCreditCard: true,
        allowOverdraft: true,
        ledgerAccount: { select: { code: true, name: true, normalBalance: true } },
        entity: { select: { id: true, name: true } },
      },
    });
    if (!cuenta) {
      throw new NotFoundError('Cuenta financiera', accountId);
    }
    await this.access.assertCanRead(user.userId, cuenta.entityId);
    if (cuenta.status === 'CLOSED') {
      throw new ConflictError('La cuenta está cerrada: no se concilia una cuenta cerrada');
    }
    return cuenta;
  }

  /** Dinero de empresas que sigue en esta cuenta (no es del propietario). */
  private async custodiaPendiente(accountId: string) {
    const fondos = await this.prisma.custodyFund.findMany({
      where: { holdingAccountId: accountId, status: { in: ['OPEN', 'PARTIAL'] } },
      select: { originalAmount: true, appliedAmount: true },
    });
    return fondos.reduce((total, fondo) => total.plus(round2(fondo.originalAmount).minus(round2(fondo.appliedAmount))), dec(0));
  }

  private explicar(input: {
    cuadra: boolean;
    esPasivo: boolean;
    diferencia: ReturnType<typeof dec>;
    custodia: ReturnType<typeof dec>;
    saldoLibro: ReturnType<typeof dec>;
    cuenta: { name: string; isCreditCard: boolean };
  }): string[] {
    const lineas: string[] = [];

    if (input.cuadra) {
      lineas.push('El banco y FINANZA coinciden: no hay nada que ajustar.');
    } else if (input.esPasivo) {
      // Tarjeta: el saldo es DEUDA. Decir «sobra dinero» sería mentir.
      lineas.push(
        input.diferencia.isNegative()
          ? `La deuda de la tarjeta es ${input.diferencia.abs().toFixed(2)} MENOR que la registrada en FINANZA: puede faltar apuntar un pago que ya hiciste, o un consumo que se apuntó dos veces.`
          : `La deuda de la tarjeta es ${input.diferencia.abs().toFixed(2)} MAYOR que la registrada: suele faltar apuntar un consumo.`,
      );
    } else if (input.diferencia.isNegative()) {
      lineas.push(
        `En el banco hay ${input.diferencia.abs().toFixed(2)} MENOS de lo que dice FINANZA.`,
        'Suele ser una comisión o un cargo que aún no se ha apuntado, un cobro que no llegó, o un retiro hecho y no registrado.',
      );
    } else {
      lineas.push(
        `En el banco hay ${input.diferencia.abs().toFixed(2)} MÁS de lo que dice FINANZA.`,
        'Suele ser un ingreso todavía sin apuntar, o un gasto que se apuntó y no llegó a salir.',
      );
    }

    if (input.custodia.gt(0)) {
      lineas.push(
        `Atención: en esta cuenta hay ${input.custodia.toFixed(2)} que son de una empresa (fondos en custodia). Ese dinero no es suyo, así que su disponible real es ${input.saldoLibro.minus(input.custodia).toFixed(2)}.`,
      );
    }

    if (input.saldoLibro.isNegative()) {
      lineas.push(
        'El saldo del libro ya era negativo antes de conciliar. Eso suele ser una diferencia antigua sin revisar: si la causa no está clara, no la ajuste hoy.',
      );
    }

    if (input.cuenta.isCreditCard) {
      lineas.push('En una tarjeta, el saldo es la DEUDA: si el banco informa más deuda que la registrada, falta un consumo por apuntar.');
    }

    lineas.push('Si no está seguro, no ajuste: puede dejar la diferencia anotada y esperar al movimiento que falta.');
    return lineas;
  }

  private present(fila: {
    id: string;
    asOf: Date;
    informedBalance: unknown;
    ledgerBalance: unknown;
    custody: unknown;
    difference: unknown;
    status: string;
    cause?: string | null;
    causeDetail?: string | null;
    journalEntryId: string | null;
    notes: string | null;
    createdAt: Date;
    confirmedAt: Date | null;
  }) {
    const diferencia = round2(fila.difference as never);
    return {
      id: fila.id,
      asOf: fila.asOf,
      informedBalance: round2(fila.informedBalance as never).toFixed(2),
      ledgerBalance: round2(fila.ledgerBalance as never).toFixed(2),
      custody: round2(fila.custody as never).toFixed(2),
      difference: diferencia.toFixed(2),
      status: fila.status,
      cause: fila.cause ?? null,
      causeDetail: fila.causeDetail ?? null,
      journalEntryId: fila.journalEntryId,
      notes: fila.notes,
      createdAt: fila.createdAt,
      confirmedAt: fila.confirmedAt,
      /** Sin asiento no se movió ni un céntimo. */
      changedBalances: fila.journalEntryId !== null,
    };
  }
}
