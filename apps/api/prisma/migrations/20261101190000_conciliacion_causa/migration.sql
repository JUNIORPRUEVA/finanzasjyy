-- ============================================================================
-- CAUSA DE LA DIFERENCIA EN UNA CONCILIACIÓN
-- ============================================================================
-- Antes, cualquier diferencia podía acabar en un asiento de faltante (8010) o
-- sobrante (4920). Eso convertía una duda en un gasto o un ingreso definitivo.
--
-- Ahora hay que decir POR QUÉ existe la diferencia, y sólo la causa
-- «diferencia real revisada y autorizada» puede generar asiento. Las demás
-- (movimiento sin apuntar, traspaso pendiente, saldo inicial erróneo, movimiento
-- duplicado) llevan a corregir la causa, no a inventar un ajuste. Y «no lo sé»
-- se anota sin tocar ningún saldo.
--
-- No altera ningún dato existente: las conciliaciones antiguas quedan con
-- `cause = NULL` (se ven como revisadas sin causa).
-- ============================================================================

CREATE TYPE "ReconciliationCause" AS ENUM (
  'UNRECORDED_MOVEMENT',
  'PENDING_TRANSFER',
  'OPENING_BALANCE_ERROR',
  'DUPLICATE_MOVEMENT',
  'UNIDENTIFIED',
  'AUTHORIZED_CASH_DIFFERENCE'
);

ALTER TABLE "AccountReconciliation" ADD COLUMN "cause" "ReconciliationCause";
ALTER TABLE "AccountReconciliation" ADD COLUMN "causeDetail" TEXT;
