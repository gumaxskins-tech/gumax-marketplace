-- Typed result for the fixed LEDGER idempotency scope.  It remains nullable
-- while a claim and its LedgerEntry are being created in one transaction.
ALTER TABLE "IdempotencyRecord" ADD COLUMN "ledgerEntryId" TEXT;

-- Backfill only legacy records whose untyped entityId is a matching LedgerEntry.
UPDATE "IdempotencyRecord" AS record
SET "ledgerEntryId" = entry."id",
    "entityId" = NULL
FROM "LedgerEntry" AS entry
WHERE record."scope" = 'LEDGER'
  AND record."entityId" = entry."id"
  AND entry."idempotencyKey" = record."key";

-- Never guess legacy results. Invalid Ledger records must be remediated before
-- this migration can enable commit-time Ledger claim invariants.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "IdempotencyRecord" AS record
    LEFT JOIN "LedgerEntry" AS entry ON entry."id" = record."ledgerEntryId"
    WHERE record."scope" = 'LEDGER'
      AND (
        record."status" <> 'COMPLETED'
        OR record."ledgerEntryId" IS NULL
        OR record."entityId" IS NOT NULL
        OR entry."id" IS NULL
        OR entry."idempotencyKey" <> record."key"
      )
  ) THEN
    RAISE EXCEPTION 'Cannot migrate invalid LEDGER idempotency records; remediate legacy entityId values first';
  END IF;
END $$;

CREATE UNIQUE INDEX "IdempotencyRecord_ledgerEntryId_key"
  ON "IdempotencyRecord"("ledgerEntryId");

ALTER TABLE "IdempotencyRecord"
  ADD CONSTRAINT "IdempotencyRecord_ledgerEntryId_fkey"
  FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "validate_ledger_idempotency_record"()
RETURNS TRIGGER AS $$
DECLARE
  ledger_key TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."scope" = 'LEDGER' THEN
      RAISE EXCEPTION 'Ledger idempotency records cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
    AND (OLD."scope" = 'LEDGER' OR NEW."scope" = 'LEDGER')
    AND (OLD."scope" IS DISTINCT FROM NEW."scope" OR OLD."key" IS DISTINCT FROM NEW."key") THEN
    RAISE EXCEPTION 'Ledger idempotency scope and key are immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."scope" = 'LEDGER' AND OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION 'Completed Ledger idempotency records are immutable';
  END IF;

  IF NEW."scope" <> 'LEDGER' THEN
    RETURN NEW;
  END IF;

  IF NEW."status" = 'COMPLETED' THEN
    IF NEW."ledgerEntryId" IS NULL OR NEW."entityId" IS NOT NULL THEN
      RAISE EXCEPTION 'Completed Ledger idempotency requires only a typed LedgerEntry result';
    END IF;

    SELECT "idempotencyKey" INTO ledger_key
    FROM "LedgerEntry"
    WHERE "id" = NEW."ledgerEntryId";

    IF ledger_key IS NULL OR ledger_key <> NEW."key" THEN
      RAISE EXCEPTION 'Ledger idempotency result must reference the same idempotency key';
    END IF;
  ELSIF NEW."ledgerEntryId" IS NOT NULL OR NEW."entityId" IS NOT NULL THEN
    RAISE EXCEPTION 'Incomplete Ledger idempotency cannot reference a result';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IdempotencyRecord_validate_ledger_lifecycle"
BEFORE INSERT OR UPDATE OR DELETE ON "IdempotencyRecord"
FOR EACH ROW EXECUTE FUNCTION "validate_ledger_idempotency_record"();

CREATE FUNCTION "assert_ledger_idempotency_completed_at_commit"()
RETURNS TRIGGER AS $$
DECLARE
  record "IdempotencyRecord"%ROWTYPE;
BEGIN
  SELECT * INTO record
  FROM "IdempotencyRecord"
  WHERE "id" = NEW."id";

  IF NOT FOUND OR record."scope" <> 'LEDGER' THEN
    RETURN NULL;
  END IF;

  IF record."status" <> 'COMPLETED'
    OR record."ledgerEntryId" IS NULL
    OR record."entityId" IS NOT NULL THEN
    RAISE EXCEPTION 'Ledger idempotency claims must be completed before commit';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "IdempotencyRecord_require_completed_ledger_claim"
AFTER INSERT OR UPDATE ON "IdempotencyRecord"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_ledger_idempotency_completed_at_commit"();
