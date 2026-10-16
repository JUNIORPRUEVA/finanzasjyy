-- DropIndex
DROP INDEX "idx_closing_entity_status";

-- DropIndex
DROP INDEX "idx_transaction_entity_date_kind_status";

-- DropIndex
DROP INDEX "idx_journal_line_entry_account";

-- AlterTable
ALTER TABLE "SyncOperation" ADD COLUMN     "payloadHash" TEXT,
ADD COLUMN     "serverId" TEXT;
