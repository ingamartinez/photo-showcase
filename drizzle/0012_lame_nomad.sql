ALTER TABLE "assets" ADD COLUMN "is_extra" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "delivered_for" text;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_delivered_for_users_id_fk" FOREIGN KEY ("delivered_for") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;