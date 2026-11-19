-- ============================================================================
-- CATÁLOGO DE PRODUCTOS DE COMPRA
-- ============================================================================
-- Sale de lo que ya se compró: de una factura leída con IA o de un producto
-- marcado con su precio. Guarda, por unidad financiera y por producto:
--   · el último precio por unidad y cuándo se vio,
--   · el mínimo y el máximo pagados,
--   · cuántas veces se ha comprado.
--
-- No es un documento financiero: no mueve dinero ni genera asientos. Su utilidad
-- es autocompletar el precio y poder comparar cómo cambia lo que se paga.
--
-- Aditiva e idempotente: no toca ninguna tabla existente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ProductCatalogEntry" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "entityId"       TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "unit"           TEXT,
  "lastUnitPrice"  DECIMAL(18, 2),
  "minUnitPrice"   DECIMAL(18, 2),
  "maxUnitPrice"   DECIMAL(18, 2),
  "lastQuantity"   DECIMAL(18, 3),
  "lastSupplier"   TEXT,
  "timesPurchased" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductCatalogEntry_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "FinancialEntity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductCatalogEntry_entityId_normalizedName_key"
  ON "ProductCatalogEntry"("entityId", "normalizedName");

CREATE INDEX IF NOT EXISTS "ProductCatalogEntry_entityId_lastSeenAt_idx"
  ON "ProductCatalogEntry"("entityId", "lastSeenAt");
