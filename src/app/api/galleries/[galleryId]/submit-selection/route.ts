// POST /api/galleries/[galleryId]/submit-selection — the client's "these
// ones" moment (task #25), per PERSON since epic #239: it locks ONLY the
// caller's `gallery_clients` row (`selectionLockedAt` + `selectionSubmittedAt`)
// and notifies the admin. The gallery itself moves `proofing -> selected`
// only when that submission leaves EVERY active client locked
// (`settleGalleryLockStatus`, src/lib/gallery-client-locks.ts) — so a
// single-client gallery behaves exactly as it did when the lock was
// gallery-wide, and in a group gallery the others keep picking until they
// submit too.
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
// REOPEN POLICY (task #25, now per person): once a client is locked they can
// never toggle or resubmit — see the PATCH /api/assets/[assetId]/selection
// route, which refuses a locked caller (`client_selection_locked`) and refuses
// anyone undoing a locked client's pick (`pick_locked`). Only an ADMIN can
// reopen, from the dashboard — a deliberate, asymmetric human escape hatch.
// The submitted selection is the evidence a real payment conversation
// (extras, surcharge — settled outside the app, PLAN.md §3) gets built on, so
// it must freeze; "the client changed their mind" is a phone call, not a
// client-facing "undo" button.
//
// ADMIN CALLERS ARE REFUSED (409 `admin_cannot_submit`). An admin has no
// `gallery_clients` row, so there is no membership to lock; locking people on
// their behalf is the dashboard's per-client action (slice #242), which reuses
// the same helper.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleries, galleryClients, users } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { isGalleryOwner } from "@/lib/gallery-access";
import { authEnv, resendEnv } from "@/lib/env";
import { sendSubmissionNotificationEmail } from "@/lib/admin-notification-email";
import { getClientLock, lockGalleryRow, settleGalleryLockStatus } from "@/lib/gallery-client-locks";
import { computeQuota, type QuotaResult } from "@/lib/quota";
import { notifySelectionChanged } from "@/lib/selection-events";

export const runtime = "nodejs";

const galleryIdSchema = z.uuid();

// Task #244 — thrown inside the rolling-delivery transaction when the cart
// turned out empty, so Drizzle rolls back the submit-timestamp refresh too.
class EmptyCartError extends Error {}

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
    .select({ isSelected: assets.isSelected, selectionKind: assets.selectionKind })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  const selectedSiblings = siblings.filter((row) => row.isSelected);
  // Task #206 — split by kind, off the SAME re-read: the included-photos
  // quota only ever applies to `edited` picks (src/lib/quota.ts's own header
  // comment). This is the quota the client's confirmation dialog and the
  // admin notification email both end up showing, so it must reflect
  // whatever the client actually marked, not assume every pick is edited the
  // way task #205 (before this slice) still did.
  const selectedOriginal = selectedSiblings.filter(
    (row) => row.selectionKind === "original",
  ).length;
  const selectedEdited = selectedSiblings.length - selectedOriginal;
  return computeQuota(selectedEdited, selectedOriginal, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
    extraPhotoPriceTiersSnapshot: gallery.extraPhotoPriceTiersSnapshot,
    originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
  });
}

