// POST /api/galleries/[galleryId]/proofs — admin uploads one original photo,
// gets back a watermarked proof stored in R2 and linked to a new `assets`
// row (task #15, PLAN.md §5).
//
// Request shape: ONE FILE PER REQUEST, not a batch endpoint.
//
// A real upload session is on the order of 200 originals at ~8 MB each
// (task #15's note carried over from #14) on a droplet whose service is
// capped at `MemoryMax=768M`. A batch endpoint would need to either buffer
// every file in the batch before processing the first one (multipart bodies
// don't expose "field N" until the parser has walked past field 1..N-1,
// and `request.formData()` parses the whole body up front) or stream-parse
// multipart by hand — neither is worth the complexity here. One file per
// request means exactly one body, of one bounded size, is ever resident at
// a time; `processProof`'s own internal mutex (src/lib/images.ts) already
// guarantees only one decode is in flight process-wide even if the admin's
// upload UI fires many of these requests concurrently. The upload UI is
// responsible for looping over the file list — this route only ever knows
// about one file.
//
// Body size: Next.js Route Handlers impose no default limit of their own
// (unlike Server Actions' 1 MB default) — the limit here is deliberate, not
// discovered later against a surprise 40 MB export. `MAX_UPLOAD_BYTES` below
// is enforced twice: once cheaply off the `Content-Length` header, before
// the body is read at all, and again off the parsed `File`'s own `.size`,
// in case the header was absent or understated (e.g. chunked transfer).
//
// Failure-ordering / orphan avoidance (task #15's acceptance criterion):
// R2 write happens BEFORE the `assets` insert, deliberately. That means:
//   - If the R2 write fails, this handler returns before any insert is
//     attempted — there is no `assets` row to leak, by construction. Nothing
//     to clean up on this side, ever.
//   - If the R2 write succeeds but the insert fails, the object at `key`
//     is now an orphan (no `assets` row points at it). This handler makes a
//     best-effort `deleteObject(key)` right there in the catch block. THIS
//     IS THE SIDE THAT CAN LEAK: if that compensating delete itself fails
//     (e.g. R2 is unreachable at that exact moment, immediately after having
//     just succeeded), the orphaned proof object is left in R2 with no DB
//     row referencing it. It costs storage, not correctness — nothing in the
//     app ever discovers or serves an object with no `assets` row, since
//     every read path goes through `assets.proofKey`. Reconciling truly
//     orphaned R2 objects (a periodic sweep) is out of scope for this slice.
// The reverse order (insert first, then upload) was rejected: a successful
// insert with a failed upload would leave a REAL `assets` row pointing at a
// key that 404s in R2 — which is worse, because that row is visible to every
// normal read path (the gallery grid) as a broken image, not merely wasted
// storage nothing ever looks at.
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleries } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireApiSession } from "@/lib/auth-guards";
import { processProof } from "@/lib/images";
import { deleteObject, proofKey, putObject } from "@/lib/r2";

export const runtime = "nodejs";

// A real proof export is ~8 MB; this is set well above that (task #15's
// "don't discover the limit in production with a 40 MB export") while still
// bounding a single request's memory footprint, since only one body is ever
// buffered at a time (see the file header).
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Proofs are uploaded while the gallery is being assembled (DRAFT) and can
// keep being added while the client is actively browsing it (PROOFING) —
// PLAN.md §2's diagram has proof upload starting in DRAFT, and nothing says
// the photographer can't add a few more while the gallery is already live.
// Once the client has submitted a selection (SELECTED and later), the set of
// assets is meant to be settled; this route refuses to grow it further.
const PROOF_ACCEPTING_STATUSES = new Set<Gallery["status"]>(["draft", "proofing"]);

const galleryIdSchema = z.uuid();

/** Parses the `Content-Length` header into a byte count, or `null` if it is
 * absent or not a sane non-negative number. Exported for direct unit
 * testing — separate from any real `Request`, since fetch/undici compute
 * this header themselves and a test can't reliably force an arbitrary
 * value onto it. */
