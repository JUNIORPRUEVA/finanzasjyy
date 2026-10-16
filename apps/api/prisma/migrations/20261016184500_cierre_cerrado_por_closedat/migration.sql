-- ============================================================================
-- FINANZA — El cierre se considera "cerrado" por `closedAt`, no por el estado
-- ----------------------------------------------------------------------------
-- BUG DETECTADO POR LA PRUEBA DE INTEGRACIÓN (e2e):
--
--   El estado WITH_DIFFERENCES se usa para DOS cosas distintas:
--     a) "conteo guardado con diferencias, AÚN NO finalizado"  (closedAt IS NULL)
--     b) "finalizado con diferencias explicadas"               (closedAt NOT NULL)
--
--   La versión endurecida del trigger daba por cerrado cualquier cierre en
--   estado WITH_DIFFERENCES, así que el asistente no podía volver a guardar el
--   conteo (con la diferencia ya explicada) para luego finalizarlo: respondía
--   422 "Prohibido modificar el cierre cerrado".
--
-- Corrección: la ÚNICA señal de que un cierre está cerrado es `closedAt`
-- (fecha de cierre), que es exactamente la que usa el servicio al decidir si se
-- puede reabrir. El estado queda como información para el usuario.
-- ============================================================================

CREATE OR REPLACE FUNCTION finanza_protect_closing() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_is_closed boolean;
BEGIN
    v_is_closed := OLD."closedAt" IS NOT NULL;

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

CREATE OR REPLACE FUNCTION finanza_protect_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_closing_id text;
    v_closed     boolean;
BEGIN
    v_closing_id := COALESCE(OLD."closingId", NEW."closingId");

    SELECT ("closedAt" IS NOT NULL)
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
