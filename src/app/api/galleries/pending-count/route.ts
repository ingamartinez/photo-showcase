// GET /api/galleries/pending-count — task #174: the single number behind the
// dashboard nav's pending-review badge (src/components/dashboard-nav.tsx),
// fetched fresh on every call, never cached, never pushed.
//
// ============================================================================
// WHY THIS EXISTS AT ALL — the layout that never re-runs
// ============================================================================
//
// `src/app/dashboard/layout.tsx` renders `<DashboardNav>` exactly once and
// does not re-render it on navigation between `/dashboard`, `/dashboard/
// clients` and `/dashboard/galleries` — a Next.js layout does not re-run
// between sibling routes inside it. Worse, the count this badge shows can
// change from OUTSIDE any admin request entirely: `POST /api/galleries/
// [galleryId]/submit-selection` moves a gallery `proofing -> selected` (the
// direction that matters most — see that route's own header comment), and it
// runs as a Route Handler invoked by the CLIENT's browser, in the client's
// own session. No `revalidatePath` inside that route, however it were typed,
// could ever reach an admin tab that is already open in a different browser
// on a different machine. A badge with no mechanism to refresh itself would
// just go stale in the direction that costs the most: "1 esperando" while
// three galleries actually wait.
//
// ============================================================================
// POLLING, NOT A PUSH TRANSPORT — decided here, not left to be re-derived
// ============================================================================
//
// This app already has a push transport for exactly this shape of problem —
// `src/lib/selection-events.ts`, Postgres LISTEN/NOTIFY fanning out to SSE
// (`../[galleryId]/selection/stream/route.ts`, task #114). This route
// deliberately does NOT reuse it, for three reasons, not one:
//
// 1. WHERE THE COUNT ACTUALLY CHANGES. `getPendingSelectionCount()`
//    (`@/lib/galleries`) counts galleries in status `selected` — a count that
//    moves at THREE write paths: `submit-selection/route.ts` (this territory,
//    `proofing -> selected`), and `unlockSelection`/`deliverGallery` in
//    `src/app/dashboard/galleries/actions.ts` (`selected -> proofing` and
//    `selected -> delivered`). That file is a SIBLING lane's exclusive
//    territory for this slice (the dashboard-pages sweep, epic #125) — this
//    slice cannot add a `notifyPendingCountChanged()` call there. Even
//    setting ownership aside: hanging correctness on "every current AND
//    future write path that can move a gallery in or out of `selected`
//    remembers to call the notifier" is exactly the fragility
//    `selection-events.ts`'s own header comment accepts as a KNOWN, bounded
//    risk for its narrower one-gallery problem (a forgotten call there
//    degrades to a 30s fallback poll, still bounded). For a chrome-wide
//    badge with no natural single owner across three call sites in two
//    different files, that same risk has no proportionate upside: a poll
//    that reads the derived truth directly can never be missed by a write
//    path that forgot to announce itself, because it never depends on being
//    told — it asks.
//
// 2. THE OPERATIONAL COST, MEASURED AGAINST A LIVE INVESTIGATION. Task #173
//    (open, unresolved) is chasing an intermittent SIGKILL on shutdown,
//    correlated — weakly, n=5, explicitly not yet a conclusion — with
//    releases that touch `src/`, and the leading untested hypothesis is open
//    SSE connections at stop time. This badge is rendered by `DashboardNav`,
//    mounted for the ENTIRE lifetime of any tab open under `/dashboard/**`
//    (PLAN.md §4: one admin, but that admin can and does leave a tab open all
//    day). A per-admin SSE channel would add ONE MORE long-lived connection
//    per open dashboard tab, for as long as the tab stays open, on the exact
//    resource category under suspicion, before that investigation has even
//    measured a baseline. Polling adds no long-lived connection at all: every
//    tick is a plain HTTP request this route answers and closes immediately.
//    On redeploy, an in-flight poll is NOT simply dropped — verified against
//    `next/dist/server/lib/start-server.js` (:335-344): `server.close()`
//    AWAITS every in-flight request before the process exits, the same as
//    any other short-lived route, and `closeAllConnections()` (which WOULD
//    force a socket shut) is gated on `isDev` — it never runs in production.
//    The reason this is still cheap is not "nothing waits for it", it is that
//    what it waits for is short: one indexed `COUNT` query finishes in
//    milliseconds, nowhere near the 10s `TimeoutStopSec` (task #173). An SSE
//    response is the opposite case — it is BY DESIGN a request that never
//    finishes on its own, which is what actually exhausts that timeout and
//    forces the `SIGKILL` #173 is investigating; this route never opens one.
//
// 3. WHAT THIS BADGE ACTUALLY NEEDS. It is an informational count for a
//    SINGLE admin (PLAN.md §4), not a collaborative view multiple people
//    reconcile in real time — the class of problem SSE earns its keep on
//    elsewhere in this app (`proof-grid.tsx`'s shared selection, "two people
//    editing pick a photo apart"). A brief, bounded delay between "a client
//    submitted" and "the badge shows it" costs nothing this product
//    promises; see `PENDING_COUNT_POLL_INTERVAL_MS` below for the number
//    chosen and why.
//
// Worst-case connection count this route's own design adds: ZERO long-lived.
// Worst-case REQUEST volume: one admin, realistically one to a handful of
// open tabs, each issuing one short GET per poll tick — see
// `src/components/dashboard-nav.tsx`'s own header comment for the client
// half and its poll interval's reasoning.
import { NextResponse, type NextRequest } from "next/server";
import { forbidden } from "next/navigation";
import { withApiSession } from "@/lib/auth-guards";
import { getPendingSelectionCount } from "@/lib/galleries";

export const runtime = "nodejs";

// Never cached — the whole point of a poll is that each tick reflects
// whatever is true in the database at the moment it fires, same reasoning as
// the sibling `[galleryId]/selection` route's own `force-dynamic`.
export const dynamic = "force-dynamic";

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const GET = withApiSession(async function GET(
  _request: NextRequest,
  _context: { params: Promise<Record<string, never>> },
  session,
): Promise<NextResponse> {
  // Signed in but not admin -> 403. `forbidden()` (not `requireAdmin()`,
  // which redirects an unauthenticated caller to `/login` instead of
  // returning 401 JSON) — same pattern as every other admin-only Route
  // Handler in this codebase (e.g. `assets/[assetId]/final/route.ts`'s own
  // POST). This count is aggregate, studio-wide data with no gallery id to
  // scope an ownership check against, so "admin" is the entire guard — a
  // client has no legitimate reason to learn how many OTHER clients'
  // galleries are waiting on the photographer.
  if (session.user.role !== "admin") {
    forbidden();
  }

  const count = await getPendingSelectionCount();
  return NextResponse.json({ count });
});