async function idempotentResponse(
  gallery: Gallery,
  submittedAt: Date | null,
): Promise<NextResponse> {
  const quota = await currentQuota(gallery);
  return NextResponse.json({
    status: "already_submitted",
    quota,
    // The CALLER's own submission time, not the gallery's.
    submittedAt: submittedAt ? submittedAt.toISOString() : null,
    gallerySelected: gallery.status === "selected",
  });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const POST = withApiSession(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
  session,
): Promise<NextResponse> {
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

  // Only `proofing` and `selected` can hold a submission at all: `draft` is
  // reachable only by an admin preview (gate 2 already refused a client), and
  // `delivered`/`archived` are further along than submission even matters
  // for. PLAN.md §2's state machine is linear.
  if (gallery.status !== "proofing" && gallery.status !== "selected") {
    return errorResponse("gallery_not_submittable", 409);
  }

  // An admin has no membership to lock — see the header comment.
  if (isAdmin) {
    return errorResponse("admin_cannot_submit", 409);
  }

  // The caller's OWN lock. `isGalleryOwner` already proved an active
  // membership, so `null` here can only mean it was removed in the gap
  // between the two reads — refused like any non-owner.
  const ownLock = await getClientLock(db, gallery.id, session.user.id);
  if (!ownLock) {
    return errorResponse("forbidden", 403);
  }

  // Idempotent double-submit: THIS caller is already locked — a second click,
  // or a second tab, after a first submission that succeeded. No mutation, no
  // email, a calm 200 that reflects reality (kanban #61's guidance): they ARE
  // submitted; it just was not this call that did it.
  if (ownLock.lockedAt) {
    return idempotentResponse(gallery, ownLock.submittedAt);
  }

  // The gallery is `selected` but THIS client is still open — only reachable
  // for a client attached after the gallery closed (re-attaching leaves them
  // unlocked, see attachGalleryClients). They cannot pick either (the PATCH
  // route refuses every write in a `selected` gallery), so there is nothing
  // for them to submit until an admin reopens the gallery.
  if (gallery.status === "selected") {
    return errorResponse("gallery_not_submittable", 409);
  }

  // Submitting an EMPTY selection is refused (task #25's own acceptance
  // criterion) — and "empty" is about the CALLER's own picks
  // (`selected_by = caller`): in a group gallery, someone else's picks must
  // not let a client who chose nothing lock themselves out. The quota the
  // response reports stays gallery-wide (epic #239: quota is NOT per person).
  // Checked BEFORE the transaction, off a fresh read; a client deselecting
  // their last photo in another tab inside that window is the same accepted,
  // tiny race the proofs route's `sort_order` assignment tolerates.
  const preSubmitQuota = await currentQuota(gallery);
  const ownPicks = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.galleryId, gallery.id),
        eq(assets.isSelected, true),
        eq(assets.billedTo, session.user.id),
        // Task #244 — under rolling delivery a submit acts on the CART: own
        // picks not yet ordered. An all-requested cart is empty: same 400.
        ...(gallery.rollingDelivery ? [isNull(assets.requestedAt)] : []),
      ),
    );
  if (ownPicks.length === 0) {
    return errorResponse("empty_selection", 400);
  }

  // THE atomicity guard. Everything that decides the outcome happens inside
  // ONE transaction that first takes the GALLERY ROW's write lock
  // (`lockGalleryRow`): two clients submitting last at the same moment each
  // lock their own membership row, so without that serialization both would
  // read the other as still open and the gallery would never close. With it,
  // the second transaction's membership read starts after the first
  // committed, and `settleGalleryLockStatus`'s compare-and-swap on `status`
  // guarantees exactly ONE `proofing -> selected` transition (kanban #61's
  // stance: guard the UPDATE itself with a `WHERE`, never reorder around it).
  const now = new Date();
  let outcome;
  try {
    outcome = await runSubmitTransaction();
  } catch (error) {
    if (error instanceof EmptyCartError) return errorResponse("empty_selection", 400);
    throw error;
  }

  function runSubmitTransaction() {
    return db.transaction(async (tx) => {
      const fresh = await lockGalleryRow(tx, gallery.id);
      if (!fresh || fresh.status !== "proofing") {
        return { kind: "not_proofing" as const, gallery: fresh ?? gallery };
      }

      // Task #244 — ROLLING DELIVERY: submitting places an ORDER, not a lock.
      // The membership update runs FIRST: it matches only an ACTIVE, unlocked
      // client (`isNull(lockedAt)` keeps an admin-locked or removed client out;
      // the pre-check above already answered those idempotently), and when it
      // matches nothing we return BEFORE any asset is written. Drizzle commits
      // a normally-returning callback, so returning after the stamps would have
      // committed them. THEN ONE conditional UPDATE stamps `requested_at` on
      // exactly THIS client's cart (the `selected_by` predicate keeps other
      // people's cart picks untouched, `requested_at IS NULL` keeps earlier
      // orders' original stamps). If the cart emptied meanwhile (another tab)
      // the callback THROWS, rolling back the timestamp refresh too.
      // `selection_locked_at` stays NULL (the client keeps picking and may
      // submit again) and `settleGalleryLockStatus` never runs, so the gallery
      // never auto-moves to `selected` from client submits.
      if (fresh.rollingDelivery) {
        const refreshed = await tx
          .update(galleryClients)
          .set({ selectionSubmittedAt: now })
          .where(
            and(
              eq(galleryClients.galleryId, gallery.id),
              eq(galleryClients.userId, session.user.id),
              isNull(galleryClients.removedAt),
              isNull(galleryClients.selectionLockedAt),
            ),
          )
          .returning({ userId: galleryClients.userId });
        if (refreshed.length === 0) {
          return { kind: "lost_race" as const, gallery: fresh };
        }
        const stamped = await tx
          .update(assets)
          .set({ requestedAt: now })
          .where(
            and(
              eq(assets.galleryId, gallery.id),
              eq(assets.isSelected, true),
              eq(assets.billedTo, session.user.id),
              isNull(assets.requestedAt),
            ),
          )
          .returning({ id: assets.id });
        if (stamped.length === 0) throw new EmptyCartError();
        return {
          kind: "submitted" as const,
          gallery: fresh,
          transition: null,
          requestedCount: stamped.length,
        };
      }

      // CAS on the membership: only the call that flips `selection_locked_at`
      // from NULL gets a row back, so a double-click that raced past the
      // pre-check above still sends exactly one email.
      const locked = await tx
        .update(galleryClients)
        .set({ selectionLockedAt: now, selectionSubmittedAt: now, selectionLockedBy: "client" })
        .where(
          and(
            eq(galleryClients.galleryId, gallery.id),
            eq(galleryClients.userId, session.user.id),
            isNull(galleryClients.removedAt),
            isNull(galleryClients.selectionLockedAt),
          ),
        )
        .returning({ userId: galleryClients.userId });
      if (locked.length === 0) {
        return { kind: "lost_race" as const, gallery: fresh };
      }

      const transition = await settleGalleryLockStatus(tx, gallery.id);
      return { kind: "submitted" as const, gallery: fresh, transition };
    });
  }

  if (outcome.kind === "not_proofing" || outcome.kind === "lost_race") {
    // Somebody moved the gallery (or this very membership) between our reads
    // and the lock. Reflect reality: if the caller is locked now, it is the
    // idempotent answer; otherwise the gallery is simply not submittable.
    const latest = await getClientLock(db, gallery.id, session.user.id);
    if (latest?.lockedAt) {
      return idempotentResponse(outcome.gallery, latest.submittedAt);
    }
    return errorResponse("gallery_not_submittable", 409);
  }

  const gallerySelected = outcome.transition === "selected";
  const submittedGallery = outcome.gallery;

  // We won. The caller's lock is durably committed at this point, full stop —
  // nothing below this line ever changes that.

  // Task #114 — every OTHER open session converges the instant this commits
  // (the gallery status when this was the LAST client to submit, the locked
  // picker set either way), instead of waiting up to a poll tick.
  // Fire-and-forget, same reasoning as the sibling PATCH route's own call:
  // the lock above already committed, and this must never delay or fail a
  // response that already succeeded.
  void notifySelectionChanged(submittedGallery.id).catch(() => {
    // Swallowed — see src/lib/selection-events.ts's own header comment; the
    // 30s fallback poll is the backstop.
  });
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
  // on the caller's `lockedAt` check above without ever retrying the
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
    // time this line runs (`withApiSession` only invokes this handler once
    // the check has passed, so `session` cannot be a NextResponse). Since
    // epic #239 this is sent once PER CLIENT submission, not once per
    // gallery: the photographer learns that Ana is done even while Beto is
    // still choosing, which is the point of the per-person lock. An admin
    // never reaches this line (refused above).
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
      // Task #244: only the rolling-delivery order carries a count.
      ...("requestedCount" in outcome ? { requestedCount: outcome.requestedCount } : {}),
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
    // The CALLER's own submission time (their `selectionSubmittedAt`).
    submittedAt: now.toISOString(),
    // Whether this submission was the one that closed the gallery.
    gallerySelected,
    // Task #244 — how many photos THIS call actually stamped (rolling
    // delivery only). The client marks picks as ordered only when this is
    // positive; the idempotent 200 above carries no such field.
    ...("requestedCount" in outcome ? { requestedCount: outcome.requestedCount } : {}),
  });
});
