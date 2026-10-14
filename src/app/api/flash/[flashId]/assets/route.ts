// POST /api/flash/[flashId]/assets — epic #232 / task #233: the admin adds ONE
// gifted photo to a flash gallery. The browser sends files one request at a
// time (same loop shape as the finals bulk uploader), so a failure names the
// exact file that failed.
//
// This route REUSES the finals pipeline instead of forking it: the upload gate
// (`ACCEPTED_FINAL_FORMATS`, JPEG and PNG — task #220), the size cap
// (`MAX_FINAL_UPLOAD_BYTES`), the byte-for-byte storage rule (task #218) and
// the browsing-sized derivative (`processDisplay`, task #89). What it does NOT
// do: no watermark, no proof, no `assets` row, no gallery-status gate — a
// flash gallery has no lifecycle.
//
// ADMIN-ONLY, checked here and not assumed from the page that renders the
// uploader. Order of effects is the finals route's: decode first (a corrupt
// file touches nothing), R2 objects second, the database row last, and a
// compensating delete if that last write fails — the objects are brand new and
// unreferenced, so deleting them cannot hurt anything.
import { randomUUID } from "node:crypto";
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq, max } from "drizzle-orm";
import { db } from "@/lib/db";
import { flashAssets, flashGalleries } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { ACCEPTED_FINAL_FORMATS } from "@/lib/final-formats";
import { processDisplay } from "@/lib/images";
import { deleteObject, flashDisplayKey, flashFinalKey, putObject } from "@/lib/r2";
import { MAX_FINAL_UPLOAD_BYTES } from "@/app/api/assets/[assetId]/final/route";

export const runtime = "nodejs";

const flashIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export const POST = withApiSession(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ flashId: string }> },
  session,
): Promise<NextResponse> {
  if (session.user.role !== "admin") {
    forbidden();
  }

  const { flashId: rawFlashId } = await params;
  const flashIdResult = flashIdSchema.safeParse(rawFlashId);
  if (!flashIdResult.success) {
    return errorResponse("invalid_flash_id", 400);
  }
  const flashGalleryId = flashIdResult.data;

  const [flashGallery] = await db
    .select({ id: flashGalleries.id })
    .from(flashGalleries)
    .where(eq(flashGalleries.id, flashGalleryId))
    .limit(1);
  if (!flashGallery) {
    return errorResponse("flash_gallery_not_found", 404);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FINAL_UPLOAD_BYTES) {
    return errorResponse("file_too_large", 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("invalid_multipart_body", 400);
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errorResponse("missing_file", 400);
  }
  if (file.size > MAX_FINAL_UPLOAD_BYTES) {
    return errorResponse("file_too_large", 413);
  }
  const extension = ACCEPTED_FINAL_FORMATS[file.type];
  if (extension === undefined) {
    return errorResponse("not_an_image", 415);
  }
  const contentType = file.type;
  const originalFilename = file.name;
  const bytes = await file.arrayBuffer();

  let display;
  try {
    display = await processDisplay(bytes);
  } catch {
    return errorResponse("processing_failed", 422);
  }

  // Minted here, before any write, so both R2 keys exist before the row does.
  const assetId = randomUUID();
  const finalObjectKey = flashFinalKey(flashGalleryId, assetId, extension);
  const displayObjectKey = flashDisplayKey(flashGalleryId, assetId);

  try {
    // BYTE-FOR-BYTE: the exact bytes the admin uploaded, no sharp pass.
    await putObject(finalObjectKey, bytes, { contentType });
    await putObject(displayObjectKey, display.data, { contentType: "image/webp" });
  } catch {
    await deleteObject(finalObjectKey).catch(() => {});
    await deleteObject(displayObjectKey).catch(() => {});
    return errorResponse("upload_failed", 502);
  }

  try {
    const [top] = await db
      .select({ value: max(flashAssets.sortOrder) })
      .from(flashAssets)
      .where(eq(flashAssets.flashGalleryId, flashGalleryId));
    await db.insert(flashAssets).values({
      id: assetId,
      flashGalleryId,
      originalFilename,
      finalKey: finalObjectKey,
      displayWidth: display.width,
      displayHeight: display.height,
      sortOrder: (top?.value ?? -1) + 1,
    });
  } catch {
    await deleteObject(finalObjectKey).catch(() => {});
    await deleteObject(displayObjectKey).catch(() => {});
    return errorResponse("update_failed", 500);
  }

  return NextResponse.json(
    {
      asset: {
        id: assetId,
        originalFilename,
        finalKey: finalObjectKey,
        displayWidth: display.width,
        displayHeight: display.height,
      },
    },
    { status: 201 },
  );
});
