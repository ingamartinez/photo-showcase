// GET /api/galleries/[galleryId]/selection — the shared selection of one
// gallery, as the server currently holds it: which photos are picked, who
// picked each of them, the recomputed quota, and whether the selection has
// been submitted (task #95). This is now ALSO the route every open session
// re-fetches from the instant it is told something changed (task #114's SSE
// stream, `./stream/route.ts`) — see below.
//
// ============================================================================
// THE TRANSPORT DECISION — CORRECTED (task #114): pushed, off Postgres
// LISTEN/NOTIFY, this route as the fetch target, polling kept as a fallback
// ============================================================================
//
// Task #95 (below, unchanged as a HISTORICAL record of what it measured and
// why) chose polling and rejected SSE on the grounds that "this app has no
// event bus" — an in-process `EventEmitter` would silently stop working the
// day this ran as more than one instance, and an SSE endpoint that polled the
// database internally would just be polling with a socket held open on top.
// Both of those specific rejections were correct. The CONCLUSION drawn from
// them was not: this app has run Postgres since Phase 0, and LISTEN/NOTIFY IS
// an event bus this product already owns and already pays for — `postgres`
// was already `^3.4.9`, `sql.listen()`/`sql.notify()` are native to it, and no
// new dependency was needed to use them. It is also STRICTLY BETTER than the
// `EventEmitter` shape #95 also rejected, on the exact axis #95 used to
// reject it: a `NOTIFY` reaches every instance LISTENing on the channel, so
// this gets MORE correct under scaling to more than one systemd process, not
// less. Task #114 is the slice that corrects this record and builds the real
// thing, at the owner's explicit request after confirming #95 worked but felt
// laggy (~5s) in production — see that task's own kanban body for why the
// cheap fix (lowering `SELECTION_POLL_INTERVAL_MS`) was offered and declined.
//
// WHAT ACTUALLY CHANGED: `src/components/proof-grid.tsx` now opens
// `GET /api/galleries/[galleryId]/selection/stream` (an `EventSource`,
// `./stream/route.ts`) whenever the gallery is in a status where the shared
// selection can still change. That stream carries no data of its own — see
// its own header comment and `src/lib/selection-events.ts`'s for why — only a
// `changed` signal, which is what triggers THIS route to be fetched, and a
// `ready` signal on every connect/reconnect, which is what makes a client
// recover from a signal it could have missed while disconnected (Postgres
// NOTIFY is not durable). This route's own guard, response shape, and
// ownership check are UNCHANGED by any of this — it was already the single
// place both the first server-rendered paint and every live refresh get their
// data from (see this file's other header notes below), and task #114
// deliberately kept it that way rather than inventing a second way to read
// the same state.
//
// WHETHER POLLING SURVIVES: yes, as a long-interval FALLBACK, not removed.
// `SELECTION_POLL_INTERVAL_MS` (src/components/proof-grid.tsx) is now 30
// seconds instead of #95's 5 — active the whole time the SSE stream is meant
// to be open, independent of whether it currently IS. This is the backstop
// for a failure mode the stream cannot self-report: a corporate proxy or
// browser extension that silently drops an `EventSource` without ever firing
// its `error` handler. Removing polling entirely would make that unbounded;
// keeping it at #95's 5s would be needless waste now that push carries the
// normal case. 30s bounds the worst case at six times less request volume
// than #95 shipped with, for the (now rare) case where it's actually needed.
//
// See `./stream/route.ts`'s own header comment for the guard proof and the
// heartbeat/idle-timeout reasoning, and `src/lib/selection-events.ts`'s for
// where NOTIFY fires (an application call at each of the three write paths
// that can change this — a toggle, a submit, an admin unlock — not a
// database trigger, and why), the fan-out shape (one LISTEN connection per
// app instance, not per viewer), and how a dropped/reconnected LISTEN
// connection recovers.
//
// ============================================================================
// TASK #95's ORIGINAL MEASUREMENT — kept verbatim as a historical record,
// NOT as the current architecture (see the correction above)
// ============================================================================
//
// This is the reasoning and the numbers that made polling the right call
// BEFORE this app had a way to feed SSE anything real. They are not wrong as
// measurements — held connections really did cost what they say, and really
// did not reliably give it back — they were simply answering a question
// ("is SSE worth it against an EventEmitter or a self-polling endpoint") that
// task #114 replaced with a different, better-supported design. Kept here
// rather than deleted because the numbers below are still the best available
// evidence for "what does holding N SSE connections cost this droplet",
// which task #114's own design still has to reason about (a stream is held
// open per viewer regardless of what feeds it) — see
// `scripts/measure-selection-transport.ts` for the arm task #114 added on
// top of these.
//
//   200 held SSE connections               +68.0 MiB  (348 KiB/viewer;
//                                           277 KiB/viewer marginal
//                                           between 100 and 200)
//   ...reclaimed once they all close        0% / 0% / 0%  (min/median/max
//                                           across 9 runs)
//   200 polls (one tick for 200 viewers)    +2.0 MiB retained,
//                                           0.09-3.35 ms per request
//   200 SIMULTANEOUS polls                  +1.3 MiB peak, settles back
//
// Re-framed rather than repeated (task #114's own kanban body): 200
// concurrent viewers is not this product. Realistic concurrency is two to
// five people in one gallery — at ~350 KiB/viewer that is one to two MiB, so
// memory never actually ruled out SSE at this scale; what ruled it out was
// the absence of a real event source, which task #114 supplies. The ratchet
// is still real, though, and still worth carrying forward: RSS taken by held
// connections does not reliably come back (measured, not assumed — an
// earlier single-shot version of this same measurement once read ~45%
// reclaimed at one connection count, which is exactly why the committed
// script repeats every configuration and prints the spread instead of a
// sample), so under a hard 768M `MemoryMax` (PLAN.md §9) a burst of viewers
// still raises a floor only a restart recovers. Affordable at five viewers;
// not free.
//
// ============================================================================
// THE GUARD
// ============================================================================
//
// A live channel is a data path and gets the same lock as every other route:
// `withApiSession` (never a redirect, always 401 JSON), then
// `isGalleryOwner` (src/lib/gallery-access.ts — THE one ownership check, the
// same function the page, the submit route and `loadOwnedAsset` all call),
// then the non-admin visibility gate. This route deliberately does NOT invent
// a lighter check because it is "just a read of state the client already has":
// it returns other people's names and the gallery's commercial numbers, and a
// signed-in stranger with a gallery id must get nothing. Proven at this route,
// not only at the helper — see route.test.ts, which exercises the REAL
// `isGalleryOwner` against a seeded `gallery_clients` table rather than
// mocking it, including the soft-removed client case (task #97).
//
// NO PRESIGNED URLS, NO R2 KEYS. The tray renders thumbnails from the map
// `<ProofGrid>` already holds, keyed by asset id. This route hands back ids
// and attribution only — task #95's constraint that the tray must not become
// a second way to obtain image bytes.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleries } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { isGalleryOwner } from "@/lib/gallery-access";
import { getGallerySelection } from "@/lib/gallery-selection";
import { computeQuota } from "@/lib/quota";

