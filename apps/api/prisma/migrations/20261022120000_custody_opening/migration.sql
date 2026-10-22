-- Apertura de fondos en custodia
-- ------------------------------
-- Marca el dinero de una empresa que YA estaba depositado en una cuenta personal
-- antes de empezar a usar FINANZA. Es ADITIVO: sólo añade un valor al enumerado
-- de tipos de movimiento. No crea, altera ni borra ninguna tabla ni ningún dato,
-- así que no puede afectar a los movimientos históricos ya registrados.
--
-- Se escribe idempotente a propósito (las migraciones no son transaccionales en
-- PostgreSQL y esta carpeta se puede llegar a aplicar sobre una base restaurada).

ALTER TYPE "TxnKind" ADD VALUE IF NOT EXISTS 'CUSTODY_OPENING';
