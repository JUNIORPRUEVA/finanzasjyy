-- ============================================================================
-- CONCILIACIÓN DE CUENTAS
-- ============================================================================
-- Guarda «el banco dice X, el libro dice Y» y, si se decide corregir, el asiento
-- que lo corrigió. NO se escribe ningún saldo a mano y NO se toca ningún
-- movimiento histórico: la corrección es siempre un asiento nuevo y auditable.
--
-- Esta tabla es sólo de lectura/registro: no altera asientos existentes.
-- ============================================================================

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AccountReconciliation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "informedBalance" DECIMAL(18,2) NOT NULL,
    "ledgerBalance" DECIMAL(18,2) NOT NULL,
    "custody" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "difference" DECIMAL(18,2) NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'DRAFT',
    "journalEntryId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "AccountReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountReconciliation_accountId_asOf_idx" ON "AccountReconciliation"("accountId", "asOf");
CREATE INDEX "AccountReconciliation_status_idx" ON "AccountReconciliation"("status");

-- AddForeignKey
ALTER TABLE "AccountReconciliation" ADD CONSTRAINT "AccountReconciliation_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
