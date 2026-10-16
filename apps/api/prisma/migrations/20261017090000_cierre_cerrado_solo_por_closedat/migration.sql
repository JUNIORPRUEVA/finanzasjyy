-- ============================================================================
-- FINANZA — Un cierre está cerrado si y sólo si tiene `closedAt` (corrección FINAL)
-- ----------------------------------------------------------------------------
-- DEFECTO ENCONTRADO AL CREAR UNA BASE DE DATOS DESDE CERO
--
-- Las carpetas de migraciones se aplican en orden alfabético (por marca de
-- tiempo). El orden real aplicado es:
--
--   20261016180854_init
--   20261016181500_integridad_contable
--   20261016182649_sync_server_id_payload_hash
--   20261016183537_transfer_asiento_compartido
--   20261016184500_cierre_cerrado_por_closedat   <-- la CORRECCIÓN
--   20261016193000_cierre_protegido              <-- reintroduce el defecto
--   20261016200000_fix_triggers_text_uuid        <-- conserva el defecto
--
-- La migración de la corrección tiene una marca de tiempo ANTERIOR a la versión
-- endurecida del trigger, así que una base de datos creada desde cero acababa
-- con la comprobación antigua:
--
--     v_is_closed := OLD."closedAt" IS NOT NULL
--                    OR OLD."status" IN ('FINALIZED', 'WITH_DIFFERENCES');
--
-- Con esa comprobación, guardar el conteo de un cierre que ya tenía diferencias
-- registradas fallaba con «Prohibido modificar el cierre cerrado», es decir, el
-- asistente no podía explicar la diferencia y volver a guardar para finalizar.
-- El defecto NO aparecía en las bases de datos que se habían corregido a mano
-- durante la sesión de depuración; apareció al reconstruir la base desde el
-- historial de migraciones. Lo detectó la prueba de extremo a extremo del
-- cierre diario.
--
-- Esta migración es la última y deja el estado correcto en cualquier entorno.
-- No se editan las migraciones anteriores a propósito: cambiar una migración ya
-- aplicada altera su suma de comprobación y PostgreSQL/Prisma lo rechazan.
--
-- Regla final: un cierre está cerrado ⇔ `closedAt` no es nulo. El estado
-- (WITH_DIFFERENCES, REOPENED, FINALIZED...) es información para el usuario.
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

-- Los disparadores ya existen desde la migración de integridad contable; se
-- vuelven a enlazar a la función corregida (operación idempotente).
DROP TRIGGER IF EXISTS trg_protect_closing ON "DailyClosing";
CREATE TRIGGER trg_protect_closing
    BEFORE UPDATE OR DELETE ON "DailyClosing"
    FOR EACH ROW EXECUTE FUNCTION finanza_protect_closing();

DROP TRIGGER IF EXISTS trg_protect_reconciliation ON "ClosingReconciliation";
CREATE TRIGGER trg_protect_reconciliation
    BEFORE UPDATE OR DELETE ON "ClosingReconciliation"
    FOR EACH ROW EXECUTE FUNCTION finanza_protect_reconciliation();

-- Comprobación de seguridad: la base de datos debe quedar con la regla correcta.
-- Si quedara la versión antigua, esta migración falla y se vería de inmediato en
-- lugar de descubrirse en producción.
DO $$
DECLARE
    v_source text;
BEGIN
    SELECT prosrc INTO v_source FROM pg_proc WHERE proname = 'finanza_protect_closing';

    IF v_source LIKE '%WITH_DIFFERENCES%' THEN
        RAISE EXCEPTION
            'La función finanza_protect_closing sigue considerando WITH_DIFFERENCES como cerrado. Un cierre no se puede considerar cerrado por su estado, solo por closedAt.';
    END IF;

    IF v_source NOT LIKE '%OLD."closedAt" IS NOT NULL%' THEN
        RAISE EXCEPTION
            'La función finanza_protect_closing no comprueba closedAt: revisión manual necesaria.';
    END IF;
END;
$$;
