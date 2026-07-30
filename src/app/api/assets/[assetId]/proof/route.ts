// GET /api/assets/[assetId]/proof — the ONLY way a proof image's bytes ever
// reach a browser (task #16, the security core of the media pipeline).
//
// R2 objects are private (PLAN.md §5's "Serving" rule): this route verifies
// the session owns the gallery the asset belongs to, then hands back a
// short-lived presigned GET URL. The droplet never streams image bytes
// itself. See src/lib/asset-access.ts for why the gallery is resolved FROM
// the asset row and never from a client-supplied gallery id.
//
// Proofs carry the SIMPLER of the two access rules in this app (see
// .../final/route.ts for the other one): once a client owns the gallery an
// asset belongs to, they may see every proof in it, in every status a
// non-admin can even reach.
//
// That last clause matters (task #63): a `draft` gallery is one the
// photographer has NOT decided to show yet, and `/galleries/[publicSlug]`
// (src/app/galleries/[publicSlug]/page.tsx) already 404s a client who tries
// to view one, via `isGalleryVisibleToClient()` in src/lib/galleries.ts.
// Before #63 this route had no equivalent gate, so a client holding an
// asset id from their own draft gallery could still fetch a presigned URL
// for it — the API disagreeing with the page about what "not shown yet"
// means. This route calls the SAME `isGalleryVisibleToClient()` the page
// uses (never a second, hand-rolled copy of its status list) so the two
// can't drift apart again. Admins bypass this gate entirely — task #20's
// admin workspace previews `draft` galleries constantly, by design.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { getPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const GET = withApiSession(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
  session,
): Promise<NextResponse> {
  const { assetId: rawAssetId } = await params;
  const assetIdResult = assetIdSchema.safeParse(rawAssetId);
  if (!assetIdResult.success) {
    return errorResponse("invalid_asset_id", 400);
  }

  // Loads the asset, resolves its gallery from the asset row itself, and
  // checks ownership — see asset-access.ts for why a gallery id is never
  // accepted from the client here. Knowing an asset id is not, by itself,
  // sufficient to reach this point.
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // The status gate task #63 adds: mirrors the page's own gate exactly (see
  // the file header), and only for non-admins — an admin has already passed
  // `loadOwnedAsset()`'s "admin sees everything" ownership check above and
  // must keep seeing every proof regardless of gallery status.
  if (session.user.role !== "admin" && !isGalleryVisibleToClient(gallery.status)) {
    return errorResponse("gallery_not_visible", 404);
  }

  const url = getPresignedUrl(asset.proofKey);
  return NextResponse.json({ url });
});
