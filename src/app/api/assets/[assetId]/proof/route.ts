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
// asset belongs to, they may see every proof in it, at any gallery status.
// There is no additional "has this been delivered" or "was this selected"
// gate here — proofing IS the stage where the client is meant to be looking
// at every proof to decide what to select.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { getPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  // Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts). This
  // MUST be an early return on the `instanceof NextResponse` branch — task
  // #16's carried-over note from the #45 review: `requireApiSession()`
  // returns a union rather than throwing, and a caller that discards the
  // result here is silently unguarded.
  const sessionOrResponse = await requireApiSession();
  if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
  const session = sessionOrResponse;

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

  const url = getPresignedUrl(lookup.asset.proofKey);
  return NextResponse.json({ url });
}
