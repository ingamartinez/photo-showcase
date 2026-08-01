// POST /api/assets/bulk-delete — task #195: the photographer marks several
// proofs in the dashboard grid and removes them in one operation, instead of
// the browser firing N sequential `DELETE /api/assets/[assetId]` requests.
//
// WHY A NEW ENDPOINT, NOT N CLIENT-SIDE CALLS TO THE EXISTING ONE
// =================================================================
// With ~84 proofs in a gallery, marking even a modest batch for removal could
// mean dozens of round trips from the browser, each one re-running the exact
// same ownership + status-gate work the single-asset route already does, and
// a failure partway through leaves the caller unable to tell, from the
// outside, which of the N requests actually landed. One request, one
// response that accounts for every id, is both cheaper and gives the client
// something honest to reconcile its local state against (see
// gallery-workspace.tsx's own handler for how the UI does that).
//
// THE TWO GUARANTEES THIS ENDPOINT PRESERVES FROM THE SINGLE-ASSET ROUTE
// =========================================================================
// This is deliberately NOT a from-scratch implementation — it is the same
// two guarantees `../[assetId]/route.ts` already earned (see that file's own
// header for the full reasoning), applied per id in a loop rather than once:
//
//   1. THE STATUS GATE, BEFORE ANY MUTATION, PER ASSET.
//      `ASSET_MUTATION_BLOCKED_STATUSES` (src/lib/asset-access.ts) refuses a
//      `selected`/`delivered`/`archived` gallery. Checked before touching
//      that asset's row — not once for the whole batch, because a caller
//      could (in principle, if this route trusted a client-supplied gallery
//      id, which it never does — see point 2) mix ids from different
//      galleries in different states in one request.
//   2. THE ORDER: DB ROW FIRST, R2 OBJECT(S) SECOND, BEST-EFFORT. Same
//      orphan-avoidance trade-off as the single-asset route: a leaked R2
//      object costs storage nobody can ever reach again (every read path
//      resolves a key through the `assets` row, which is already gone by
//      the time a leak could happen); the reverse order risks a live row
//      pointing at a 404 in R2, visible on the next page load. Applied
//      per-asset, not once for the batch — one asset's R2 failure must not
//      block or roll back any other asset's already-committed DB delete.
//
// AUTHORIZATION IS PER ID, NOT PER REQUEST. `loadOwnedAsset()` resolves the
// gallery from EACH asset's own `galleryId` column and re-checks ownership
// every single time it's called — reused here in a loop, not read once for
// the first id and assumed for the rest. A hand-built request mixing an id
// from someone else's gallery into an otherwise-legitimate batch gets that
// one id refused, not the whole batch waved through.
//
// PARTIAL FAILURE IS A NORMAL RESPONSE SHAPE, NOT AN ERROR STATUS. This
// route always answers 200 (once the caller itself is authenticated,
// admin, and sent a well-formed body) with `{ deleted, failed }` — never a
// single pass/fail for the whole batch. A batch of 20 where 18 succeed and
// 2 are gate-blocked is not a server error; it is 18 successes and 2
// specific, attributable refusals the client can act on (see
// gallery-workspace.tsx's `handleBulkDeleted` for how the marked-set survives
// exactly this case: cleared ids disappear, failed ids stay marked).
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { ASSET_MUTATION_BLOCKED_STATUSES, loadOwnedAsset } from "@/lib/asset-access";
import { deleteObject, storedKey } from "@/lib/r2";

export const runtime = "nodejs";

// A generous but real ceiling: this endpoint still does one DB round trip
// (plus best-effort R2 deletes) per id, sequentially — see the loop below for
// why sequential, not `Promise.all`. Refusing an absurd body (a script
// looping the create-asset route and then requesting all of them deleted at
// once) before the handler ever queries is cheap; a gallery's realistic
// upload volume (PLAN.md's own "~100 photos" framing) fits comfortably
// under it.
const MAX_BULK_DELETE_IDS = 200;

const bodySchema = z.object({
  assetIds: z.array(z.uuid()).min(1, "at_least_one_id_required").max(MAX_BULK_DELETE_IDS),
});

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const POST = withApiSession(async function POST(
  request: NextRequest,
  _context: { params: Promise<Record<string, never>> },
  session,
): Promise<NextResponse> {
  // Deleting is an admin-only action — same reasoning as the single-asset
  // DELETE route right next to this one: a client must never be able to
  // delete an asset from a gallery they merely own.
  if (session.user.role !== "admin") {
    forbidden();
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse("invalid_body", 400);
  }
  const bodyResult = bodySchema.safeParse(json);
  if (!bodyResult.success) {
    return errorResponse("invalid_body", 400);
  }

  // Deduplicated, defensively: a repeated id in the body must not be counted
  // (or attempted) twice.
  const assetIds = [...new Set(bodyResult.data.assetIds)];

  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];

  // SEQUENTIAL, not `Promise.all`: each iteration's own status-gate check and
  // DB delete must observe a consistent world, and — same reasoning
  // reorder/route.ts gives for its own two UPDATEs not needing a
  // transaction — the assets table carries no invariant across DIFFERENT
  // assets' rows that a concurrent batch of independent single-row deletes
  // could violate. Sequential is simply the easiest shape to reason about
  // and to test the ordering guarantee (point 2 above) against.
  for (const assetId of assetIds) {
    const lookup = await loadOwnedAsset(assetId, session);
    if (!lookup.ok) {
      failed.push({ id: assetId, error: lookup.error });
      continue;
    }
    const { asset, gallery } = lookup;

    // The status gate, checked BEFORE any mutation for THIS asset — see the
    // file header and src/lib/asset-access.ts's own comment on the constant.
    if (ASSET_MUTATION_BLOCKED_STATUSES.has(gallery.status)) {
      failed.push({ id: assetId, error: "gallery_locked" });
      continue;
    }

    await db.delete(assets).where(eq(assets.id, asset.id));

    // Best-effort, only after the row is gone — same ordering, and the same
    // reasoning for which side is allowed to leak, as ../[assetId]/route.ts.
    await deleteObject(storedKey(asset.proofKey)).catch(() => {});
    if (asset.finalKey) {
      await deleteObject(storedKey(asset.finalKey)).catch(() => {});
    }

    deleted.push(assetId);
  }

  return NextResponse.json({ deleted, failed });
});
