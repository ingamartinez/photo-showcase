// GET /api/galleries/[galleryId]/selection — the shared selection of one
// gallery, as the server currently holds it: which photos are picked, who
// picked each of them, the recomputed quota, and whether the selection has
// been submitted (task #95).
//
// ============================================================================
// THE TRANSPORT DECISION — polling, and why, with its droplet cost
// ============================================================================
//
// Task #95 introduces the FIRST live-updating surface in this product. Before
// it there was no `EventSource`, no WebSocket, no SSE endpoint and no
// third-party realtime service anywhere in `src/` — every screen was
// server-rendered plus local state, and `src/components/gallery-workspace.tsx`
// documents a deliberate refusal to even call `router.refresh()` after a
// mutation. So the transport is a real decision, settled here the way task
// #29 settled the zip question (PLAN.md §11): measure or reason about the
// droplet cost FIRST, then choose, then write down what was chosen and what
// it costs.
//
// DECIDED: short-interval polling of this route, from
// `src/components/proof-grid.tsx`. Not SSE. Not a third-party service.
//
// The three options, weighed against the actual workload — a gallery opened
// by two or three people for twenty minutes while they argue about which
// photos to keep, on a droplet with 2 GB shared with `findash` where this app
// is capped at 768M (PLAN.md §9):
//
//   POLLING (chosen). One `GET` per viewer per `SELECTION_POLL_INTERVAL_MS`
//   (5s, see src/components/proof-grid.tsx), and only while the gallery is in
//   a status where the shared selection can still change, and only while the
//   tab is visible. For three viewers that is 0.6 requests/second, each one
//   four small indexed queries (the gallery row, the ownership row, the
//   selected assets, the pickers) over a unix socket. Nothing is retained
//   between ticks: the memory cost when nobody is looking is exactly zero,
//   which is the state this app is in almost all the time. It survives a
//   deploy, a systemd restart and Caddy's timeouts without anyone having to
//   think about it — a restart costs one failed tick, and the next tick
//   recovers with no reconnection logic to get wrong.
//
//   SSE. One-way, which is genuinely all this needs, and it is plain HTTP.
//   But it holds a connection per viewer through Caddy and Next for as long
//   as the tab is open, and this app has NO EVENT BUS to feed it: one systemd
//   process, no Redis (PLAN.md §9 is explicit that image work runs inline
//   precisely to avoid standing up a queue). So an SSE endpoint here would
//   either need an in-process `EventEmitter` that silently stops working the
//   day this runs as more than one instance, or it would poll the database
//   internally anyway — polling, with a socket held open on top and a
//   reconnection story to get right. That is the decisive argument; the
//   memory is the secondary one.
//
//   MEASURED anyway, rather than asserted, and RE-RUNNABLE — the script is
//   `scripts/measure-selection-transport.ts`, `bun run
//   measure:selection:transport`, alongside task #26's and #29's own
//   measurement scripts. It is committed precisely so these numbers can be
//   falsified: they were taken on macOS, on a bare Bun HTTP server holding
//   both ends of every socket in one process (so each per-viewer figure is
//   roughly twice the server's own share), with no Next.js per-request
//   context, no Caddy, and none of the droplet's cgroup accounting. Kanban
//   #57 is the task that re-runs it there; until then this SUPPORTS the
//   decision, it does not prove it. Median of 3 runs per configuration:
//
//     200 held SSE connections               +68.0 MiB  (348 KiB/viewer;
//                                             277 KiB/viewer marginal
//                                             between 100 and 200)
//     ...reclaimed once they all close        0% / 0% / 0%  (min/median/max
//                                             across 9 runs)
//     200 polls (one tick for 200 viewers)    +2.0 MiB retained,
//                                             0.09-3.35 ms per request
//     200 SIMULTANEOUS polls                  +1.3 MiB peak, settles back
//
//   The line that matters is the second one. Held connections ratchet RSS,
//   and effectively none of it is handed back to the OS when they close —
//   under a hard 768M cap with `max_memory_restart` (PLAN.md §9) that is a
//   floor only a restart is guaranteed to recover, whereas polling's peak is
//   transient and settles back to where it started in every run. State that
//   honestly rather than absolutely: an earlier SINGLE-SHOT version of the
//   same measurement once read ~45% reclaimed at one connection count, which
//   is exactly why the committed script repeats every configuration and
//   prints the spread instead of a sample. "Not dependably reclaimed" is the
//   claim this rests on, not "never reclaimed" — and under a hard cap that is
//   the same decision.
//
//   Two further costs surfaced in the same run rather than in production:
//   Bun's own server kills an idle stream after 10 seconds unless configured
//   otherwise, so SSE needs a keepalive timer per viewer, and Caddy has its
//   own idle timeout that would have to be verified rather than assumed.
//
//   A THIRD-PARTY REALTIME SERVICE. Removes the droplet cost entirely, and
//   adds an API key, a vendor, a second failure domain and a per-message bill
//   to a product that currently has exactly one failure domain. The same
//   argument task #29 made against the Cloudflare Worker applies verbatim:
//   this is real infrastructure, and "two people picking wedding photos
//   together" does not justify building it.
//
// The honest cost of the chosen option, stated rather than glossed: between
// two ticks the tray is up to 5 seconds stale. That is the whole downside,
// and for this use case it is invisible — the collaborators are in the same
// room or on the same phone call, and 5 seconds is faster than "did you get
// that one?" REVISIT THIS if a gallery ever routinely has ten-plus
// simultaneous viewers, or if the interval has to drop below ~2 seconds to
// feel right; at that point the arithmetic above changes and SSE earns
// itself.
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
  const quota = computeQuota(picks.length, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
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
