-- ============================================================================
-- FINANZA — Corrección de tipos en los triggers de integridad
-- ----------------------------------------------------------------------------
-- BUG DETECTADO POR LA PRUEBA DE INTEGRACIÓN (e2e), no por el typecheck:
--
--   ERROR: operator does not exist: text = uuid
--
-- Prisma mapea `String` a la columna `text` (no a `uuid`), pero las funciones
-- de trigger declaraban sus variables como `uuid`:
--     v_entry_id uuid := NEW."entryId";   -- "entryId" es text
--     WHERE "entryId" = v_entry_id        -- text = uuid  → error
--
-- Consecuencia: TODA operación financiera fallaba con 500 al confirmar la
-- transacción, porque el constraint trigger diferido del cuadre se ejecutaba al
-- hacer COMMIT. Es justo el tipo de fallo que no se ve hasta que se ejecuta el
-- sistema de verdad contra la base de datos.
--
-- Corrección: las variables pasan a ser `text`, que es el tipo real de las
-- claves. Se recrean las funciones afectadas con CREATE OR REPLACE, por lo que
-- esta migración es idempotente y no toca ningún dato.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cuadre de la partida doble (diferido al commit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finanza_assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_entry_id     text;
    v_total_debit  numeric(18, 2);
    v_total_credit numeric(18, 2);
    v_line_count   integer;
BEGIN
    v_entry_id := COALESCE(NEW."entryId", OLD."entryId");

    SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*)
      INTO v_total_debit, v_total_credit, v_line_count
      FROM "JournalLine"
     WHERE "entryId" = v_entry_id;

    IF v_line_count < 2 THEN
        RAISE EXCEPTION
            'Asiento contable invalido: el asiento % tiene % linea(s); se exigen al menos 2 (partida doble).',
            v_entry_id, v_line_count
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_total_debit <> v_total_credit THEN
        RAISE EXCEPTION
            'Asiento contable descuadrado: asiento % debe=% haber=% (diferencia %).',
            v_entry_id, v_total_debit, v_total_credit, (v_total_debit - v_total_credit)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Protección de las conciliaciones del cierre
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finanza_protect_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_closing_id text;
    v_closed     boolean;
BEGIN
    v_closing_id := COALESCE(OLD."closingId", NEW."closingId");

    SELECT ("closedAt" IS NOT NULL OR "status"::text IN ('FINALIZED', 'WITH_DIFFERENCES'))
      INTO v_closed
      FROM "DailyClosing"
     WHERE "id" = v_closing_id;

    IF v_closed IS TRUE AND TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Prohibido borrar la conciliacion de un cierre ya cerrado (%). Reabra el cierre con un motivo.',
            v_closing_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Comprobación: ninguna función de FINANZA debe comparar text con uuid
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_bad integer;
BEGIN
    SELECT COUNT(*)
      INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'finanza_%'
       AND pg_get_functiondef(p.oid) ILIKE '%uuid%';

    IF v_bad > 0 THEN
        RAISE WARNING 'Hay % función(es) de FINANZA que todavía mencionan uuid: revísense.', v_bad;
    END IF;
END;
$$;
