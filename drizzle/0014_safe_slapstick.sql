CREATE TABLE "flash_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flash_gallery_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"final_key" text NOT NULL,
	"display_width" integer NOT NULL,
	"display_height" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flash_galleries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"session_date" date,
	"public_slug" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flash_gallery_clients" (
	"flash_gallery_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "flash_gallery_clients_flash_gallery_id_user_id_pk" PRIMARY KEY("flash_gallery_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "flash_assets" ADD CONSTRAINT "flash_assets_flash_gallery_id_flash_galleries_id_fk" FOREIGN KEY ("flash_gallery_id") REFERENCES "public"."flash_galleries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_gallery_clients" ADD CONSTRAINT "flash_gallery_clients_flash_gallery_id_flash_galleries_id_fk" FOREIGN KEY ("flash_gallery_id") REFERENCES "public"."flash_galleries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flash_gallery_clients" ADD CONSTRAINT "flash_gallery_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flash_galleries_public_slug_idx" ON "flash_galleries" USING btree ("public_slug");