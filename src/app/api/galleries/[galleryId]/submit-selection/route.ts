// POST /api/galleries/[galleryId]/submit-selection — the client's "these
// ones" moment (task #25): `proofing -> selected`, `selectionSubmittedAt`
// stamped, and the admin notified with what they need to start working.
//
// Keyed on the gallery's internal `id`, not its `publicSlug` — a deliberate
// difference from the PAGE route (`/galleries/[publicSlug]`), not an
// oversight. schema.ts's comment on `galleries.publicSlug` is about what may
// appear in a browser-addressable, shareable, bookmarkable URL; this is a
// same-origin `fetch()` call issued by JS already running on that page, the
// exact same situation `/api/assets/[assetId]/...` is already in with the
// asset's own internal `id` (also a random UUID, per schema.ts). Reusing the
// gallery's `id` here — already passed to `<ProofGrid>` by the page that
// renders it — needs no new lookup and introduces no new identifier.
//
// REOPEN POLICY (decided in this slice, not left as an open question):
// once submitted, the CLIENT can never toggle or resubmit — see the
// SELECTION_LOCKED_STATUSES set on the sibling PATCH
// /api/assets/[assetId]/selection route, which already includes "selected".
// Only an ADMIN can unlock a submitted selection, from the dashboard — this
// is a deliberate, asymmetric human escape hatch. The submitted selection is
// the evidence a real payment conversation (extras, surcharge — settled
// outside the app, PLAN.md §3) gets built on, so it must freeze; but "the
// client changed their mind" WILL happen, and when it does, the fix is a
// phone call with the photographer, not a client-facing "undo" button that
// would let a submission be silently revised after that conversation already
// started. The unlock action itself is NOT part of this slice — see this
// route's own header note in the task body (kanban #25) for why: it is a
// materially separate piece of work (an admin-facing action + its own
// authorization story) from "lock and notify", and half-building it here
// would risk shipping neither cleanly.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleries, users } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireApiSession } from "@/lib/auth-guards";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { isGalleryOwner } from "@/lib/gallery-access";
import { authEnv, resendEnv } from "@/lib/env";
import { sendSubmissionNotificationEmail } from "@/lib/admin-notification-email";
import { computeQuota, type QuotaResult } from "@/lib/quota";

export const runtime = "nodejs";

const galleryIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** Fresh read of every sibling asset's `isSelected` flag, recomputed into a
 * `QuotaResult` off the gallery's own frozen snapshot terms — same pattern
 * as the PATCH selection route, and for the same reason: never trust
 * anything the caller supplied, never trust a number left over from an
 * earlier step in this same request. Safe to call for a gallery that is no
 * longer `proofing` too (the idempotent/"already submitted" paths below use
 * it): once a gallery leaves `proofing`, the PATCH route's own lock refuses
 * every further toggle, so the selection this recomputes is exactly the one
 * that was frozen at submission time. */
async function currentQuota(gallery: Gallery): Promise<QuotaResult> {
  const siblings = await db
    .select({ isSelected: assets.isSelected })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  const selected = siblings.filter((row) => row.isSelected).length;
  return computeQuota(selected, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
  });
}

