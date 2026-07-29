CREATE TABLE "gallery_clients" (
	"gallery_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gallery_clients_gallery_id_user_id_pk" PRIMARY KEY("gallery_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "galleries" DROP CONSTRAINT "galleries_client_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "selected_by" text;--> statement-breakpoint
ALTER TABLE "gallery_clients" ADD CONSTRAINT "gallery_clients_gallery_id_galleries_id_fk" FOREIGN KEY ("gallery_id") REFERENCES "public"."galleries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_clients" ADD CONSTRAINT "gallery_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_selected_by_users_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill (task #94): one gallery_clients row per EXISTING gallery,
-- carrying its current (soon to be dropped) client_id forward. "galleries"
-- still has its "client_id" column at this exact point in the file — only
-- the FK CONSTRAINT was dropped above, not the column itself, so this SELECT
-- can still read it.
--
-- This is the dangerous half of the migration: production has real
-- delivered galleries, and client_id is their ONLY link to a person. This
-- does not merely insert and hope — the DO block right after this counts
-- both sides and RAISEs if they disagree.
INSERT INTO "gallery_clients" ("gallery_id", "user_id")
SELECT "id", "client_id" FROM "galleries";
--> statement-breakpoint
-- Verification gate: every statement in this file runs inside ONE
-- transaction (drizzle-orm's PgDialect.migrate wraps the whole migration in
-- session.transaction(...) — see node_modules/drizzle-orm/pg-core/dialect.js
-- and drizzle-kit's own "migrate" command, which reuses that exact
-- postgres-js migrator). A RAISE EXCEPTION here therefore rolls back this
-- entire file — the CREATE TABLE above included — not just this statement,
-- so a mismatch can never leave a half-migrated database with client_id
-- already gone. Only once this passes does the DROP COLUMN below ever run.
DO $$
DECLARE
	gallery_count integer;
	backfilled_count integer;
BEGIN
	SELECT count(*) INTO gallery_count FROM "galleries";
	SELECT count(*) INTO backfilled_count FROM "gallery_clients";
	IF gallery_count <> backfilled_count THEN
		RAISE EXCEPTION
			'gallery_clients backfill mismatch: % galleries but % gallery_clients rows — aborting before dropping galleries.client_id',
			gallery_count, backfilled_count;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "galleries" DROP COLUMN "client_id";