export function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
): Promise<NextResponse> {
  // Unauthenticated -> 401 JSON (never a redirect; see auth-guards.ts).
  const sessionOrResponse = await requireApiSession();
  if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
  const session = sessionOrResponse;

  // Signed in but not admin -> 403, checked on every request per the epic's
  // rule. `forbidden()` (not `requireAdmin()`, which redirects unauthed
  // callers instead of returning 401 JSON) is the documented pattern for a
  // route handler that already has a `Session` in hand — see
  // auth-guards.ts's header comment on `requireApiSession()`.
  if (session.user.role !== "admin") {
    forbidden();
  }

  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) {
    return errorResponse("invalid_gallery_id", 400);
  }
  const galleryId = galleryIdResult.data;

  // Gallery existence + state, checked BEFORE touching the request body at
  // all: a single indexed lookup is far cheaper than buffering a multipart
  // body, and this is exactly the kind of reject-early-and-cheaply case the
  // task calls out.
  const [gallery] = await db.select().from(galleries).where(eq(galleries.id, galleryId)).limit(1);
  if (!gallery) {
    return errorResponse("gallery_not_found", 404);
  }
  if (!PROOF_ACCEPTING_STATUSES.has(gallery.status)) {
    return errorResponse("gallery_not_accepting_proofs", 409);
  }

  // Cheap size gate off the header, before the body is read/buffered at all.
  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_BYTES) {
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

  // Second size gate off the parsed file itself — catches a missing or
  // understated Content-Length (e.g. chunked transfer encoding).
  if (file.size > MAX_UPLOAD_BYTES) {
    return errorResponse("file_too_large", 413);
  }
  if (!file.type.startsWith("image/")) {
    return errorResponse("not_an_image", 415);
  }

  // Original bytes exist only in this local variable, for exactly as long
  // as `processProof` needs them. Never stored, never referenced again once
  // this function returns — PLAN.md's "originals are never stored" rule.
  const originalBytes = await file.arrayBuffer();

  let processed;
  try {
    processed = await processProof(originalBytes);
  } catch {
    // Covers both a genuinely corrupt/non-image body (declared image/* but
    // undecodable) and images.ts's own guards (pixel-count bomb, fontless
    // watermark render) — all collapse to "could not produce a proof".
    return errorResponse("processing_failed", 422);
  }

  const assetId = crypto.randomUUID();
  const key = proofKey(galleryId, assetId);

  try {
    await putObject(key, processed.data, { contentType: "image/webp" });
  } catch {
    return errorResponse("upload_failed", 502);
  }

  // Append to the end of the gallery's current ordering. Best-effort, not
  // strictly serialized: two uploads racing for the same gallery could read
  // the same count and land on the same sort_order. That only produces a
  // tie in display order (assets carry no uniqueness constraint on
  // sort_order) — not a correctness bug — and reordering is an admin
  // concern for a later slice, not this one.
  const [{ value: existingCount }] = await db
    .select({ value: count() })
    .from(assets)
    .where(eq(assets.galleryId, galleryId));
  const sortOrder = Number(existingCount);

  try {
    await db.insert(assets).values({
      id: assetId,
      galleryId,
      originalFilename: file.name,
      proofKey: key,
      proofWidth: processed.width,
      proofHeight: processed.height,
      sortOrder,
    });
  } catch {
    // Orphan avoidance, upload-succeeded-insert-failed side: see the file
    // header for which side this leaves exposed if this delete itself fails.
    await deleteObject(key).catch(() => {});
    return errorResponse("insert_failed", 500);
  }

  return NextResponse.json(
    {
      asset: {
        id: assetId,
        proofKey: key,
        width: processed.width,
        height: processed.height,
        sortOrder,
        originalFilename: file.name,
      },
    },
    { status: 201 },
  );
}
