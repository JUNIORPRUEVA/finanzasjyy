-- ============================================================================
-- FINANZA — Endurecimiento de la protección del cierre diario
-- ----------------------------------------------------------------------------
-- Detectado al implementar el asistente de cierre:
--   Un cierre con diferencias explicadas queda en estado WITH_DIFFERENCES y
--   YA TIENE `closedAt` (es un cierre cerrado), pero el trigger original sólo
--   protegía el estado FINALIZED. Eso permitía reescribir un cierre cerrado
--   con diferencias sin pasar por REOPENED.
--
-- Esta migración reemplaza la función para que ambos estados sean inmutables.
-- ============================================================================

CREATE OR REPLACE FUNCTION finanza_protect_closing() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_is_closed boolean;
BEGIN
    -- Un cierre está CERRADO si tiene fecha de cierre o está en un estado final.
    v_is_closed := OLD."closedAt" IS NOT NULL
                   OR OLD."status"::text IN ('FINALIZED', 'WITH_DIFFERENCES');

    IF TG_OP = 'DELETE' THEN
        IF v_is_closed THEN
            RAISE EXCEPTION
                'Prohibido borrar el cierre cerrado del % (unidad %). Use reapertura auditada.',
                OLD."businessDate", OLD."entityId"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF v_is_closed THEN
        IF NEW."status" <> 'REOPENED' THEN
            RAISE EXCEPTION
                'Prohibido modificar el cierre cerrado del % (unidad %). Debe pasar primero a REOPENED con motivo registrado.',
                OLD."businessDate", OLD."entityId"
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW."lastReopenReason" IS NULL OR length(btrim(NEW."lastReopenReason")) = 0 THEN
            RAISE EXCEPTION
                'La reapertura del cierre % exige un motivo registrado.',
                OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;

        NEW."reopenCount"    := OLD."reopenCount" + 1;
        NEW."lastReopenedAt" := now();
        NEW."version"        := OLD."version" + 1;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trazabilidad de las diferencias de caja
-- ---------------------------------------------------------------------------
-- Una diferencia registrada en el cierre no puede quedar sin explicación si el
-- cierre está cerrado: se comprueba al cerrar, pero además se impide borrar la
-- fila de conciliación de un cierre cerrado.
CREATE OR REPLACE FUNCTION finanza_protect_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_closing_id uuid;
    v_closed     boolean;
BEGIN
    v_closing_id := COALESCE(OLD."closingId", NEW."closingId");

    SELECT ("closedAt" IS NOT NULL OR "status"::text IN ('FINALIZED', 'WITH_DIFFERENCES'))
      INTO v_closed
      FROM "DailyClosing"
     WHERE "id" = v_closing_id;

    IF v_closed IS TRUE AND TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Prohibido borrar la conciliación de un cierre ya cerrado (%). Reabra el cierre con un motivo.',
            v_closing_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS "trg_reconciliation_protect" ON "ClosingReconciliation";

CREATE TRIGGER "trg_reconciliation_protect"
    BEFORE DELETE ON "ClosingReconciliation"
    FOR EACH ROW
    EXECUTE FUNCTION finanza_protect_reconciliation();

-- Índice para localizar rápido las diferencias históricas de caja.
CREATE INDEX IF NOT EXISTS idx_reconciliation_difference
    ON "ClosingReconciliation" ("closingId", "differenceAmount")
    WHERE "differenceAmount" <> 0;
