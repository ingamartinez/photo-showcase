-- Task #257 (epic #250) — PRE-migration snapshot for the backup verification
-- (plan §9.3). Run this against the pristine scratch DB BEFORE applying 0017.
-- The verify script left-joins against `s2_baseline.*` to prove the backfill
-- only changed what it was allowed to change.
--
-- Not a migration artifact; never runs in production. The baseline schema is
-- created in the target DB and read only by scripts/asset-picks-backfill-verify.sql.
CREATE SCHEMA s2_baseline;
CREATE TABLE s2_baseline.assets AS SELECT id, gallery_id, is_selected, selected_by, selected_at, requested_at, selection_kind, final_key, is_extra FROM assets;
CREATE TABLE s2_baseline.galleries AS SELECT id, title, status, rolling_delivery, selection_submitted_at FROM galleries;
CREATE TABLE s2_baseline.gallery_clients AS SELECT gallery_id, user_id, removed_at, selection_locked_at, selection_submitted_at, selection_locked_by FROM gallery_clients;
