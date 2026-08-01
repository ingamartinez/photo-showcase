CREATE TYPE "public"."selection_tray_mode" AS ENUM('flat', 'by-person');--> statement-breakpoint
ALTER TABLE "galleries" ADD COLUMN "selection_tray_mode" "selection_tray_mode" DEFAULT 'flat' NOT NULL;