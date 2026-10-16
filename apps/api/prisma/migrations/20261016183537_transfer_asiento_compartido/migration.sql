-- DropIndex
DROP INDEX "FinancialTransaction_journalEntryId_key";

-- CreateIndex
CREATE INDEX "FinancialTransaction_journalEntryId_idx" ON "FinancialTransaction"("journalEntryId");
