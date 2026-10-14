// GET /flash/[publicSlug]/display/[assetId] — the browsing-sized derivative of
// one flash photo. Same gate as the page (`resolveFlashGallery`); any denial or
// miss is an identical, bodiless 404. The bytes never pass through this
// process: a verified viewer is redirected to a short-lived presigned R2 URL.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getFlashAsset, resolveFlashGallery } from "@/lib/flash-access";
import { flashDisplayKey, getPresignedUrl } from "@/lib/r2";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ publicSlug: string; assetId: string }> },
): Promise<NextResponse> {
  const { publicSlug, assetId } = await params;
  const notFound = () => new NextResponse(null, { status: 404 });
  if (!z.uuid().safeParse(assetId).success) return notFound();

  const gallery = await resolveFlashGallery(publicSlug);
  if (!gallery) return notFound();
  const asset = await getFlashAsset(gallery.id, assetId);
  if (!asset) return notFound();

  const response = NextResponse.redirect(
    getPresignedUrl(flashDisplayKey(gallery.id, asset.id)),
    302,
  );
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
