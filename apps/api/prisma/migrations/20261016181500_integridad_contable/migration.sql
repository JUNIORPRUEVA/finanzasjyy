-- ============================================================================
-- FINANZA — Capa de integridad contable a nivel de base de datos
-- ----------------------------------------------------------------------------
-- Esta migración NO la genera Prisma: se escribió a mano porque Prisma no
-- expresa triggers ni constraint triggers diferidos.
--
-- IMPORTANTE: Prisma nombra las tablas y columnas en PascalCase/camelCase
-- ("JournalLine"."entryId"), por eso TODOS los identificadores van entre
-- comillas dobles.
--
-- Garantías que añade:
--   G1. Todo asiento cuadra: SUM(debit) = SUM(credit) y tiene >= 2 líneas.
--       Con CONSTRAINT TRIGGER DIFERIDO, así las líneas se insertan en
--       cualquier orden dentro de la misma transacción.
--   G2. Los asientos POSTED y sus líneas son INMUTABLES: la corrección es un
--       ASIENTO DE REVERSO, nunca un UPDATE.
--   G3. Los movimientos financieros confirmados no se borran ni se reescriben.
--   G4. Un cierre FINALIZADO sólo puede pasar a REOPENED con motivo registrado.
--   G5. Invariantes de importes y de documentos asociados.
--
-- Escape administrativo: los triggers son ROW-LEVEL, así que TRUNCATE no los
-- dispara. Los tests y la restauración de backups usan TRUNCATE explícito.
-- La aplicación nunca borra registros financieros.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- G1. Cuadre de la partida doble (diferido al commit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finanza_assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_entry_id     uuid;
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

DROP TRIGGER IF EXISTS "trg_journal_line_balanced" ON "JournalLine";

CREATE CONSTRAINT TRIGGER "trg_journal_line_balanced"
    AFTER INSERT OR UPDATE ON "JournalLine"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION finanza_assert_entry_balanced();

-- ---------------------------------------------------------------------------
-- G2. Inmutabilidad del libro mayor
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finanza_forbid_posted_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" = 'POSTED' THEN
            RAISE EXCEPTION
                'Prohibido borrar el asiento contable POSTED %. Se corrige con un asiento de reverso.',
                OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."status" = 'POSTED' THEN
        -- Única transición permitida: POSTED -> REVERSED (el reverso es otro asiento).
        IF NEW."status" = 'REVERSED' THEN
            RETURN NEW;
        END IF;
        IF NEW."entityId"     IS DISTINCT FROM OLD."entityId"
           OR NEW."businessDate" IS DISTINCT FROM OLD."businessDate"
           OR NEW."sourceType"   IS DISTINCT FROM OLD."sourceType"
           OR NEW."sourceId"     IS DISTINCT FROM OLD."sourceId"
        THEN
            RAISE EXCEPTION
                'Prohibido modificar un asiento contable POSTED (%). Use un asiento de reverso.',
                OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_journal_entry_immutable" ON "JournalEntry";

CREATE TRIGGER "trg_journal_entry_immutable"
    BEFORE UPDATE OR DELETE ON "JournalEntry"
    FOR EACH ROW
    EXECUTE FUNCTION finanza_forbid_posted_entry_mutation();

CREATE OR REPLACE FUNCTION finanza_forbid_line_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'Prohibido % una linea de asiento (%). Las lineas del libro mayor son inmutables; registre un reverso.',
        TG_OP, COALESCE(OLD."id", NEW."id")
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS "trg_journal_line_immutable" ON "JournalLine";

CREATE TRIGGER "trg_journal_line_immutable"
    BEFORE UPDATE OR DELETE ON "JournalLine"
    FOR EACH ROW
    EXECUTE FUNCTION finanza_forbid_line_mutation();

-- ---------------------------------------------------------------------------
-- G3. Movimientos financieros confirmados: no se borran ni se reescriben
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finanza_protect_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" = 'POSTED' THEN
            RAISE EXCEPTION
                'Prohibido borrar el movimiento financiero POSTED %. Anulelo con un movimiento de anulacion.',
                OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."status" = 'POSTED' THEN
        IF NEW."amount"          IS DISTINCT FROM OLD."amount"
           OR NEW."kind"            IS DISTINCT FROM OLD."kind"
           OR NEW."accountId"       IS DISTINCT FROM OLD."accountId"
           OR NEW."businessDate"    IS DISTINCT FROM OLD."businessDate"
           OR NEW."entityId"        IS DISTINCT FROM OLD."entityId"
           OR NEW."counterpartyId"  IS DISTINCT FROM OLD."counterpartyId"
        THEN
            -- Sólo se admite el paso a VOIDED (anulación).
            IF NEW."status" <> 'VOIDED' THEN
                RAISE EXCEPTION
                    'Prohibido reescribir un movimiento financiero POSTED (%). Use anulacion o ajuste con trazabilidad.',
                    OLD."id"
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_transaction_protect" ON "FinancialTransaction";

CREATE TRIGGER "trg_transaction_protect"
    BEFORE UPDATE OR DELETE ON "FinancialTransaction"
    FOR EACH ROW
    EXECUTE FUNCTION finanza_protect_transaction();

CREATE OR REPLACE FUNCTION finanza_forbid_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'Prohibido borrar el registro financiero % de la tabla %. Registre una anulacion o un ajuste auditado.',
        OLD."id", TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS "trg_transfer_no_delete" ON "Transfer";

CREATE TRIGGER "trg_transfer_no_delete"
    BEFORE DELETE ON "Transfer"
    FOR EACH ROW EXECUTE FUNCTION finanza_forbid_hard_delete();

DROP TRIGGER IF EXISTS "trg_loan_payment_no_delete" ON "LoanPayment";

CREATE TRIGGER "trg_loan_payment_no_delete"
    BEFORE DELETE ON "LoanPayment"
    FOR EACH ROW EXECUTE FUNCTION finanza_forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- G4. Cierres diarios: la historia no se reescribe
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finanza_protect_closing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" = 'FINALIZED' THEN
            RAISE EXCEPTION
                'Prohibido borrar el cierre FINALIZADO del % (unidad %). Use reapertura auditada.',
                OLD."businessDate", OLD."entityId"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."status" = 'FINALIZED' THEN
        IF NEW."status" <> 'REOPENED' THEN
            RAISE EXCEPTION
                'Prohibido modificar el cierre FINALIZADO del % (unidad %). Debe pasar primero a REOPENED con motivo registrado.',
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

DROP TRIGGER IF EXISTS "trg_closing_protect" ON "DailyClosing";

CREATE TRIGGER "trg_closing_protect"
    BEFORE UPDATE OR DELETE ON "DailyClosing"
    FOR EACH ROW
    EXECUTE FUNCTION finanza_protect_closing();

-- ---------------------------------------------------------------------------
-- G5. Invariantes de importes y de documentos asociados
-- ---------------------------------------------------------------------------

-- Una línea es deudora O acreedora, nunca ambas, nunca ninguna.
ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS chk_journal_line_amounts;

ALTER TABLE "JournalLine"
    ADD CONSTRAINT chk_journal_line_amounts
    CHECK (
        "debit" >= 0 AND "credit" >= 0
        AND NOT ("debit" > 0 AND "credit" > 0)
        AND ("debit" > 0 OR "credit" > 0)
    );

ALTER TABLE "FinancialTransaction" DROP CONSTRAINT IF EXISTS chk_transaction_amount_positive;

ALTER TABLE "FinancialTransaction"
    ADD CONSTRAINT chk_transaction_amount_positive CHECK ("amount" > 0);

ALTER TABLE "FinancialTransaction" DROP CONSTRAINT IF EXISTS chk_transaction_transfer_document;

ALTER TABLE "FinancialTransaction"
    ADD CONSTRAINT chk_transaction_transfer_document
    CHECK ("kind"::text NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') OR "transferId" IS NOT NULL);

ALTER TABLE "FinancialTransaction" DROP CONSTRAINT IF EXISTS chk_transaction_loan_payment_document;

ALTER TABLE "FinancialTransaction"
    ADD CONSTRAINT chk_transaction_loan_payment_document
    CHECK ("kind"::text <> 'LOAN_PAYMENT' OR "loanPaymentId" IS NOT NULL);

ALTER TABLE "FinancialTransaction" DROP CONSTRAINT IF EXISTS chk_transaction_receivable_document;

ALTER TABLE "FinancialTransaction"
    ADD CONSTRAINT chk_transaction_receivable_document
    CHECK ("kind"::text <> 'RECEIVABLE_SETTLEMENT' OR "receivableId" IS NOT NULL);

ALTER TABLE "FinancialTransaction" DROP CONSTRAINT IF EXISTS chk_transaction_payable_document;

ALTER TABLE "FinancialTransaction"
    ADD CONSTRAINT chk_transaction_payable_document
    CHECK ("kind"::text <> 'PAYABLE_SETTLEMENT' OR "payableId" IS NOT NULL);

ALTER TABLE "Transfer" DROP CONSTRAINT IF EXISTS chk_transfer_amount_positive;

ALTER TABLE "Transfer"
    ADD CONSTRAINT chk_transfer_amount_positive CHECK ("amount" > 0);

ALTER TABLE "Transfer" DROP CONSTRAINT IF EXISTS chk_transfer_distinct_accounts;

ALTER TABLE "Transfer"
    ADD CONSTRAINT chk_transfer_distinct_accounts CHECK ("fromAccountId" <> "toAccountId");

ALTER TABLE "Loan" DROP CONSTRAINT IF EXISTS chk_loan_amounts;

ALTER TABLE "Loan"
    ADD CONSTRAINT chk_loan_amounts
    CHECK ("principalAmount" >= 0 AND "currentBalance" >= 0 AND "currentBalance" <= "principalAmount");

ALTER TABLE "Loan" DROP CONSTRAINT IF EXISTS chk_loan_rate_non_negative;

ALTER TABLE "Loan"
    ADD CONSTRAINT chk_loan_rate_non_negative
    CHECK ("annualRatePct" IS NULL OR "annualRatePct" >= 0);

ALTER TABLE "LoanPayment" DROP CONSTRAINT IF EXISTS chk_loan_payment_amounts;

ALTER TABLE "LoanPayment"
    ADD CONSTRAINT chk_loan_payment_amounts
    CHECK (
        "totalAmount" > 0
        AND "principalAmount" >= 0 AND "interestAmount" >= 0
        AND "feeAmount" >= 0 AND "penaltyAmount" >= 0
        AND abs(("principalAmount" + "interestAmount" + "feeAmount" + "penaltyAmount") - "totalAmount") <= 0.01
    );

ALTER TABLE "Receivable" DROP CONSTRAINT IF EXISTS chk_receivable_amounts;

ALTER TABLE "Receivable"
    ADD CONSTRAINT chk_receivable_amounts
    CHECK ("originalAmount" > 0 AND "settledAmount" >= 0 AND "settledAmount" <= "originalAmount");

ALTER TABLE "Payable" DROP CONSTRAINT IF EXISTS chk_payable_amounts;

ALTER TABLE "Payable"
    ADD CONSTRAINT chk_payable_amounts
    CHECK ("originalAmount" > 0 AND "settledAmount" >= 0 AND "settledAmount" <= "originalAmount");

ALTER TABLE "BudgetAllocation" DROP CONSTRAINT IF EXISTS chk_budget_allocation_limit;

ALTER TABLE "BudgetAllocation"
    ADD CONSTRAINT chk_budget_allocation_limit CHECK ("limitAmount" >= 0);

ALTER TABLE "RecurringObligation" DROP CONSTRAINT IF EXISTS chk_recurring_amount_positive;

ALTER TABLE "RecurringObligation"
    ADD CONSTRAINT chk_recurring_amount_positive CHECK ("amount" > 0);

ALTER TABLE "FinancialAccount" DROP CONSTRAINT IF EXISTS chk_account_credit_limit;

ALTER TABLE "FinancialAccount"
    ADD CONSTRAINT chk_account_credit_limit
    CHECK ("creditLimit" IS NULL OR "creditLimit" >= 0);

-- Una tarjeta de crédito es un pasivo: no puede ser efectivo disponible.
ALTER TABLE "FinancialAccount" DROP CONSTRAINT IF EXISTS chk_account_credit_card_is_liability;

ALTER TABLE "FinancialAccount"
    ADD CONSTRAINT chk_account_credit_card_is_liability
    CHECK (NOT "isCreditCard" OR "type"::text = 'CREDIT_CARD');

-- Un cierre no puede quedar FINALIZADO sin fecha de cierre ni responsable.
ALTER TABLE "DailyClosing" DROP CONSTRAINT IF EXISTS chk_closing_finalized_requires_closer;

ALTER TABLE "DailyClosing"
    ADD CONSTRAINT chk_closing_finalized_requires_closer
    CHECK ("status"::text <> 'FINALIZED' OR ("closedAt" IS NOT NULL AND "closedByUserId" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Índices de apoyo para dashboard y conciliación
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_journal_line_entry_account
    ON "JournalLine" ("financialAccountId", "ledgerAccountId");

CREATE INDEX IF NOT EXISTS idx_transaction_entity_date_kind_status
    ON "FinancialTransaction" ("entityId", "businessDate" DESC, "kind", "status");

CREATE INDEX IF NOT EXISTS idx_closing_entity_status
    ON "DailyClosing" ("entityId", "status", "businessDate" DESC);

-- IMPORTANTE: en un predicado de índice no se puede usar un cast de enum a
-- text ('"status"::text'): la función de salida del enum es STABLE, no IMMUTABLE,
-- y PostgreSQL lo rechaza con 42P17. Se compara directamente contra el literal.
CREATE INDEX IF NOT EXISTS idx_loan_due_open
    ON "Loan" ("nextDueDate") WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_receivable_open
    ON "Receivable" ("entityId", "dueDate")
    WHERE "status" IN ('PENDING', 'PARTIAL', 'OVERDUE');

CREATE INDEX IF NOT EXISTS idx_payable_open
    ON "Payable" ("entityId", "dueDate")
    WHERE "status" IN ('PENDING', 'PARTIAL', 'OVERDUE');
