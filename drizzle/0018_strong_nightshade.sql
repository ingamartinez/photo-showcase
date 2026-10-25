CREATE TABLE "gallery_final_cleanup" (
	"gallery_id" uuid PRIMARY KEY NOT NULL,
	"reopen_epoch" timestamp with time zone NOT NULL,
	"remaining_keys" text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gallery_final_cleanup" ADD CONSTRAINT "gallery_final_cleanup_gallery_id_galleries_id_fk" FOREIGN KEY ("gallery_id") REFERENCES "public"."galleries"("id") ON DELETE restrict ON UPDATE no action;