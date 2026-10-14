// GET /flash/[publicSlug]/zip — every photo of a flash gallery in one archive.
// Same gate as the page. Streams through `zip-stream` exactly like
// `api/galleries/[galleryId]/download-all` (STORE-only, one R2 object open at a
// time, never buffered; see that route's header for the droplet-vs-Worker
// decision this inherits). Every size is HEADed BEFORE the first byte so a
// gallery over the zip32 limits is refused cleanly instead of truncated.
import { NextResponse, type NextRequest } from "next/server";
import { flashPhotoFilename, flashZipFilename } from "@/lib/flash-download";
import { listFlashAssets, resolveFlashGallery } from "@/lib/flash-access";
import { getObjectSize, getObjectStream } from "@/lib/r2";
import {
  buildZipStream,
  checkZip32Limits,
  toReadableStream,
  ZIP32_MAX_ENTRY_COUNT,
  type ZipEntry,
} from "@/lib/zip-stream";

export const runtime = "nodejs";

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ publicSlug: string }> },
): Promise<NextResponse> {
  const { publicSlug } = await params;
  const gallery = await resolveFlashGallery(publicSlug);
  if (!gallery) return new NextResponse(null, { status: 404 });

  const assets = await listFlashAssets(gallery.id);
  if (assets.length === 0) return errorResponse("no_photos", 404);
  if (assets.length > ZIP32_MAX_ENTRY_COUNT) return errorResponse("too_many_files", 413);

  const used = new Set<string>();
  const names = assets.map((a) => flashPhotoFilename(a.originalFilename, a.finalKey, used));

  const sizes: { name: string; size: number }[] = [];
  let missing = false;
  await Promise.all(
    assets.map(async (asset, index) => {
      try {
        sizes[index] = { name: names[index]!, size: await getObjectSize(asset.finalKey) };
      } catch {
        missing = true;
      }
    }),
  );
  if (missing) return errorResponse("final_missing", 502);

  const capacity = checkZip32Limits(sizes);
  if (!capacity.ok) return errorResponse(capacity.reason, 413);

  const entries: ZipEntry[] = assets.map((asset, index) => ({
    name: names[index]!,
    openStream: () => getObjectStream(asset.finalKey),
  }));

  return new NextResponse(toReadableStream(buildZipStream(entries)), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${flashZipFilename(gallery.title)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
