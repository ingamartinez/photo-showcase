// GET /flash/[publicSlug]/og-image — the STABLE URL a link preview points at.
//
// Never a presigned URL: WhatsApp/Telegram/iMessage cache the preview, and a
// presigned URL would be dead by the time anyone re-renders it. So this route
// serves the first photo itself, as a ~1200px JPEG (quality 80, metadata
// stripped) re-encoded from the display derivative: WhatsApp, the owner's main
// channel, drops heavy preview images and is unreliable with WebP. That is a
// deliberate, scoped exception to "the server never streams image bytes" — a
// small image and a crawler that cannot be handed an expiring link. The
// dimensions come from `flashOgDimensions`, the same function that fills
// `og:image:width/height`, so the declared and served sizes cannot drift.
//
// Answers ONLY for a PUBLIC gallery that has a photo; private, missing, empty
// or switched-off-later are all the same bodiless 404 (the gate is re-evaluated
// on every request; the short cache below bounds how long a switched-off
// gallery's image can linger in a shared cache).
import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { getFirstFlashAsset, resolvePublicFlashGallery } from "@/lib/flash-access";
import { flashOgDimensions } from "@/lib/flash-meta";
import { flashDisplayKey, getObjectStream } from "@/lib/r2";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ publicSlug: string }> },
): Promise<NextResponse> {
  const { publicSlug } = await params;
  const gallery = await resolvePublicFlashGallery(publicSlug);
  if (!gallery) return new NextResponse(null, { status: 404 });
  const first = await getFirstFlashAsset(gallery.id);
  if (!first) return new NextResponse(null, { status: 404 });

  const source = Buffer.from(
    await new Response(getObjectStream(flashDisplayKey(gallery.id, first.id))).arrayBuffer(),
  );
  const { width, height } = flashOgDimensions(first.displayWidth, first.displayHeight);
  // No `.withMetadata()`: sharp drops EXIF/ICC/GPS by default.
  const jpeg = await sharp(source)
    .resize(width, height, { fit: "fill" })
    .jpeg({ quality: 80 })
    .toBuffer();

  return new NextResponse(new Uint8Array(jpeg), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(jpeg.length),
      "Cache-Control": "public, max-age=300",
    },
  });
}
