ALTER TABLE "assets" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "galleries" ADD COLUMN "rolling_delivery" boolean DEFAULT false NOT NULL;