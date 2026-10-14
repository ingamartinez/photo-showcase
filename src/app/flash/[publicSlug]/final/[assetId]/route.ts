// GET /flash/[publicSlug]/final/[assetId] — download one gifted photo, bytes
// exactly as uploaded. Same gate as the page; denial and miss are an identical
// 404. Redirects to a presigned URL that forces `attachment` (so a phone saves
// the file instead of opening it). Deliberately does NOT use
// `canReadFinalDeliverable`: that gate protects paid work on another aggregate.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { flashPhotoFilename } from "@/lib/flash-download";
import { getFlashAsset, resolveFlashGallery } from "@/lib/flash-access";
import { getPresignedUrl, storedKey } from "@/lib/r2";

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

  const filename = flashPhotoFilename(asset.originalFilename, asset.finalKey);
  const response = NextResponse.redirect(
    getPresignedUrl(storedKey(asset.finalKey), {
      contentDisposition: `attachment; filename="${filename}"`,
    }),
    302,
  );
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
