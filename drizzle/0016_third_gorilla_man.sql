ALTER TABLE "assets" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "galleries" ADD COLUMN "rolling_delivery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gallery_clients" ADD COLUMN "selection_locked_by" text;--> statement-breakpoint
UPDATE "gallery_clients" SET "selection_locked_by" = CASE WHEN "selection_locked_at" = "selection_submitted_at" THEN 'client' ELSE 'admin' END WHERE "selection_locked_at" IS NOT NULL;
