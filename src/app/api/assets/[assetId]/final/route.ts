// GET /api/assets/[assetId]/final — the ONLY way a final image's bytes ever
// reach a browser (task #16, the security core of the media pipeline).
// POST /api/assets/[assetId]/final — the ONLY way a final's bytes ever get
// WRITTEN (task #26): the admin attaches an edited, full-resolution export to
// an EXISTING, already-selected asset.
//
// Same ownership check as .../proof/route.ts (session must own the gallery
// the asset belongs to, resolved FROM the asset row — see
// src/lib/asset-access.ts), PLUS an extra, stricter gate on GET: PLAN.md
// §2/§5 says a final exists "only for selected assets, after editing", and
// task #16 spells out the enforcement point explicitly — "Finals are only
// served for assets that are actually selected AND delivered." Proofs and
// finals are deliberately different access rules; owning the gallery is
// necessary for both but only sufficient for the proof.
//
// Task #28 adds the client-facing DOWNLOAD half on top of the same GET
// handler: a sensible filename (`buildFinalDownloadFilename` below) plus a
// `Content-Disposition: attachment` override on the presigned URL itself
// (`getPresignedUrl`'s new second argument, src/lib/r2.ts), so a phone
// browser navigating to the returned URL downloads the file instead of just
// displaying it. No new route was needed — this GET already returned
// exactly the presigned URL a download needed, it just never told R2 to
// answer with a download-flavored response.
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { requireApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { processFinal } from "@/lib/images";
import { finalKey, getPresignedUrl, putObject } from "@/lib/r2";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();

// A real edited export (full-resolution JPEG out of Lightroom) is much
// bigger than a proof (task #26's own memory note) — commonly 15-40 MB for
// a 24-45 MP body at high quality. This is set generously above that, same
// "don't discover the limit in production" reasoning as the proofs route's
// own `MAX_UPLOAD_BYTES` (src/app/api/galleries/[galleryId]/proofs/route.ts).
// The real memory bound is `processFinal`'s own `limitInputPixels` guard
// (src/lib/images.ts) — decode/re-encode cost scales with PIXEL COUNT, not
// file size, and `scripts/measure-final-memory.ts` measures that cost
// directly rather than guessing it from this number.
export const MAX_FINAL_UPLOAD_BYTES = 80 * 1024 * 1024;

/** Parses the `Content-Length` header into a byte count, or `null` if it is
 * absent or not a sane non-negative number. Same shape as the proofs
 * route's own `parseContentLength` — duplicated, not imported, matching
 * this codebase's existing convention of each route owning its own small
 * validation helpers rather than sharing them through a grab-bag utility
 * module. */
function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** Strips a filename's extension (the part after its LAST `.`), leaving the
 * rest untouched. A leading dot (a hidden-file-style name with no real
 * extension) is deliberately not treated as one — `lastIndexOf` returning 0
 * for e.g. ".jpg" falls through to the "no extension" branch, same as a
 * plain "IMG_0001" with no dot at all. */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Collapses `value` into a lowercase, filesystem-and-URL-safe slug: strips
 * accents (common in Spanish client/gallery names — PLAN.md's own client
 * base), then replaces every run of non `[a-z0-9]` characters with a single
 * hyphen, trimming leading/trailing hyphens. Deliberately permissive about
 * INPUT (anything coercible to a string works) and strict about OUTPUT (only
 * `[a-z0-9-]` ever comes out), since the result is later embedded directly
 * into a `Content-Disposition` header value — see `buildFinalDownloadFilename`
 * below for why that makes this the right place to enforce ASCII-only.
 */
function slugifyForFilename(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Builds a sensible, filesystem-safe download filename for a final image —
 * task #28's own acceptance criterion: "the client is saving these to a
 * phone; `a3f9-uuid.jpg` is not sensible." Combines the gallery's own title
 * (so a client with several delivered galleries saved to the same phone
 * folder can still tell them apart) with the asset's ORIGINAL filename's own
 * base name (recognizable to the client from their own camera/export, set at
 * proof-upload time — see `assets.originalFilename` in schema.ts), and always
 * ends in `.jpg`: `processFinal` (src/lib/images.ts) always outputs JPEG,
 * regardless of what the original upload's own extension was.
 *
 * Both inputs are slugified to plain ASCII `[a-z0-9-]` before being combined
 * — not because a `Content-Disposition` filename technically requires ASCII
 * (RFC 6266 has a `filename*` form for UTF-8), but because this app has no
 * other reason to carry that complexity: a slug is unambiguous everywhere
 * (URLs, filesystems, every OS this ever gets saved to) and needs no
 * extended-encoding fallback. Falls back to generic words if either input
 * slugifies to nothing (e.g. a gallery titled entirely in emoji), so this
 * never produces a degenerate `-.jpg` filename. */
export function buildFinalDownloadFilename(galleryTitle: string, originalFilename: string): string {
  const gallerySlug = slugifyForFilename(galleryTitle) || "galeria";
  const photoSlug = slugifyForFilename(stripExtension(originalFilename)) || "foto";
  return `${gallerySlug}-${photoSlug}.jpg`;
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
  //     ADMIN-ONLY EXCEPTION, decided here (task #26's note inherited from
  //     #63's review): skipped for admins. Before this file grew a POST
  //     handler, nothing ever wrote `asset.finalKey`, so this whole branch
  //     was unreachable and the strict gate cost nothing. Once an admin can
  //     actually upload a final (below), the SAME strict gate would make
  //     "preview the edit you just uploaded" impossible until the gallery
  //     is delivered — which is not what task #16's gate was FOR; it exists
  //     to stop a CLIENT from seeing a final before delivery, not to blind
  //     the photographer to their own upload. Task #16's rule for a CLIENT
  //     is UNCHANGED: still selected AND delivered, no carve-out — this
  //     loosens only the leg that gated the one caller (`loadOwnedAsset`'s
  //     "admin sees everything") who could never have been the rule's
  //     target in the first place.
  //   - `asset.finalKey` — the R2 object actually exists (set only by the
  //     admin's final-upload route below). Not treated as sufficient on its
  //     own for the first two checks: a stray finalKey must never unlock
  //     delivery of an unselected or pre-delivery asset by itself. Stays
  //     UNCONDITIONAL, admin included — an admin previewing a final still
  //     needs one to actually exist.
  //   - `asset.isEdited` — task #28's own acceptance criterion, checked
  //     EXPLICITLY rather than inferred from `finalKey` alone: the POST
  //     handler below always writes `finalKey` and `isEdited` together in
  //     the SAME update, so today the two can never disagree — but this gate
  //     does not lean on that invariant holding forever (the exact "don't
  //     infer one condition from another" stance the comment above already
  //     takes for `finalKey` itself). A future write path that could set one
  //     without the other must not silently unlock downloads.
  const deliveredGateAppliesToThisSession = session.user.role !== "admin";
  if (
    !asset.isSelected ||
    !asset.isEdited ||
    (deliveredGateAppliesToThisSession && gallery.status !== "delivered") ||
    !asset.finalKey
  ) {
    return errorResponse("final_not_available", 404);
  }

  // Sensible download filename (task #28's own acceptance criterion) plus a
  // `Content-Disposition: attachment` override on the presigned URL itself —
  // see getPresignedUrl's own comment in src/lib/r2.ts for why this, not any
  // client-side plumbing, is what makes a phone browser actually download
  // the file instead of opening it inline.
  const filename = buildFinalDownloadFilename(gallery.title, asset.originalFilename);
  const url = getPresignedUrl(asset.finalKey, {
    contentDisposition: `attachment; filename="${filename}"`,
  });
  return NextResponse.json({ url });
}

// POST — task #26: the admin attaches an edited, full-resolution export to
// an existing asset. See the file header for the shared ownership check;
// this handler adds the admin-only + selected-only gates on top of it.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  // Unauthenticated -> 401 JSON, never a redirect. Same MUST-early-return
  // shape as GET above — see its own comment.
  const sessionOrResponse = await requireApiSession();
  if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
  const session = sessionOrResponse;

  // Signed in but not admin -> 403. `forbidden()` (not `requireAdmin()`,
  // which redirects an unauthenticated caller instead of returning 401 JSON)
  // — same pattern as the proofs upload route
  // (src/app/api/galleries/[galleryId]/proofs/route.ts).
  if (session.user.role !== "admin") {
    forbidden();
  }

  const { assetId: rawAssetId } = await params;
  const assetIdResult = assetIdSchema.safeParse(rawAssetId);
  if (!assetIdResult.success) {
    return errorResponse("invalid_asset_id", 400);
  }

  // Resolves the asset AND its gallery from the asset's own foreign key —
  // see src/lib/asset-access.ts. For an admin this always succeeds
  // ownership-wise; reused here anyway so this handler never hand-rolls a
  // second, parallel way to look an asset up.
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // The core rule this task exists to enforce, checked on the WRITE side
  // (GET's own copy of this same rule lives above): `final_key` is nullable
  // precisely because most assets never get one (PLAN.md §6, schema.ts) —
  // uploading a final for an asset the client never selected is a bug, not
  // a convenience, per the epic (#5) and task #26's own acceptance
  // criterion. No gallery-status requirement is layered on top of this:
  // `isSelected` can already be true while the gallery is still `proofing`
  // (a client can toggle a selection before submitting — see
  // src/app/api/assets/[assetId]/selection/route.ts), and neither the task
  // nor the epic ties final upload to a specific gallery status beyond that
  // — adding one here would be scope this slice was not asked to own.
  if (!asset.isSelected) {
    return errorResponse("asset_not_selected", 409);
  }

  // Cheap size gate off the header, before the body is read/buffered at all
  // — same reasoning as the proofs route.
  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > MAX_FINAL_UPLOAD_BYTES) {
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
  if (file.size > MAX_FINAL_UPLOAD_BYTES) {
    return errorResponse("file_too_large", 413);
  }
  if (!file.type.startsWith("image/")) {
    return errorResponse("not_an_image", 415);
  }

  // The uploaded bytes exist only in this local variable, for exactly as
  // long as `processFinal` needs them — same "never stored, never
  // referenced again" shape as the proofs route's original bytes.
  const uploadedBytes = await file.arrayBuffer();

  let processed;
  try {
    processed = await processFinal(uploadedBytes);
  } catch {
    // Covers a genuinely corrupt/undecodable body and `processFinal`'s own
    // guard (the shared pixel-count bomb check in src/lib/images.ts) —
    // both collapse to "could not produce a final".
    return errorResponse("processing_failed", 422);
  }

  // Deterministic per (galleryId, assetId) — see src/lib/r2.ts's own
  // comment on `finalKey`. This is exactly what makes a RE-upload replace
  // the previous object instead of orphaning it: there is only ever one
  // possible key for this asset's final, so writing to it again overwrites
  // in place. No separate "delete the old one" step exists, or is needed.
  const key = finalKey(gallery.id, asset.id);

  try {
    await putObject(key, processed.data, { contentType: "image/jpeg" });
  } catch {
    return errorResponse("upload_failed", 502);
  }

  // DB write happens AFTER the R2 write — same ordering rationale as the
  // proofs route (a DB row pointing at bytes that don't exist yet is worse
  // than bytes with no row pointing at them yet: the former is a broken
  // image on every normal read path, the latter is invisible everywhere
  // reads go through `assets.finalKey`).
  //
  // UNLIKE the proofs route, there is deliberately NO compensating delete on
  // this failure path. `finalKey()`'s determinism (see above) means a failed
  // update here can be one of two situations, and only one of them is safe
  // to clean up:
  //   - First-ever upload for this asset: nothing referenced `key` before
  //     this request, so an orphan here is harmless — costs storage, not
  //     correctness, same as the proofs route's own orphan case.
  //   - RE-upload: `asset.finalKey` already equalled `key` before this
  //     request STARTED, and — because the update just failed — still does.
  //     Deleting `key` now would destroy the CURRENT, still-DB-referenced,
  //     possibly already-delivered final out from under the client. That is
  //     a strictly worse outcome than the orphan this route would otherwise
  //     be avoiding.
  // Nothing at this point in the handler can tell those two cases apart
  // without a second read of `asset.finalKey`, so this does not guess.
  try {
    await db.update(assets).set({ finalKey: key, isEdited: true }).where(eq(assets.id, asset.id));
  } catch {
    return errorResponse("update_failed", 500);
  }

  return NextResponse.json({
    asset: { id: asset.id, finalKey: key, isEdited: true },
  });
}