async function idempotentResponse(gallery: Gallery): Promise<NextResponse> {
  const quota = await currentQuota(gallery);
  return NextResponse.json({
    status: "already_submitted",
    quota,
    submittedAt: gallery.selectionSubmittedAt ? gallery.selectionSubmittedAt.toISOString() : null,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
): Promise<NextResponse> {
  // Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
  const sessionOrResponse = await requireApiSession();
  if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
  const session = sessionOrResponse;

  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) {
    return errorResponse("invalid_gallery_id", 400);
  }
  const galleryId = galleryIdResult.data;

  const [gallery] = await db.select().from(galleries).where(eq(galleries.id, galleryId)).limit(1);
  if (!gallery) {
    return errorResponse("gallery_not_found", 404);
  }

  // Gate 1 — ownership: one of the gallery's OWN clients (task #94 — a
  // gallery can now have several), or an admin. Shared through
  // src/lib/gallery-access.ts's isGalleryOwner rather than a rewritten
  // comparison — see that module's header comment. 403 (not 404) for a
  // wrong owner, matching src/lib/asset-access.ts's loadOwnedAsset: the
  // gallery id is a random UUID (schema.ts), not sequential, so confirming
  // "this id exists" here leaks nothing an attacker could walk.
  const isAdmin = session.user.role === "admin";
  if (!(await isGalleryOwner(gallery.id, session))) {
    return errorResponse("forbidden", 403);
  }

  // Gate 2 — visibility (non-admin only): a `draft` gallery is not yet
  // visible to its own client (PLAN.md §2) — refused with the same 404 the
  // page and the PATCH selection route already use for this exact case, so
  // a client fishing for gallery ids learns nothing new here. Admins bypass
  // this, same as every sibling route.
  if (!isAdmin && !isGalleryVisibleToClient(gallery.status)) {
    return errorResponse("gallery_not_found", 404);
  }

  // Idempotent double-submit, part 1: the gallery is ALREADY `selected` —
  // this is a second click (or a second tab) after a first submission that
  // already succeeded. No mutation, no email, a calm 200 that reflects
  // reality — kanban #61's exact guidance, applied here instead of repeated
  // as a bug: "the losing caller gets a sensible, non-alarming result... the
  // gallery IS [submitted]; it just was not this call that did it."
  if (gallery.status === "selected") {
    return idempotentResponse(gallery);
  }

  // Everything else that isn't `proofing` is not eligible to transition
  // right now: `draft` (reachable only by an admin preview, gate 2 already
  // refused a client), and `delivered`/`archived` (further along than
  // submission even matters for). PLAN.md §2's state machine is linear —
  // `proofing -> selected` is the only transition this route ever performs.
  if (gallery.status !== "proofing") {
    return errorResponse("gallery_not_submittable", 409);
  }

  // Submitting an EMPTY selection is refused (task #25's own acceptance
  // criterion) — checked BEFORE the conditional UPDATE below, off a fresh
  // read, same "reject cheaply and early" stance as the proofs upload
  // route's own status check before it ever reads the request body. A
  // client could in principle deselect their last photo in one tab between
  // this read and the UPDATE a moment later; accepted, not fixed here — the
  // same class of small, undocumented-away race the proofs route's
  // `sort_order` assignment already tolerates ("not strictly serialized...
  // not a correctness bug"), and closing it would mean folding this count
  // into the UPDATE's own WHERE clause as a correlated EXISTS subquery,
  // more machinery than this slice's acceptance criterion asks for.
  const preSubmitQuota = await currentQuota(gallery);
  if (preSubmitQuota.selected === 0) {
    return errorResponse("empty_selection", 400);
  }

  // THE atomicity guard — this is what makes a true concurrent double-submit
  // send exactly one email instead of two. Guard the UPDATE itself, don't
  // reorder anything to work around it: kanban #61 found the identical bug
  // in the publish path (an unconditional `UPDATE ... SET status =
  // 'proofing'` with no `WHERE status = 'draft'`) and its own review is
  // explicit that the fix is a `WHERE` clause on the update, NOT reordering
  // the send/update pair. Applied here from the start rather than
  // discovered later: two requests racing this exact code both read
  // `status = 'proofing'` above, but Postgres serializes the two UPDATEs
  // against the same row — the second to actually execute evaluates its
  // `WHERE` against the FIRST one's already-committed result and matches
  // zero rows. Only the winner (`updated.length === 1`) ever reaches the
  // email-sending branch below.
  const now = new Date();
  const updated = await db
    .update(galleries)
    .set({ status: "selected", selectionSubmittedAt: now })
    .where(and(eq(galleries.id, gallery.id), eq(galleries.status, "proofing")))
    .returning();

  if (updated.length === 0) {
    // Lost the race. The winner's UPDATE has already committed by the time
    // ours evaluated its own WHERE clause (Postgres locks the row for the
    // duration of a concurrent UPDATE), so re-reading now reflects the
    // winner's committed result. There is no revert anywhere in this route
    // (see the notification try/catch below for why), so `selected` is the
    // ONLY status this re-read can ever observe once our own CAS has lost —
    // nothing else in this route ever moves the gallery back out of it.
    const [fresh] = await db.select().from(galleries).where(eq(galleries.id, gallery.id)).limit(1);
    if (fresh && fresh.status === "selected") {
      return idempotentResponse(fresh);
    }
    // Defensive only — unreachable given the invariant above, kept so this
    // route fails closed (a clear error) rather than crashing if that
    // invariant is ever violated by a future change.
    return errorResponse("submission_failed", 502);
  }
  const submittedGallery = updated[0]!;

  // We won the race. The selection is durably locked in the database at
  // this point, full stop — nothing below this line ever changes that.
  //
  // The notification is best-effort, not part of the transaction. The
  // recovery path for a missed email is the photographer noticing the
  // gallery themselves: `/dashboard/galleries` (src/app/dashboard/galleries/
  // page.tsx, via `getGalleriesWithDetails`) DOES render every gallery's
  // `status` unconditionally, including `selected`. AT THE TIME this route
  // was written, that status rendered as a muted label indistinguishable in
  // weight from "Borrador", the list sorted by `createdAt` (not by who most
  // recently submitted), and `/dashboard`'s own root read no database at
  // all — so a `selected`-with-no-notification gallery was PRESENT there,
  // not HIDDEN, but not salient either; a photographer who never checked
  // that list proactively could miss it for a while. Kanban #75 was filed
  // to fix exactly that discoverability gap, and has since shipped: the
  // `selected` status now gets the studio's accent colour and a dot instead
  // of the muted treatment, `getGalleriesWithDetails` now orders by
  // recency-of-activity (`selectionSubmittedAt` falling back to
  // `createdAt`, so a stale-but-just-submitted gallery rises to the top),
  // and `/dashboard`'s root now shows an "N selecciones esperando" banner
  // driven by `getPendingSelectionCount`. The reason this route still
  // doesn't revert on a failed send remains comparative, not that the
  // dashboard solves it on its own: the ALTERNATIVE (revert to `proofing`
  // on failure, task #25's round-1 design) is strictly worse on this exact
  // axis — a reverted gallery renders as plain, unremarkable "En pruebas",
  // identical to a client who simply hasn't submitted yet, which is LESS
  // discoverable than `selected` ever is, and the client may by then have
  // closed the tab believing their submission failed when it didn't.
  // Dropping the revert dominates even under the pessimistic pre-#75
  // reading of the dashboard's state, and dominates more clearly now.
  //
  // `quota` starts as `preSubmitQuota` (already computed above, off the
  // pre-UPDATE read) and is only ever refined inside the try block below —
  // never recomputed OUTSIDE it. `preSubmitQuota` may be a hair stale if a
  // concurrent toggle landed before the UPDATE (see the empty-selection
  // comment above — same window, same accepted race; `proofing` is NOT in
  // `SELECTION_LOCKED_STATUSES` and IS client-visible, so a `PATCH
  // /api/assets/[assetId]/selection` racing this exact window is not just
  // possible, it's explicitly permitted by design). That staleness is
  // harmless here: this fallback value is only ever used if the refresh
  // below throws, in which case no email is sent either — a stale number
  // can reach the RESPONSE, never the photographer. The refresh is the
  // FIRST statement in the try and the send is later in the SAME try, so
  // "stale quota, email sent" is not a reachable outcome — only "fresh
  // quota, email sent" or "no email at all".
  let quota = preSubmitQuota;

  // Everything from the refreshed `currentQuota` read down through the
  // notification attempt is inside the SAME try block deliberately —
  // `currentQuota` issues its own `db.select`, and if the database blips in
  // that one-statement window (after the UPDATE above has already
  // committed), that exception must land in the same "best-effort, swallow
  // it" bucket as a Resend failure, not escape as an unhandled 500. The
  // submission already committed either way; a 500 here would be a
  // DISHONEST response for a request that, from the database's point of
  // view, fully succeeded — and every later call would just short-circuit
  // on the `status === "selected"` check above without ever retrying the
  // notification, so nothing is gained by failing loudly here. This is also
  // why the response below reads `quota` — the outer variable, last written
  // either by the successful refresh inside this try or left at its
  // `preSubmitQuota` fallback — rather than calling `currentQuota` a THIRD
  // time after the try/catch: that would reopen the exact unprotected
  // window this restructure exists to close.
  try {
    quota = await currentQuota(submittedGallery);

    // WHO submitted — task #94: a gallery can now have SEVERAL clients, so
    // "look up the gallery's client" (the old `eq(users.id, gallery.clientId)`
    // this replaced) no longer resolves to a single, unambiguous row — that
    // column is gone entirely (schema.ts). The session that made THIS
    // request is the one genuinely correct source for "who submitted":
    // whichever client actually clicked submit is the one this email should
    // name, not an arbitrary member of the gallery's client list. This also
    // needs no extra query and can never be "missing" the way a lookup by id
    // could — `session` is already a verified, authenticated session by the
    // time this line runs (see `requireApiSession` above). An admin
    // submitting on a client's behalf (gate 1 allows it, same as every
    // sibling route) is named honestly here too: the admin, not a client —
    // that IS who acted.
    const submittedByName = session.user.name ?? null;
    // `session.user.email` is typed optional by NextAuth's `DefaultSession`,
    // but `users.email` is NOT NULL (schema.ts) and the database session
    // strategy (src/auth.ts) populates `session.user` straight from that row
    // on every request — unreachable in practice, same stance as
    // `unlockSelection`'s own `unlockedByEmail` fallback
    // (src/app/dashboard/galleries/actions.ts) — but the fallback keeps this
    // email from silently losing the actor's address entirely if it ever did
    // happen.
    const submittedByEmail = session.user.email ?? session.user.id;

    // PLAN.md §4: a single admin. Looked up by role, never hardcoded via an
    // env var — the moment the photographer's own login address changes
    // (scripts/create-admin.ts), this keeps resolving to whoever actually
    // holds the role, with no deploy-time config to forget to update.
    const [admin] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    if (!admin) {
      throw new Error("No admin user exists to notify");
    }

    const { RESEND_API_KEY, EMAIL_FROM } = resendEnv();
    const { AUTH_URL } = authEnv();

    await sendSubmissionNotificationEmail({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: admin.email,
      clientName: submittedByName,
      clientEmail: submittedByEmail,
      galleryTitle: gallery.title,
      galleryUrl: new URL(`/dashboard/galleries/${gallery.id}`, AUTH_URL).toString(),
      quota,
    });
  } catch {
    // Swallowed on purpose — see the comment above this try block. The
    // submission already committed; this catch exists only so a Resend
    // outage (or a stray DB blip in `currentQuota`'s own read) can never
    // turn into an unhandled rejection / 500 for an action that, from the
    // database's point of view, fully succeeded.
  }

  // `quota` here is the try block's own refreshed read on the happy path,
  // or the `preSubmitQuota` fallback on the rare path where that refresh
  // itself failed and was swallowed above — see this function's own
  // comments for why the response never issues a THIRD, unprotected
  // `db.select` to get this number.
  return NextResponse.json({
    status: "submitted",
    quota,
    submittedAt: now.toISOString(),
  });
}
