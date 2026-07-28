// GET /api/assets/[assetId]/final — the ONLY way a final image's bytes ever
// reach a browser (task #16, the security core of the media pipeline).
//
// Same ownership check as .../proof/route.ts (session must own the gallery
// the asset belongs to, resolved FROM the asset row — see
// src/lib/asset-access.ts), PLUS an extra, stricter gate: PLAN.md §2/§5 says
// a final exists "only for selected assets, after editing", and task #16
// spells out the enforcement point explicitly — "Finals are only served for
// assets that are actually selected AND delivered." Proofs and finals are
// deliberately different access rules; owning the gallery is necessary for
// both but only sufficient for the proof.
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

  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // The final-specific gate. Checked as three independent conditions rather
  // than inferring any one from another:
  //   - `asset.isSelected` — the client actually picked this photo. An owner
  //     must not be able to fetch a final for an asset they never selected
  //     just because the photographer happened to edit and upload one
  //     anyway (e.g. a mistaken upload, or a future bulk-edit workflow).
  //   - `gallery.status === "delivered"` — the photographer has finished
  //     editing and explicitly delivered the gallery (PLAN.md §2's state
  //     machine). A selected-but-not-yet-delivered asset's final must stay
  //     unreachable even if it happens to already be sitting in R2, since
  //     "delivered" is the point the client is meant to be told about.
  //   - `asset.finalKey` — the R2 object actually exists (set only by the
  //     admin's final-upload route in a later slice). Not treated as
  //     sufficient on its own for the first two checks below: a stray
  //     finalKey must never unlock delivery of an unselected or
  //     pre-delivery asset by itself.
  // All three together, not any one alone, is "actually selected AND
  // delivered" per task #16's acceptance criterion.
  if (!asset.isSelected || gallery.status !== "delivered" || !asset.finalKey) {
    return errorResponse("final_not_available", 404);
  }

  const url = getPresignedUrl(asset.finalKey);
  return NextResponse.json({ url });
}
