ALTER TABLE "galleries" ADD COLUMN "unlocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "galleries" ADD COLUMN "unlocked_by_email" text;--> statement-breakpoint
ALTER TABLE "galleries" ADD COLUMN "unlock_reason" text;