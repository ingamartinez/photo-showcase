-- Task #257 (epic #250) — MANUAL rollback for migration 0017 (plan §10).
-- Drizzle-kit generates no down migration; this one is hand-written and was
-- round-trip tested against the pre-migration baseline (plan §9.6).
--
--   psql -h /tmp -d <scratch_b> -v ON_ERROR_STOP=1 -f scripts/asset-picks-backfill-down.sql
--
-- VALID ONLY BEFORE THE NEW CODE HAS ACCEPTED A SINGLE CLIENT WRITE. Once
-- S4's PATCH writes `asset_picks`, this discards those picks; the answer then
-- is roll forward, or restore the pre-deploy dump.
\set ON_ERROR_STOP 1
BEGIN;
-- Restore released carts from their surviving pick (picked_at = old selected_at
-- because the CASE made requested_at NULL; kind is copied back too).
UPDATE "assets" a
SET "is_selected" = true, "selected_by" = p."user_id", "selected_at" = p."picked_at",
    "requested_at" = NULL, "selection_kind" = p."kind"
FROM "asset_picks" p
WHERE p."asset_id" = a."id" AND p."submitted_at" IS NULL AND NOT a."is_selected";
-- Restore decision 20's unlock. `NOT rolling_delivery` separates decision-20
-- rows from rolling orderers, who are legitimately "submitted and unlocked".
UPDATE "gallery_clients" gc
SET "selection_locked_at" = gc."selection_submitted_at", "selection_locked_by" = 'client'
FROM "galleries" g
WHERE g."id" = gc."gallery_id" AND g."status" = 'proofing' AND NOT g."rolling_delivery"
  AND gc."removed_at" IS NULL AND gc."selection_locked_at" IS NULL AND gc."selection_submitted_at" IS NOT NULL;
DROP TABLE "asset_picks";
DROP INDEX "assets_id_gallery_id_idx";
ALTER TABLE "assets" DROP COLUMN "billed_at";
-- Literal 0017 `when` from drizzle/meta/_journal.json. NEVER max(created_at):
-- that deletes the wrong row if anything ships after 0017.
DELETE FROM drizzle."__drizzle_migrations" WHERE "created_at" = 1792266289727;
COMMIT;
