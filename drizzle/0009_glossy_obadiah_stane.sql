CREATE TYPE "public"."selection_kind" AS ENUM('edited', 'original');--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "selection_kind" "selection_kind" DEFAULT 'edited' NOT NULL;--> statement-breakpoint
ALTER TABLE "galleries" ADD COLUMN "original_photo_price_cop_snapshot" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "original_photo_price_cop" integer DEFAULT 2000 NOT NULL;