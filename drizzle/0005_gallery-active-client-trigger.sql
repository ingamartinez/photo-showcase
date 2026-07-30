-- Task #100 — the DATABASE BACKSTOP for one invariant, and only that one:
--
--   a gallery past `draft` has at least one active client
--   (a `gallery_clients` row for it with `removed_at IS NULL`)
--
-- THIS IS NOT THE PRIMARY CHECK. The authority is
-- `activeClientRuleViolation()` in src/lib/galleries.ts, consulted by
-- `publishGallery`, `deliverGallery` and `removeGalleryClient` BEFORE they
-- write; that is what produces the Spanish sentence a human reads. Nothing in
-- the application may be restructured to learn the answer by catching the
-- exception raised here — if that ever happens, the layering has inverted and
-- the good error messages are gone.
--
-- WHO THIS IS ACTUALLY FOR: whoever opens `psql` against production at 2am.
-- That door is known to have been used — task #73 (the unlock escape hatch)
-- exists specifically to replace a manual `UPDATE galleries SET status = ...`
-- against production that was the only way out of a stuck `selected` gallery.
-- The same hand can move a gallery past `draft` while nobody is attached to
-- it, or soft-remove the last client from one already published, and the
-- application would never see either write.
--
-- WHY A TRIGGER AND NOT A CHECK: a `CHECK` constraint cannot express this.
-- Postgres CHECKs cannot span tables, and this rule compares
-- `galleries.status` against a COUNT of rows in `gallery_clients`.
--
-- WHY TWO TRIGGERS: the invariant has two sides and either one can break it
-- alone — the gallery's `status` moving out of `draft`, or the last active
-- membership going away under a gallery already past `draft`. One trigger on
-- each table; neither is a substitute for the other.
--
-- WHY DEFERRABLE INITIALLY DEFERRED: both checks read the OTHER table, so a
-- legitimate multi-statement transaction can be momentarily inconsistent
-- while ending in a perfectly valid state. A non-deferrable row trigger would
-- reject those on the ORDER the statements happen to be written in.
--
-- Two real cases, both VERIFIED by installing a non-deferrable copy of these
-- triggers on Postgres 17.9 and replaying each transaction:
--
--   1. Publishing a clientless draft by hand — `UPDATE galleries SET
--      status='proofing'` and then attaching the client. REJECTED
--      non-deferrably. Writing the same two statements in the other order
--      commits. Same final state, opposite outcome.
--   2. Swapping a client on a `proofing` gallery — soft-remove the old one,
--      attach the new one. REJECTED non-deferrably, and this is the sharper
--      case: remove-then-attach is the natural way to write a swap, and the
--      gallery is never meant to be clientless at any point a human cares
--      about. Attach-then-remove commits.
--
-- NOT a reason, despite looking like the obvious one: `createGallery`
-- inserting the gallery row before its memberships. That was this comment's
-- original justification and it is FALSE — `createGallery` inserts at
-- `draft`, so the check hits the `draft` early exit below and returns before
-- counting anything. Replayed against a non-deferrable trigger, it commits
-- cleanly. Recorded here because it is the first explanation anyone reaches
-- for, and it does not hold.
--
-- Deferring to COMMIT checks what the transaction actually leaves behind,
-- which is the only thing the invariant is about.
--
-- THE MESSAGE IS DIAGNOSTIC ON PURPOSE, NOT POLITE. Nobody reaching it is a
-- client; they are someone doing something the application refuses. It names
-- the gallery id, the status and the active-client count so the reader can
-- act without another query.
CREATE OR REPLACE FUNCTION assert_gallery_past_draft_has_active_client(target_gallery_id uuid)
	RETURNS void
	LANGUAGE plpgsql
AS $$
DECLARE
	current_status text;
	active_client_count integer;
BEGIN
	SELECT "status"::text INTO current_status
	FROM "galleries"
	WHERE "id" = target_gallery_id;

	-- The gallery itself was deleted in this same transaction (the
	-- `gallery_clients.gallery_id` FK cascades, schema.ts). Its memberships
	-- went with it and there is no invariant left to hold. Reachable only via
	-- the deferred check running at COMMIT, after the parent row is gone.
	IF current_status IS NULL THEN
		RETURN;
	END IF;

	-- The whole exception: a draft is allowed to have nobody attached. Keep
	-- this in step with `requiresActiveClient()` in src/lib/galleries.ts.
	IF current_status = 'draft' THEN
		RETURN;
	END IF;

	SELECT count(*) INTO active_client_count
	FROM "gallery_clients"
	WHERE "gallery_id" = target_gallery_id
		AND "removed_at" IS NULL;

	IF active_client_count = 0 THEN
		RAISE EXCEPTION
			'gallery % is in status % with % active clients: a gallery past draft must have at least one gallery_clients row with removed_at IS NULL (application guard: activeClientRuleViolation in src/lib/galleries.ts)',
			target_gallery_id, current_status, active_client_count;
	END IF;
END;
$$;
--> statement-breakpoint
-- Side one: the gallery's own status leaves `draft` (or a gallery is inserted
-- already past it) while nobody is attached.
CREATE OR REPLACE FUNCTION galleries_assert_active_client()
	RETURNS trigger
	LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM assert_gallery_past_draft_has_active_client(NEW."id");
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Side two: the last active membership disappears under a gallery already
-- past `draft` — either a hard DELETE or task #97's soft removal (stamping
-- `removed_at`). An INSERT can only ever ADD an active client, so it is not
-- watched here.
CREATE OR REPLACE FUNCTION gallery_clients_assert_active_client()
	RETURNS trigger
	LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM assert_gallery_past_draft_has_active_client(
		CASE WHEN TG_OP = 'DELETE' THEN OLD."gallery_id" ELSE NEW."gallery_id" END
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Verification gate, same shape and same reasoning as 0003's backfill check:
-- every statement in this file runs inside ONE transaction (drizzle-orm's
-- PgDialect.migrate wraps the whole migration), so a RAISE here rolls the
-- triggers back with it. This refuses to install a backstop over data that
-- ALREADY violates the invariant — the triggers only fire on future writes,
-- so an existing bad row would sit there permanently while the trigger blocks
-- the very writes that could clean it up. Runs before the triggers are
-- created so the failure names the data problem, not a trigger firing.
DO $$
DECLARE
	violating_count integer;
BEGIN
	SELECT count(*) INTO violating_count
	FROM "galleries" g
	WHERE g."status" <> 'draft'
		AND NOT EXISTS (
			SELECT 1 FROM "gallery_clients" gc
			WHERE gc."gallery_id" = g."id" AND gc."removed_at" IS NULL
		);

	IF violating_count > 0 THEN
		RAISE EXCEPTION
			'% galleries past draft already have zero active clients — aborting before installing the trigger pair; attach a client to each one first',
			violating_count;
	END IF;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER galleries_active_client_check
	AFTER INSERT OR UPDATE OF "status" ON "galleries"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION galleries_assert_active_client();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER gallery_clients_active_client_check
	AFTER UPDATE OF "removed_at" OR DELETE ON "gallery_clients"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION gallery_clients_assert_active_client();
