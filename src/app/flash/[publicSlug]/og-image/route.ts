// GET /flash/[publicSlug]/og-image — the STABLE URL a link preview points at.
//
// Never a presigned URL: WhatsApp/Telegram/iMessage cache the preview, and a
// presigned URL would be dead by the time anyone re-renders it. So this route
// serves the first photo's display derivative itself. That is a deliberate,
// scoped exception to "the server never streams image bytes": the derivative
// is a small WebP and a preview crawler cannot be handed an expiring link.
//
// Answers ONLY for a PUBLIC gallery that has a photo; private, missing, empty
// or switched-off-later are all the same bodiless 404 (the gate is re-evaluated
// on every request; the short cache below bounds how long a switched-off
// gallery's image can linger in a shared cache).
import { NextResponse, type NextRequest } from "next/server";
import { getFirstFlashAsset, resolvePublicFlashGallery } from "@/lib/flash-access";
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

  return new NextResponse(getObjectStream(flashDisplayKey(gallery.id, first.id)), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=300",
    },
  });
}