export const runtime = "nodejs";

// Never cached, at any layer. A snapshot of who picked what is the one thing
// in this app that must not be served from a cache — a 30-second CDN or
// router cache would make the tray confidently wrong, which is worse than the
// tray being visibly stale (see <SelectionTray>'s own degradation copy).
export const dynamic = "force-dynamic";

const galleryIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const GET = withApiSession(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
  session,
): Promise<NextResponse> {
  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) {
    return errorResponse("invalid_gallery_id", 400);
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, galleryIdResult.data))
    .limit(1);
  if (!gallery) {
    return errorResponse("gallery_not_found", 404);
  }

  // Gate 1 — ownership. Identical to the sibling submit-selection route's own
  // gate, down to the 403-not-404: the gallery id is a random UUID
  // (schema.ts), so confirming it exists leaks nothing walkable.
  const isAdmin = session.user.role === "admin";
  if (!(await isGalleryOwner(gallery.id, session))) {
    return errorResponse("forbidden", 403);
  }

  // Gate 2 — visibility (non-admin only). A `draft` gallery is not yet
  // visible to its own clients (PLAN.md §2), so its selection state is not
  // either; same 404 the page and both selection routes already use for this
  // case.
  if (!isAdmin && !isGalleryVisibleToClient(gallery.status)) {
    return errorResponse("gallery_not_found", 404);
  }

  const picks = await getGallerySelection(gallery.id);

  // `picks.length` IS the derived count (PLAN.md §3) — the same rows, counted
  // once. Off the gallery's own FROZEN snapshot terms, never the live
  // `packages` row: a gallery created under last year's price list keeps last
  // year's numbers forever.
  //
  // Task #206 — `getGallerySelection()` now carries each pick's own
  // `selectionKind`, so the edited/original split the included-photos quota
  // needs comes straight off THIS list, not a second read. Anything that
  // isn't literally `"original"` counts as edited — matching
  // `assets.selectionKind`'s own `notNull().default("edited")` (schema.ts):
  // `edited` is the domain's default, so a pick this route somehow can't
  // interpret falls back to the same value the column itself would.
  const selectedOriginal = picks.filter((pick) => pick.selectionKind === "original").length;
  const selectedEdited = picks.length - selectedOriginal;
  const quota = computeQuota(selectedEdited, selectedOriginal, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
  });

  return NextResponse.json({
    // THE SUBMIT LOCK, live. `<ProofGrid>` derives its read-only state from
    // this status on every tick, so the moment ONE client submits, every
    // other open session stops accepting picks without a reload — the most
    // damaging failure this screen could have is a collaborator cheerfully
    // picking into a gallery that is already submitted, and this field is
    // what closes it. The status is the SERVER's, so this converges in both
    // directions: an admin unlocking a submitted selection (task #73) reopens
    // every open tab on the next tick just as surely as a submit closes them.
    status: gallery.status,
    submittedAt: gallery.selectionSubmittedAt ? gallery.selectionSubmittedAt.toISOString() : null,
    quota,
    picks,
  });
});
