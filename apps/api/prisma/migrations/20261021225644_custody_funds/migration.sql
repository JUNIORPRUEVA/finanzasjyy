-- CreateEnum
CREATE TYPE "CustodyFundStatus" AS ENUM ('OPEN', 'PARTIAL', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CustodyMovementType" AS ENUM ('SETTLEMENT', 'EXPENSE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TxnKind" ADD VALUE 'CUSTODY_IN';
ALTER TYPE "TxnKind" ADD VALUE 'CUSTODY_OUT';
ALTER TYPE "TxnKind" ADD VALUE 'CUSTODY_SETTLEMENT';

-- CreateTable
CREATE TABLE "CustodyFund" (
    "id" TEXT NOT NULL,
    "beneficiaryEntityId" TEXT NOT NULL,
    "holdingAccountId" TEXT NOT NULL,
    "sourceTransactionId" TEXT NOT NULL,
    "originalAmount" DECIMAL(18,2) NOT NULL,
    "appliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "CustodyFundStatus" NOT NULL DEFAULT 'OPEN',
    "businessDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustodyFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyMovement" (
    "id" TEXT NOT NULL,
    "beneficiaryEntityId" TEXT NOT NULL,
    "holdingAccountId" TEXT NOT NULL,
    "targetAccountId" TEXT,
    "expenseTransactionId" TEXT,
    "type" "CustodyMovementType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "businessDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "clientOperationId" TEXT NOT NULL,
    "status" "TxnStatus" NOT NULL DEFAULT 'POSTED',
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "holdingEntryId" TEXT,
    "beneficiaryEntryId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustodyMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustodyAllocation" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustodyAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustodyFund_sourceTransactionId_key" ON "CustodyFund"("sourceTransactionId");

-- CreateIndex
CREATE INDEX "CustodyFund_beneficiaryEntityId_holdingAccountId_status_idx" ON "CustodyFund"("beneficiaryEntityId", "holdingAccountId", "status");

-- CreateIndex
CREATE INDEX "CustodyFund_beneficiaryEntityId_businessDate_idx" ON "CustodyFund"("beneficiaryEntityId", "businessDate");

-- CreateIndex
CREATE INDEX "CustodyFund_holdingAccountId_status_idx" ON "CustodyFund"("holdingAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyMovement_expenseTransactionId_key" ON "CustodyMovement"("expenseTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyMovement_clientOperationId_key" ON "CustodyMovement"("clientOperationId");

-- CreateIndex
CREATE INDEX "CustodyMovement_beneficiaryEntityId_businessDate_idx" ON "CustodyMovement"("beneficiaryEntityId", "businessDate");

-- CreateIndex
CREATE INDEX "CustodyMovement_holdingAccountId_businessDate_idx" ON "CustodyMovement"("holdingAccountId", "businessDate");

-- CreateIndex
CREATE INDEX "CustodyMovement_status_idx" ON "CustodyMovement"("status");

-- CreateIndex
CREATE INDEX "CustodyAllocation_fundId_idx" ON "CustodyAllocation"("fundId");

-- CreateIndex
CREATE UNIQUE INDEX "CustodyAllocation_movementId_fundId_key" ON "CustodyAllocation"("movementId", "fundId");

-- AddForeignKey
ALTER TABLE "CustodyFund" ADD CONSTRAINT "CustodyFund_beneficiaryEntityId_fkey" FOREIGN KEY ("beneficiaryEntityId") REFERENCES "FinancialEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyFund" ADD CONSTRAINT "CustodyFund_holdingAccountId_fkey" FOREIGN KEY ("holdingAccountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyFund" ADD CONSTRAINT "CustodyFund_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "FinancialTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyFund" ADD CONSTRAINT "CustodyFund_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyMovement" ADD CONSTRAINT "CustodyMovement_beneficiaryEntityId_fkey" FOREIGN KEY ("beneficiaryEntityId") REFERENCES "FinancialEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyMovement" ADD CONSTRAINT "CustodyMovement_holdingAccountId_fkey" FOREIGN KEY ("holdingAccountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyMovement" ADD CONSTRAINT "CustodyMovement_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "FinancialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyMovement" ADD CONSTRAINT "CustodyMovement_expenseTransactionId_fkey" FOREIGN KEY ("expenseTransactionId") REFERENCES "FinancialTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyMovement" ADD CONSTRAINT "CustodyMovement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyAllocation" ADD CONSTRAINT "CustodyAllocation_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "CustodyMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyAllocation" ADD CONSTRAINT "CustodyAllocation_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "CustodyFund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
