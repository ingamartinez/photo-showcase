ALTER TABLE "gallery_clients" ADD COLUMN "selection_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gallery_clients" ADD COLUMN "selection_submitted_at" timestamp with time zone;--> statement-breakpoint
-- Epic #239 backfill: until now the lock was gallery-wide, so every ACTIVE
-- member of a gallery that already left `proofing` has, in effect, submitted.
-- Stamp both columns with the gallery's own submission time (now() when the
-- gallery never recorded one). Galleries in draft/proofing are untouched.
UPDATE "gallery_clients" AS gc
SET "selection_locked_at" = COALESCE(g."selection_submitted_at", now()),
    "selection_submitted_at" = COALESCE(g."selection_submitted_at", now())
FROM "galleries" AS g
WHERE gc."gallery_id" = g."id"
  AND gc."removed_at" IS NULL
  AND g."status" IN ('selected', 'delivered', 'archived');
