CREATE TABLE "asset_picks" (
	"asset_id" uuid NOT NULL,
	"gallery_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" "selection_kind" DEFAULT 'edited' NOT NULL,
	"picked_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "asset_picks_asset_id_user_id_pk" PRIMARY KEY("asset_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "billed_at" timestamp with time zone;--> statement-breakpoint
-- HAND EDIT (task #257, plan §3): drizzle-kit emits the composite FKs before
-- this unique index, but Postgres rejects an FK whose referenced columns have
-- no unique constraint yet ("there is no unique constraint matching given
-- keys for referenced table \"assets\""). The migrator runs the whole file in
-- one transaction, so the deploy would fail cleanly -- but it would fail. The
-- index is not a schema change of its own (`id` is already the PK); moving it
-- up only fixes the ordering. Do not let a future `db:generate` undo this.
CREATE UNIQUE INDEX "assets_id_gallery_id_idx" ON "assets" USING btree ("id","gallery_id");--> statement-breakpoint
ALTER TABLE "asset_picks" ADD CONSTRAINT "asset_picks_asset_fk" FOREIGN KEY ("asset_id","gallery_id") REFERENCES "public"."assets"("id","gallery_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_picks" ADD CONSTRAINT "asset_picks_membership_fk" FOREIGN KEY ("gallery_id","user_id") REFERENCES "public"."gallery_clients"("gallery_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_picks_gallery_user_idx" ON "asset_picks" USING btree ("gallery_id","user_id");--> statement-breakpoint

-- ===========================================================================
-- Backfill (task #257, plan §4). Order is load-bearing:
--   guard -> insert picks -> release carts -> billed_at -> decision-20 unlock.
-- ===========================================================================

-- 4.1 Guard: refuse instead of guessing. Each bucket was empty in the S1
-- census; the backup at deploy time is newer, so if a bucket reappears the
-- migration aborts the deploy for manual resolution (decision 9's own
-- default) rather than silently doing the wrong thing.
DO $$
DECLARE
  orphan_pickers integer;
  removed_open integer;
  undated integer;
  cart_finals integer;
  closed_carts integer;
BEGIN
  SELECT count(*) INTO orphan_pickers
  FROM "assets" a
  LEFT JOIN "gallery_clients" gc ON gc."gallery_id" = a."gallery_id" AND gc."user_id" = a."selected_by"
  WHERE a."is_selected" AND a."selected_by" IS NOT NULL AND gc."user_id" IS NULL;

  SELECT count(*) INTO removed_open
  FROM "assets" a
  JOIN "galleries" g ON g."id" = a."gallery_id"
  JOIN "gallery_clients" gc ON gc."gallery_id" = a."gallery_id" AND gc."user_id" = a."selected_by"
  WHERE a."is_selected" AND gc."removed_at" IS NOT NULL
    AND g."status" NOT IN ('selected', 'delivered', 'archived');

  SELECT count(*) INTO undated
  FROM "assets" a
  WHERE a."is_selected" AND a."selected_by" IS NOT NULL
    AND a."selected_at" IS NULL AND a."requested_at" IS NULL;

  SELECT count(*) INTO cart_finals
  FROM "assets" a
  JOIN "galleries" g ON g."id" = a."gallery_id"
  JOIN "gallery_clients" gc ON gc."gallery_id" = a."gallery_id" AND gc."user_id" = a."selected_by"
  WHERE a."is_selected" AND a."final_key" IS NOT NULL
    AND g."status" NOT IN ('selected', 'delivered', 'archived')
    AND a."requested_at" IS NULL AND gc."selection_locked_at" IS NULL;

  -- A pick in a closed gallery whose submission chain has no stamp at all
  -- (requested_at set, but gc/g/asset timestamps all NULL) would land with
  -- `submitted_at` NULL and turn into a cart in a `selected`/`delivered`/
  -- `archived` gallery -- the one remaining path 4.3 could otherwise take
  -- undetected. Refuse it here, before any write.
  SELECT count(*) INTO closed_carts
  FROM "assets" a
  JOIN "galleries" g ON g."id" = a."gallery_id"
  JOIN "gallery_clients" gc ON gc."gallery_id" = a."gallery_id" AND gc."user_id" = a."selected_by"
  WHERE a."is_selected" AND a."selected_by" IS NOT NULL
    AND g."status" IN ('selected', 'delivered', 'archived')
    AND COALESCE(gc."selection_submitted_at", g."selection_submitted_at", a."selected_at") IS NULL;

  IF orphan_pickers + removed_open + undated + cart_finals + closed_carts > 0 THEN
    RAISE EXCEPTION 'asset_picks backfill refused: % picks by a non-member (admin/D9), % open-gallery picks by a removed member, % picks with no timestamp, % cart photos that already have a final, % closed-gallery picks with no submission stamp',
      orphan_pickers, removed_open, undated, cart_finals, closed_carts;
  END IF;
END $$;
--> statement-breakpoint

-- 4.2 One pick per attributed selected asset. The inner join on
-- gallery_clients drops only rows 4.1 has already refused. `kind` is copied
-- BEFORE 4.3 resets the asset's kind. `picked_at` keeps the legacy tap time.
-- The open bucket's CASE honours rolling orders (requested_at), admin locks
-- (decision 18) and classic client submits (decision 20 keeps them unlocked).
INSERT INTO "asset_picks" ("asset_id", "gallery_id", "user_id", "kind", "picked_at", "submitted_at")
SELECT
  a."id",
  a."gallery_id",
  a."selected_by",
  a."selection_kind",
  COALESCE(a."requested_at", a."selected_at"),
  CASE
    WHEN g."status" IN ('selected', 'delivered', 'archived')
      THEN COALESCE(gc."selection_submitted_at", g."selection_submitted_at", a."selected_at")
    WHEN a."requested_at" IS NOT NULL
      THEN a."requested_at"
    WHEN gc."selection_locked_by" = 'admin'
      THEN gc."selection_locked_at"
    WHEN gc."selection_locked_at" IS NOT NULL
      THEN COALESCE(gc."selection_submitted_at", gc."selection_locked_at")
    ELSE NULL
  END
FROM "assets" a
JOIN "galleries" g ON g."id" = a."gallery_id"
JOIN "gallery_clients" gc ON gc."gallery_id" = a."gallery_id" AND gc."user_id" = a."selected_by"
WHERE a."is_selected" AND a."selected_by" IS NOT NULL;
--> statement-breakpoint

-- 4.3 Release the cart photos (unclaim). Mirrors the deselect path
-- (selection/route.ts:398-405): the person's intent survives in
-- asset_picks.kind. The NOT EXISTS avoids unclaiming a photo another person
-- has already submitted; it does NOT re-resolve attribution (S5/S6 do).
UPDATE "assets" a
SET "is_selected" = false,
    "selected_at" = NULL,
    "selected_by" = NULL,
    "requested_at" = NULL,
    "selection_kind" = 'edited'
FROM "asset_picks" p
WHERE p."asset_id" = a."id" AND p."submitted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "asset_picks" q WHERE q."asset_id" = a."id" AND q."submitted_at" IS NOT NULL
  );
--> statement-breakpoint

-- 4.4 `billed_at` for every claimed asset. Runs after 4.3, so the released
-- carts keep it NULL. The coalesce is "the legacy claim time" in both regimes
-- (decision 6: arrival is the claim, never the pick).
UPDATE "assets"
SET "billed_at" = COALESCE("requested_at", "selected_at")
WHERE "is_selected";
--> statement-breakpoint

-- 4.5 Decision 20: reopen classic (client-locked) members of `proofing` who
-- had already submitted. Mirrors the rolling-enable precedent
-- (actions.ts:2606): clears only the lock pair, keeps `selection_submitted_at`,
-- leaves admin locks alone, and is scoped to `proofing` so a `selected`
-- gallery is never reopened (plan §7).
UPDATE "gallery_clients" gc
SET "selection_locked_at" = NULL, "selection_locked_by" = NULL
FROM "galleries" g
WHERE g."id" = gc."gallery_id"
  AND g."status" = 'proofing'
  AND gc."removed_at" IS NULL
  AND gc."selection_locked_by" = 'client';
