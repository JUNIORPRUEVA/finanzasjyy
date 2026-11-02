-- ============================================================================
-- ESTRUCTURA JURÍDICA + REEMBOLSOS AL PROPIETARIO
-- ============================================================================
-- Qué hace esta migración y por qué:
--
--  1. Añade la PERSONA JURÍDICA como tabla (`LegalEntity`) y no como una cadena
--     de texto: así una unidad no puede apuntar a una sociedad inexistente ni
--     pertenecer a dos sociedades por un error de escritura.
--  2. Añade `parentEntityId` para la relación COMERCIAL (APPYRA es una marca de
--     FULLTECH), que es un vínculo distinto del jurídico.
--  3. Crea los dos modelos de reembolso («pagué algo del negocio con mi dinero»
--     y su devolución).
--  4. Añade la política de descubierto por cuenta (Fase 5), con el valor por
--     defecto en `true` para NO cambiar el comportamiento actual.
--
-- NO toca ningún asiento, movimiento, saldo ni fecha. Las dos columnas nuevas de
-- `FinancialEntity` son NULL-ables: hasta que se rellenen, cada unidad se
-- considera de naturaleza jurídica desconocida y el sistema no adivina.
-- ============================================================================

-- CreateEnum
CREATE TYPE "LegalEntityKind" AS ENUM ('COMPANY', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "ReimbursementStatus" AS ENUM ('OPEN', 'PARTIAL', 'SETTLED', 'VOIDED');

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LegalEntityKind" NOT NULL DEFAULT 'COMPANY',
    "taxId" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalEntity_code_key" ON "LegalEntity"("code");
CREATE INDEX "LegalEntity_kind_idx" ON "LegalEntity"("kind");

-- AlterTable
ALTER TABLE "FinancialEntity" ADD COLUMN "legalEntityId" TEXT,
ADD COLUMN "parentEntityId" TEXT;

-- CreateIndex
CREATE INDEX "FinancialEntity_legalEntityId_idx" ON "FinancialEntity"("legalEntityId");
CREATE INDEX "FinancialEntity_parentEntityId_idx" ON "FinancialEntity"("parentEntityId");

-- AddForeignKey
ALTER TABLE "FinancialEntity" ADD CONSTRAINT "FinancialEntity_legalEntityId_fkey"
  FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEntity" ADD CONSTRAINT "FinancialEntity_parentEntityId_fkey"
  FOREIGN KEY ("parentEntityId") REFERENCES "FinancialEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterEnum (TxnKind)
ALTER TYPE "TxnKind" ADD VALUE 'OWNER_PAID_COMPANY_EXPENSE';
ALTER TYPE "TxnKind" ADD VALUE 'OWNER_REIMBURSEMENT_PAYMENT';

-- AlterTable
ALTER TABLE "FinancialAccount" ADD COLUMN "allowOverdraft" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "OwnerReimbursement" (
    "id" TEXT NOT NULL,
    "companyEntityId" TEXT NOT NULL,
    "ownerEntityId" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "categoryId" TEXT,
    "description" TEXT NOT NULL,
    "originalAmount" DECIMAL(18,2) NOT NULL,
    "settledAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'DOP',
    "businessDate" DATE NOT NULL,
    "status" "ReimbursementStatus" NOT NULL DEFAULT 'OPEN',
    "companyEntryId" TEXT NOT NULL,
    "ownerEntryId" TEXT NOT NULL,
    "clientOperationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerReimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerReimbursement_clientOperationId_key" ON "OwnerReimbursement"("clientOperationId");
CREATE INDEX "OwnerReimbursement_companyEntityId_status_idx" ON "OwnerReimbursement"("companyEntityId", "status");
CREATE INDEX "OwnerReimbursement_ownerEntityId_status_idx" ON "OwnerReimbursement"("ownerEntityId", "status");

-- CreateTable
CREATE TABLE "OwnerReimbursementPayment" (
    "id" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "companyAccountId" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "businessDate" DATE NOT NULL,
    "companyEntryId" TEXT NOT NULL,
    "ownerEntryId" TEXT NOT NULL,
    "clientOperationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerReimbursementPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerReimbursementPayment_clientOperationId_key" ON "OwnerReimbursementPayment"("clientOperationId");
CREATE INDEX "OwnerReimbursementPayment_reimbursementId_businessDate_idx" ON "OwnerReimbursementPayment"("reimbursementId", "businessDate");

-- AddForeignKey
ALTER TABLE "OwnerReimbursement" ADD CONSTRAINT "OwnerReimbursement_companyEntityId_fkey"
  FOREIGN KEY ("companyEntityId") REFERENCES "FinancialEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerReimbursement" ADD CONSTRAINT "OwnerReimbursement_ownerEntityId_fkey"
  FOREIGN KEY ("ownerEntityId") REFERENCES "FinancialEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerReimbursement" ADD CONSTRAINT "OwnerReimbursement_ownerAccountId_fkey"
  FOREIGN KEY ("ownerAccountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerReimbursement" ADD CONSTRAINT "OwnerReimbursement_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "TransactionCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerReimbursementPayment" ADD CONSTRAINT "OwnerReimbursementPayment_reimbursementId_fkey"
  FOREIGN KEY ("reimbursementId") REFERENCES "OwnerReimbursement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerReimbursementPayment" ADD CONSTRAINT "OwnerReimbursementPayment_companyAccountId_fkey"
  FOREIGN KEY ("companyAccountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerReimbursementPayment" ADD CONSTRAINT "OwnerReimbursementPayment_ownerAccountId_fkey"
  FOREIGN KEY ("ownerAccountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- DATOS CONFIRMADOS POR EL PROPIETARIO
-- ============================================================================
-- Sólo se rellenan las relaciones que el propietario confirmó expresamente.
-- PHYTOEMAGRY se queda con `legalEntityId = NULL` a propósito: su relación
-- jurídica está pendiente y el sistema debe preguntar, no suponer.
--
-- Todo va con guardas: si una unidad no existe (base nueva, entorno de pruebas),
-- no pasa nada y no se crea basura.
DO $$
DECLARE
  v_srl    TEXT;
  v_persona TEXT;
  v_fulltech TEXT;
  v_appyra   TEXT;
  v_personal TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM "FinancialEntity" WHERE "code" = 'FULLTECH_PRINCIPAL') THEN
    INSERT INTO "LegalEntity" ("id", "code", "name", "kind", "notes", "updatedAt")
    VALUES (gen_random_uuid()::text, 'FULLTECH_SRL', 'FULLTECH S.R.L.', 'COMPANY',
            'Sociedad de responsabilidad limitada formalmente constituida.', CURRENT_TIMESTAMP)
    ON CONFLICT ("code") DO NOTHING
    RETURNING "id" INTO v_srl;

    IF v_srl IS NULL THEN
      SELECT "id" INTO v_srl FROM "LegalEntity" WHERE "code" = 'FULLTECH_SRL';
    END IF;

    SELECT "id" INTO v_fulltech FROM "FinancialEntity" WHERE "code" = 'FULLTECH_PRINCIPAL';
    UPDATE "FinancialEntity"
       SET "legalEntityId" = v_srl, "parentEntityId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = v_fulltech AND "legalEntityId" IS NULL;

    -- APPYRA es una MARCA de FULLTECH: misma persona jurídica y colgando de la
    -- unidad principal. Nunca se trata como una sociedad distinta.
    SELECT "id" INTO v_appyra FROM "FinancialEntity" WHERE "code" = 'APPYRA_SISTEMAS';
    IF v_appyra IS NOT NULL THEN
      UPDATE "FinancialEntity"
         SET "legalEntityId" = v_srl, "parentEntityId" = v_fulltech, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = v_appyra AND "legalEntityId" IS NULL;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "FinancialEntity" WHERE "code" = 'PERSONAL') THEN
    INSERT INTO "LegalEntity" ("id", "code", "name", "kind", "notes", "updatedAt")
    VALUES (gen_random_uuid()::text, 'PROPIETARIO', 'El propietario (persona física)', 'INDIVIDUAL',
            'Finanzas personales del propietario. Sujeto jurídico distinto de la SRL.', CURRENT_TIMESTAMP)
    ON CONFLICT ("code") DO NOTHING
    RETURNING "id" INTO v_persona;

    IF v_persona IS NULL THEN
      SELECT "id" INTO v_persona FROM "LegalEntity" WHERE "code" = 'PROPIETARIO';
    END IF;

    SELECT "id" INTO v_personal FROM "FinancialEntity" WHERE "code" = 'PERSONAL';
    IF v_personal IS NOT NULL THEN
      UPDATE "FinancialEntity"
         SET "legalEntityId" = v_persona, "parentEntityId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = v_personal AND "legalEntityId" IS NULL;
    END IF;
  END IF;
END $$;
