-- ============================================================================
-- TIPO DE MOVIMIENTO PARA EL LADO DEL PROPIETARIO EN UN REEMBOLSO
-- ============================================================================
-- «Pagué algo del negocio con mi dinero» genera DOS movimientos:
--   · en la empresa      → OWNER_PAID_COMPANY_EXPENSE  (es el gasto)
--   · en el propietario  → OWNER_ADVANCE_TO_COMPANY    (es un adelanto, no gasto)
--
-- Antes los dos llevaban el mismo tipo, y un informe de gastos CONSOLIDADO podía
-- contar la misma operación dos veces (una por unidad). Con tipos distintos eso
-- deja de ser posible.
--
-- No toca ningún dato: sólo añade un valor al enum.
-- ============================================================================

ALTER TYPE "TxnKind" ADD VALUE 'OWNER_ADVANCE_TO_COMPANY';
