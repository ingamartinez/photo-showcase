-- Task #257 (epic #250) — MANUAL rollback for migration 0017 (plan §10).
-- Drizzle-kit generates no down migration; this one is hand-written and was
-- round-trip tested against the pre-migration baseline (plan §9.6).
--
--   psql -h /tmp -d <scratch_b> -v ON_ERROR_STOP=1 -f scripts/asset-picks-backfill-down.sql
--
-- VALID ONLY BEFORE THE NEW CODE HAS ACCEPTED A SINGLE CLIENT WRITE. Once
-- S4's PATCH writes `asset_picks`, this discards those picks; the answer then
-- is roll forward, or restore the pre-deploy dump.
--
-- WHAT THIS SCRIPT DOES *NOT* REVERSE — decision 20. The up migration's 4.5
-- clears the lock pair on classic (client-locked) members of `proofing`
-- galleries. This script deliberately does NOT restore that lock. Once 4.5 has
-- run, a decision-20 row and an orderer in a gallery whose rolling flag was
-- later turned off are indistinguishable: both are active, `proofing`,
-- submitted and unlocked. Re-locking the wrong one would freeze a client's
-- selection — the unsafe direction. Members therefore stay unlocked, which is
-- safe: an unlocked member can re-send, whereas a wrongly locked one is frozen
-- out. The re-claim of the released carts below IS exact (picked_at is the old
-- selected_at and `kind` is copied back).
\set ON_ERROR_STOP 1
BEGIN;
-- Restore released carts from their surviving pick (picked_at = old selected_at
-- because the CASE made requested_at NULL; kind is copied back too).
UPDATE "assets" a
SET "is_selected" = true, "selected_by" = p."user_id", "selected_at" = p."picked_at",
    "requested_at" = NULL, "selection_kind" = p."kind"
FROM "asset_picks" p
WHERE p."asset_id" = a."id" AND p."submitted_at" IS NULL AND NOT a."is_selected";
DROP TABLE "asset_picks";
DROP INDEX "assets_id_gallery_id_idx";
ALTER TABLE "assets" DROP COLUMN "billed_at";
-- Remove 0017 from the journal. The DELETE must hit exactly one row: the
-- literal 0017 `when` from drizzle/meta/_journal.json. NEVER max(created_at):
-- that deletes the wrong row if anything ships after 0017. If the literal has
-- gone stale (a regenerated 0017 with a new `when`), the zero-row case raises
-- and the whole transaction rolls back instead of silently reporting success
-- while the journal still claims 0017 is applied.
DO $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE "created_at" = 1792266289727;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> 1 THEN
    RAISE EXCEPTION 'asset_picks backfill down: expected to delete exactly 1 migration row for 0017, deleted %', deleted;
  END IF;
END $$;
COMMIT;
