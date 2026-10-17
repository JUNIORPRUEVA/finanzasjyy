-- CreateEnum
CREATE TYPE "ShoppingListStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ShoppingList" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ShoppingListStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'DOP',
    "notes" TEXT,
    "plannedDate" DATE,
    "completedAt" TIMESTAMP(3),
    "estimatedTotal" DECIMAL(18,2),
    "actualTotal" DECIMAL(18,2),
    "transactionId" TEXT,
    "journalEntryId" TEXT,
    "clientOperationId" TEXT,
    "deviceListId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingListItem" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "unit" TEXT,
    "estimatedUnitPrice" DECIMAL(18,2),
    "actualUnitPrice" DECIMAL(18,2),
    "isPurchased" BOOLEAN NOT NULL DEFAULT false,
    "purchasedAt" TIMESTAMP(3),
    "categoryId" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingList_transactionId_key" ON "ShoppingList"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingList_clientOperationId_key" ON "ShoppingList"("clientOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingList_deviceListId_key" ON "ShoppingList"("deviceListId");

-- CreateIndex
CREATE INDEX "ShoppingList_entityId_status_idx" ON "ShoppingList"("entityId", "status");

-- CreateIndex
CREATE INDEX "ShoppingList_createdByUserId_createdAt_idx" ON "ShoppingList"("createdByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ShoppingListItem_listId_isPurchased_idx" ON "ShoppingListItem"("listId", "isPurchased");

-- AddForeignKey
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "FinancialEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "FinancialTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingListItem" ADD CONSTRAINT "ShoppingListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
