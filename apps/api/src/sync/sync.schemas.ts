import { z } from 'zod';

/**
 * ESQUEMAS DE SINCRONIZACIÓN (zod)
 * --------------------------------
 * Las operaciones que llegan desde un dispositivo offline son POLIMÓRFICAS, así
 * que se validan con zod (unión discriminada) en lugar de class-validator.
 * Todo error se traduce a un mensaje en español con la ruta exacta del problema,
 * porque el usuario final tiene que entender qué falló y por qué.
 */

const moneyString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'El importe debe ser texto decimal con máximo 2 decimales, por ejemplo "1250.75"');

const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato YYYY-MM-DD')
  .optional();

const uuid = z.string().min(8).max(64);

export const syncTransactionSchema = z.object({
  type: z.literal('TRANSACTION'),
  payload: z.object({
    entityId: uuid,
    kind: z.enum([
      'INCOME',
      'EXPENSE',
      'OWNER_WITHDRAWAL',
      'OWNER_CONTRIBUTION',
      'LOAN_DISBURSEMENT',
      'CREDIT_CARD_PAYMENT',
      'RECEIVABLE_SETTLEMENT',
      'PAYABLE_SETTLEMENT',
      'ADJUSTMENT',
    ]),
    accountId: uuid,
    categoryId: uuid.nullish(),
    counterpartyId: uuid.nullish(),
    amount: moneyString,
    businessDate,
    description: z.string().min(2).max(300),
    reference: z.string().max(80).optional(),
    method: z.string().max(40).optional(),
    receivableId: uuid.optional(),
    payableId: uuid.optional(),
    loanId: uuid.optional(),
    adjustmentDebitCode: z.string().regex(/^\d{4}$/).optional(),
    adjustmentCreditCode: z.string().regex(/^\d{4}$/).optional(),
    adjustmentReason: z.string().max(500).optional(),
  }),
});

export const syncTransferSchema = z.object({
  type: z.literal('TRANSFER'),
  payload: z.object({
    fromAccountId: uuid,
    toAccountId: uuid,
    amount: moneyString,
    businessDate,
    description: z.string().min(2).max(300),
  }),
});

export const syncClosingSchema = z.object({
  type: z.literal('CLOSING_SAVE'),
  payload: z.object({
    entityId: uuid,
    businessDate,
    counts: z
      .array(
        z.object({
          accountId: uuid,
          countedAmount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'El efectivo contado debe ser texto decimal'),
          explanation: z.string().max(500).optional(),
        }),
      )
      .min(1, 'Debe enviar al menos una cuenta contada'),
    confirmedSteps: z.array(z.string()).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const syncLoanPaymentSchema = z.object({
  type: z.literal('LOAN_PAYMENT'),
  payload: z.object({
    loanId: uuid,
    accountId: uuid,
    totalAmount: moneyString,
    businessDate,
    principalAmount: moneyString.optional(),
    interestAmount: moneyString.optional(),
    feeAmount: moneyString.optional(),
    penaltyAmount: moneyString.optional(),
    notes: z.string().max(300).optional(),
  }),
});

export const syncOperationSchema = z.discriminatedUnion('type', [
  syncTransactionSchema,
  syncTransferSchema,
  syncClosingSchema,
  syncLoanPaymentSchema,
]);

export type SyncOperationInput = z.infer<typeof syncOperationSchema>;
export type SyncOperationType = SyncOperationInput['type'];

export const syncPushSchema = z.object({
  deviceId: z.string().min(4).max(120),
  platform: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
  /** Hora del dispositivo al registrar la operación (detección de reloj alterado). */
  clientRecordedAt: z.string().datetime().optional(),
  operations: z
    .array(
      z.object({
        clientOperationId: z.string().min(8).max(120),
        clientRecordedAt: z.string().datetime().optional(),
        operation: syncOperationSchema,
      }),
    )
    .min(1, 'No hay operaciones que sincronizar')
    .max(200, 'Máximo 200 operaciones por lote: divida el envío en varios lotes'),
});

export type SyncPushInput = z.infer<typeof syncPushSchema>;

/** Convierte un error de zod en un mensaje legible en español. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'operación';
      return `${path}: ${issue.message}`;
    })
    .join(' | ');
}
