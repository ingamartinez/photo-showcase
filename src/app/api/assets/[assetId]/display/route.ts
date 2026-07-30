// GET /api/assets/[assetId]/display — task #89: the browsing-sized,
// UNWATERMARKED version of a delivered photo, for the client's grid and
// lightbox. A client who has paid and received their gallery should stop
// seeing the watermark on what they LOOK at, not only on what they save.
//
// This is the third read route in the family, and the differences between
// the three are the whole point:
//   - .../proof   — watermarked, 1600px. Any owner, any client-visible
//                   gallery status. The default.
//   - .../final   — unwatermarked, FULL resolution, `Content-Disposition:
//                   attachment`. The paid deliverable, for saving.
//   - .../display — unwatermarked, 1600px, served INLINE. The paid
//                   deliverable at the size a phone should actually load.
//
// The gate is not "like" the download's, it IS the download's: both call
// `canReadFinalDeliverable` (src/lib/final-access.ts), which is the only
// place the four conditions and the admin carve-out exist. There is
// deliberately no second, looser path to unwatermarked bytes here — that
// would hand a client the whole point of the watermark for free, one HTTP
// request before they paid.
//
// Why serving `finalKey` here instead would have been wrong (task #89 says
// this explicitly): finals are ~4000x2667 multi-MB JPEGs, so a twenty-photo
// gallery would be roughly 100 MB of page load, on the phone where most
// clients open this. The WATERMARK was the problem; the proof's DIMENSIONS
// never were. `processDisplay` (src/lib/images.ts) caps this derivative at
// the same `PROOF_MAX_LONG_EDGE` a proof uses.
//
// This route exists for the REFRESH path, not the first paint: the client
// gallery page (src/app/galleries/[publicSlug]/page.tsx) presigns display
// URLs itself at render time, exactly as it already does for proofs. This is
// what <ProofGrid> calls when one of those URLs has aged past
// `PRESIGNED_URL_TTL_SECONDS` — the same one-shot, on-demand re-sign the
// proof route already serves, so a client browsing for longer than five
// minutes never sees a broken image.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { canReadFinalDeliverable } from "@/lib/final-access";
import { displayKey, getPresignedUrl, objectExists } from "@/lib/r2";

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

  // Ownership, resolved from the asset row's own galleryId — never from
  // anything the caller supplied. See src/lib/asset-access.ts.
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // THE gate — literally the same function GET .../final calls. See
  // src/lib/final-access.ts. Same 404 shape as that route's own refusal:
  // "not available" tells a caller nothing about which of the conditions
  // failed, or whether the asset exists at all.
  if (!canReadFinalDeliverable(asset, gallery, session)) {
    return errorResponse("display_not_available", 404);
  }

  const key = displayKey(gallery.id, asset.id);

  // Deterministic key, so nothing in the database records whether this
  // object was ever actually written (see `displayKey`'s own comment in
  // src/lib/r2.ts for why that is the right trade and not an omission). For
  // every final uploaded since task #89 shipped it has been, in the same
  // request as the final itself. For a final uploaded BEFORE that — one
  // delivered gallery in production at the time — it has not, until
  // `bun run backfill:display` runs.
  //
  // One HEAD request (no bytes read) turns that into a clean 404 the caller
  // falls back to the watermarked proof on, instead of handing back a
  // presigned URL for an object that isn't there and letting the browser
  // render a broken image. The cost is paid ONLY here, on the refresh path
  // — the page's own render never probes R2, see this file's header.
  //
  // A THROWN probe is treated as "not generated", deliberately, rather than
  // being allowed to escape as a 500. This is the one place in this feature
  // where answering a client GET depends on R2 being reachable at all — the
  // sibling proof route never talks to R2, it only signs a URL locally — so
  // an R2 outage, a rotated credential or a 403 on the bucket would
  // otherwise turn every delivered tile into a server error. The client
  // degrades identically either way (<ProofGrid> treats any non-ok response
  // as "fall back to the proof"), but that is the CLIENT being careful, not
  // this route; catching here makes the fail-closed direction a property of
  // the route's own contract — "a URL or a 404", never a 500 — instead of
  // something that happens to work out downstream. Falling back to a
  // watermarked photo the client owns is the right failure for this: it is
  // protective, and it is what they saw before the gallery was delivered.
  let displayExists: boolean;
  try {
    displayExists = await objectExists(key);
  } catch {
    displayExists = false;
  }
  if (!displayExists) {
    return errorResponse("display_not_generated", 404);
  }

  // No `contentDisposition` override, unlike GET .../final: this URL goes
  // into an <img src>, so it must render INLINE. That is the entire
  // behavioural difference between the two presigns — see `getPresignedUrl`'s
  // own comment in src/lib/r2.ts.
  const url = getPresignedUrl(key);
  return NextResponse.json({ url });
});
