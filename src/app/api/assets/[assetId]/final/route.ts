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
//
// TASK #93's DECISION — what a missing R2 object should answer with, on a
// route that has already told the client "yes, this is yours to download":
// `canReadFinalDeliverable` only proves the DATABASE says a final exists
// (`asset.finalKey` is set); it never talks to R2. Before this task, a
// `finalKey` whose object had been deleted out from under the row (or was
// never actually written) meant `getPresignedUrl` still handed back a URL —
// one that 404s on R2 with an XML body the client cannot read, at the last
// step of a flow they already paid for.
//
// This is a DATA-INTEGRITY problem on the photographer's side, not a client
// error: the client did everything right (selected, paid, waited for
// delivery) and their session — the two conditions actually within THEIR
// control — are fine. Weighed against the two obvious alternatives:
//   - A plain 404 was rejected. It's honest about "not found", but this
//     route already uses 404 for `final_not_available` — the ENTITLEMENT
//     gate (wrong client, not selected, not delivered yet). Reusing it here
//     would make "you don't have access" and "we lost your photo" the same
//     response, which is exactly backwards: one is the client's own session
//     being wrong, the other is nothing the client did.
//   - Silently skipping/falling back was never on the table for a SINGLE
//     asset's own download route — there is nothing to substitute a missing
//     final with (unlike download-all's own N-entries case, where "skip
//     this one, log loudly" was considered and also rejected — see that
//     route's own comment).
// `502` was chosen instead — same status this route's own POST handler
// already uses for `upload_failed` (an R2 write that didn't happen the way
// this app promised), extended here to an R2 READ that should have
// succeeded and didn't. It signals "our dependency, not your request" the
// way a 4xx cannot, and it is a code this app already treats as "the
// photographer needs to know", not merely logged and moved on from — see
// `notifyAdminOfMissingFinal` below, called on this exact branch.
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { canReadFinalDeliverable } from "@/lib/final-access";
import { ACCEPTED_FINAL_FORMATS } from "@/lib/final-formats";
import { processDisplay } from "@/lib/images";
import { notifyAdminOfMissingFinal } from "@/lib/missing-final-notification-email";
import {
  deleteObject,
  displayKey,
  finalKey,
  getPresignedUrl,
  objectExists,
  putObject,
  storedKey,
} from "@/lib/r2";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();

// A real edited export (full-resolution JPEG OR PNG out of Lightroom — task
// #220 widened accepted formats beyond JPEG-only, see
// `ACCEPTED_FINAL_FORMATS` in src/lib/final-formats.ts) is much bigger than a
// proof (task #26's own memory note) — commonly 15-40 MB for a 24-45 MP JPEG
// at high quality, and meaningfully MORE for a PNG of the same photo.
//
// OWNER DECISION, 2026-08-04 (task #220, third review round): kept at #218's
// original 80 MB, NOT raised. This constant was raised to 150 MB and lowered
// back to 80 MB inside this same task, twice, before landing here — the
// number was WRONG three separate times along the way (see below), and each
// wrong number was caught by someone actually measuring, never by re-reading
// the reasoning. The owner was asked directly what his real PNG finals
// weigh: all of them are under 60 MB. 80 MB covers that with real margin and
// carries none of the risk the larger cap turned out to have — this is a
// product decision (accept the current real files, don't buy headroom for a
// hypothetical future file), not a memory-safety compromise, and it is
// recorded here as one so nobody re-derives 150 MB from this comment's own
// old numbers without knowing the owner already chose not to carry that
// risk.
//
// THE NUMBERS BELOW ARE MEASURED, NOT REASONED — and this comment's own
// history is the reason that rule exists at all for this one constant:
//   - v1 reasoned that removing this route's `Buffer.from()` copy left
//     ~150 MB resident for a 150 MB upload through the decode step:
//     ~700 MB total against the 768 MB cap, "not comfortable but shipped
//     anyway." A reviewer MEASURED it instead and found ~300 MB, not
//     150 MB — the `request.formData()` parse produces a `File` with its
//     OWN backing buffer, a second copy v1's reasoning never accounted for.
//   - v2 (the first version of `scripts/measure-final-upload-memory.ts`)
//     measured the FULL request path but built its synthetic `Request` with
//     `body: formData` — a `FormData` OBJECT. Bun special-cases that: no
//     real multipart parse ever happens, `request.formData()` just hands the
//     same object back. v2's own header claimed this made the harness
//     CONSERVATIVE. That was BACKWARDS — it skipped the single most
//     expensive step in the real request path (the parse itself), so v2's
//     numbers were systematically LOW, not high.
//   - v3 (current) builds REAL multipart bytes — a boundary, headers, the
//     file's bytes, the closing boundary — as a `ReadableStream<Uint8Array>`
//     with an explicit `multipart/form-data; boundary=...` header, so
//     `request.formData()` has to actually parse. See that script's own
//     header for the full account of v2's bug and why it took a second
//     reviewer measurement to catch.
//
// `scripts/measure-final-upload-memory.ts` (`bun run
// measure:final:upload:memory`) measures the REAL request path end to end —
// `Request` (real multipart bytes) → `readUploadedFinal` → `processDisplay`
// — against THREE fixture profiles, because summing two separately-measured
// worst cases (one big-file, one big-pixel-count) turned out not to be
// legitimate: decode cost varies with input SHAPE at a FIXED pixel count
// (8-bit vs 16-bit alone differed ~2x in this measurement), so the real
// worst case has to be measured as one fixture near BOTH limits at once, not
// inferred by adding two independent maxima. Full fixture reasoning lives in
// that script's own header; the run that shipped with this comment (single
// observations, not repeated — the script's own comment on why):
//
//   REALISTIC (24.6 MP, 8-bit RGB noise, 74.5 MiB — comfortably under this
//   80 MB cap): peak RSS — OLD shape (the route's first version) 328.8 MiB,
//   NEW shape (the `readUploadedFinal` fix) 286.0 MiB.
//   CEILING (96 MP, 16-bit RGB near-flat, only 3.8 MiB on disk — this cap
//   does nothing to bound THIS profile, its danger is pixel count, not file
//   size): peak RSS — OLD 223.8 MiB, NEW 221.3 MiB. `processDisplay` alone,
//   independent maxRSS cross-check: ~150 MiB.
//   BOTH (96 MP, 8-bit RGB, moderately compressible, 76.3 MiB — near BOTH
//   the byte cap AND the pixel ceiling at once, the case the other two
//   profiles individually miss): peak RSS — OLD 343.6 MiB, NEW 293.8 MiB.
//   `processDisplay` alone, independent cross-check: ~78.5 MiB.
//
// WHAT THE readUploadedFinal FIX ACTUALLY BUYS — restated here because an
// earlier version of this comment overstated it. On a real multipart
// request, `file.arrayBuffer()` unavoidably produces a moment where the
// parsed `File`'s own storage AND the fresh `ArrayBuffer` copy are BOTH
// resident — that moment is identical whether or not `file` stays referenced
// afterward, so it is not what the fix removes (confirmed directly above:
// OLD's `afterArrayBuffer` reading and NEW's `afterRead` reading land within
// noise of each other in every profile measured). What the fix removes is
// what happens AFTER that moment: the OLD shape kept `file` referenced
// through `processDisplay`'s decode (reading `file.type` at the `putObject`
// call site, below), so the parsed File's storage stayed resident for the
// REST of the request, and the decode's own cost stacked on top of it. The
// NEW shape drops that reference the moment `readUploadedFinal` returns, so
// the File's storage is collectible before the decode runs. The measured
// effect: for CEILING (decode cost, ~150 MiB, dwarfs the tiny 3.8 MiB file),
// the fix barely moves the peak (223.8 → 221.3 MiB) — there was almost
// nothing to reclaim. For REALISTIC and BOTH (decode cost comparable to or
// smaller than the file itself), the fix DOES reduce the measured peak by a
// real amount (~43-50 MiB in this run) — the reclaimed File storage makes
// room during the decode instead of piling on top of it. Either way, the
// benefit that reliably matters — largest, and present in every profile — is
// POST-DECODE RESIDENCY, not peak: `afterHandlerEnd` in the NEW shape is
// roughly one upload's worth of memory below OLD's in every profile (e.g.
// REALISTIC: 328.8 MiB old vs 252.1 MiB new, final reading). That residency
// is what matters for a SECOND request queued behind `processDisplay`'s
// process-wide `runExclusive` mutex (src/lib/images.ts) — it sits behind
// whatever the first request is still holding onto, and the fix is what
// keeps that not include a whole extra File's worth of dead weight. It is
// not, by itself, what keeps this cap's own peak under the cgroup ceiling —
// the cap value is what does that, per the arithmetic below.
//
// COMBINED WORST CASE at the 80 MB cap: the BOTH profile is the one that
// actually stresses it (near both limits at once). Marginal cost added by
// ONE request, NEW shape (peak 293.8 MiB, this script's own harness baseline
// 133.5 MiB before any request-handling work starts): ~160 MiB. Added to
// this service's own separately-measured production steady state (task
// #218, ~150 MB, which already includes sharp/libvips loaded — not stacked
// on top of this script's own baseline a second time): ≈ 310 MB against the
// 768 MB `MemoryMax` this service shares with `findash` on a 2 GB droplet —
// comfortable, with real margin left over even under the OLD shape's own
// worse marginal cost (~210 MiB, ≈ 360 MB combined).
//
// Platform caveat, same as every sibling measurement script: laptop-measured
// (macOS), not droplet-measured (Linux) — see kanban #57. Re-run
// `measure:final:upload:memory` on the droplet before treating the exact
// numbers above as authoritative there; the qualitative conclusion (real
// margin, measured three times over now, not reasoned) is what this comment
// is actually vouching for. Do not raise this cap again without a NEW owner
// decision — the 80 MB ceiling above is the owner's choice, not a
// memory-derived limit; the memory arithmetic on its own permits headroom to
// spare.
export const MAX_FINAL_UPLOAD_BYTES = 80 * 1024 * 1024;

// ACCEPTED_FINAL_FORMATS moved to src/lib/final-formats.ts (task #220 review
// follow-up): MIME type → the extension `finalKey()` stores the object
// under. It used to live here as a route-local const, and the two client
// pickers that need the SAME list (asset-tile.tsx, finals-bulk-uploader.tsx)
// hand-copied it into their own `accept` attribute — with nothing enforcing
// the two stayed in sync, they drifted for real, twice, inside this one
// task. That module has no server-only imports specifically so both client
// components can import it directly and derive their `accept` string from
// it, instead of re-typing the list — see its own header for the full
// reasoning and the two prior extractions (final-access.ts, task #103;
// final-filename-match.ts, task #217) this follows the same shape as.

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

/** Extracts the extension actually stored in an R2 key — the part after the
 * LAST `.` — rather than assuming `.jpg` (task #220). `finalKey()`'s own
 * extension is now a function of the upload's accepted MIME type
 * (`ACCEPTED_FINAL_FORMATS` in src/lib/final-formats.ts), so a download
 * filename can no longer just append a hardcoded `.jpg` and be right for
 * every final: it has to read back whatever THIS SPECIFIC object's key
 * actually ends in. Duplicated in
 * download-all/route.ts rather than imported — same "each route owns its own
 * small validation helpers" convention as `stripExtension`/
 * `slugifyForFilename` above/below.
 *
 * Falls back to `"jpg"` only for a key with no `.` in it at all, which should
 * never happen for a key `finalKey()` actually minted (every call site that
 * reaches this function got its extension from the same allowlist that built
 * the key in the first place) — this exists so a malformed key can never make
 * this function throw or return an empty extension, not because the fallback
 * is expected to matter in practice. */
function extensionFromKey(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot >= 0 && dot < key.length - 1 ? key.slice(dot + 1) : "jpg";
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
 * proof-upload time — see `assets.originalFilename` in schema.ts), and ends
 * in whatever extension `finalKeyValue` (the asset's OWN stored `finalKey`)
 * is actually stored under.
 *
 * TASK #220: this used to always end in `.jpg`, justified by "the POST
 * handler only ever accepts `image/jpeg`" — that gate widened to a small
 * format allowlist (`ACCEPTED_FINAL_FORMATS`, src/lib/final-formats.ts), so a
 * stored final can now genuinely be a PNG, and handing a client `foto.jpg`
 * full of PNG bytes
 * would be exactly the kind of dishonesty task #218 fixed for file size.
 * `extensionFromKey` reads the REAL stored extension off the key rather than
 * re-deriving it from an upload's MIME type, so this stays correct for a
 * final uploaded before or after any future change to that allowlist.
 *
 * Both `galleryTitle`/`originalFilename` inputs are slugified to plain ASCII
 * `[a-z0-9-]` before being combined — not because a `Content-Disposition`
 * filename technically requires ASCII (RFC 6266 has a `filename*` form for
 * UTF-8), but because this app has no other reason to carry that complexity:
 * a slug is unambiguous everywhere (URLs, filesystems, every OS this ever
 * gets saved to) and needs no extended-encoding fallback. Falls back to
 * generic words if either input slugifies to nothing (e.g. a gallery titled
 * entirely in emoji), so this never produces a degenerate filename. */
export function buildFinalDownloadFilename(
  galleryTitle: string,
  originalFilename: string,
  finalKeyValue: string,
): string {
  const gallerySlug = slugifyForFilename(galleryTitle) || "galeria";
  const photoSlug = slugifyForFilename(stripExtension(originalFilename)) || "foto";
  return `${gallerySlug}-${photoSlug}.${extensionFromKey(finalKeyValue)}`;
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

  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // The final-specific gate — every condition, the admin carve-out on the
  // delivered leg, and the reasoning behind each now live in ONE place:
  // src/lib/final-access.ts's `canReadFinalDeliverable`. It was extracted
  // there by task #89 so this route and GET /api/assets/[assetId]/display
  // (which serves the browsing-sized derivative of these exact bytes) cannot
  // drift apart — "gated exactly like the download" is only true if there is
  // literally one gate. Read that module for the per-condition reasoning;
  // nothing about the rule changed when it moved.
  if (!canReadFinalDeliverable(asset, gallery, session)) {
    return errorResponse("final_not_available", 404);
  }

  // Task #93: the gate above only proves the DATABASE thinks a final
  // exists. One HEAD request (no bytes read — see objectExists's own
  // comment in src/lib/r2.ts) confirms the R2 OBJECT actually still does,
  // before a presigned URL for it is ever handed out. A thrown probe is
  // treated the same as an explicit `false` — fail closed, same stance
  // GET .../display already takes on this exact call (see that route's own
  // comment on why a throw here must never become an unrelated 500).
  let objectStillExists: boolean;
  try {
    objectStillExists = await objectExists(asset.finalKey);
  } catch {
    objectStillExists = false;
  }
  if (!objectStillExists) {
    // Best-effort — see notifyAdminOfMissingFinal's own comment. Awaited so
    // the alert has actually been attempted before this request ends, not
    // fired-and-forgotten into a serverless-style function that could be
    // frozen before it completes.
    await notifyAdminOfMissingFinal({
      gallery,
      missingFilenames: [asset.originalFilename],
    });
    return errorResponse("final_missing", 502);
  }

  // Sensible download filename (task #28's own acceptance criterion) plus a
  // `Content-Disposition: attachment` override on the presigned URL itself —
  // see getPresignedUrl's own comment in src/lib/r2.ts for why this, not any
  // client-side plumbing, is what makes a phone browser actually download
  // the file instead of opening it inline.
  const filename = buildFinalDownloadFilename(
    gallery.title,
    asset.originalFilename,
    asset.finalKey,
  );
  // `asset.finalKey` came off the `assets` table, which loses the `R2Key`
  // brand on the round trip through Postgres (see `storedKey`'s own comment
  // in src/lib/r2.ts) — it was originally written by `finalKey()` below.
  const url = getPresignedUrl(storedKey(asset.finalKey), {
    contentDisposition: `attachment; filename="${filename}"`,
  });
  return NextResponse.json({ url });
});

type ReadUploadedFinalResult =
  | {
      ok: true;
      /** Exactly what `file.arrayBuffer()` returned — never re-wrapped in a
       * `Buffer`, see the `putObject` call site's own comment. */
      bytes: ArrayBuffer;
      /** The upload's declared MIME type — already checked against
       * `ACCEPTED_FINAL_FORMATS`, so this is one of that map's own keys. */
      contentType: string;
      /** `ACCEPTED_FINAL_FORMATS[contentType]`, resolved once here so
       * nothing downstream re-indexes the map a second time. */
      extension: string;
    }
  | { ok: false; error: string; status: number };

/**
 * Parses the multipart body, validates the uploaded file (present, under the
 * size cap, an accepted format) and reads its bytes — all in its OWN
 * function frame, separate from the POST handler below.
 *
 * THIS SCOPING IS LOAD-BEARING, NOT STYLISTIC (task #220 review follow-up) —
 * but what it buys was ALSO measured wrong on the first pass, and the
 * corrected claim is more modest than the original one. `request.formData()`
 * parses the whole multipart body into a `FormData` whose `File` entry
 * retains its OWN backing buffer, roughly the size of the upload — a
 * SEPARATE allocation from the ArrayBuffer `file.arrayBuffer()` copies out of
 * it below. That moment — the File's own storage AND the fresh ArrayBuffer
 * copy both resident at once — is UNAVOIDABLE on a real multipart request
 * and happens identically whether or not `file` stays referenced afterward;
 * no amount of scoping removes it (measured directly:
 * scripts/measure-final-upload-memory.ts's OLD and NEW shapes land within
 * noise of each other at that exact point, in every fixture profile). What
 * scoping this function DOES change is what happens AFTER that moment: the
 * route's first version kept `file` referenced all the way past
 * `processDisplay`'s decode, reading `file.type` at the `putObject` call
 * site below — so the File's storage stayed resident for the REST of the
 * request, with the decode's own cost stacking on top of it instead of
 * reusing that space. Returning only PRIMITIVES (`contentType`, `extension`)
 * and the ArrayBuffer itself — never `file` or `formData` — means neither is
 * reachable from the caller's scope the moment this function returns, so the
 * File's storage is collectible BEFORE the decode runs rather than
 * afterward. Measured effect (see `MAX_FINAL_UPLOAD_BYTES`'s own comment
 * above for the exact figures): a modest, shape-dependent PEAK reduction
 * where decode cost is comparable to the upload size, and — reliably, in
 * every profile measured — roughly one upload's worth LESS memory resident
 * after the decode completes. That post-decode residency is what actually
 * matters for a request queued behind `processDisplay`'s process-wide
 * `runExclusive` mutex (src/lib/images.ts): it determines how much dead
 * weight the FIRST request is still holding while a second one waits its
 * turn, not the single-request peak `MAX_FINAL_UPLOAD_BYTES` is sized
 * against.
 */
async function readUploadedFinal(request: NextRequest): Promise<ReadUploadedFinalResult> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, error: "invalid_multipart_body", status: 400 };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "missing_file", status: 400 };
  }

  // Second size gate off the parsed file itself — catches a missing or
  // understated Content-Length (e.g. chunked transfer encoding). The FIRST
  // gate, off the Content-Length header alone, runs in the caller BEFORE
  // this function is ever invoked — see POST's own comment on why that one
  // stays outside this function (it needs no multipart parse at all).
  if (file.size > MAX_FINAL_UPLOAD_BYTES) {
    return { ok: false, error: "file_too_large", status: 413 };
  }

  // TASK #220: widened from #218's JPEG-only gate to the small MIME-type
  // allowlist in src/lib/final-formats.ts — the final is still stored
  // BYTE-FOR-BYTE below, but which extension/Content-Type it gets now
  // follows the upload's own declared format instead of a single hardcoded
  // assumption. `file.type` is still the BROWSER's own extension-based
  // guess, not a sniff of the actual bytes (unchanged from #218 — that
  // reasoning is still accurate): a PNG renamed `edit.jpg` still passes this
  // gate — as a "jpg" — and gets stored/served as if it really were one; it
  // is still exactly the bytes the admin uploaded, just mislabeled. What
  // this gate DOES reliably stop is the ordinary case both tasks exist for:
  // an honestly-typed export whose format ISN'T in the allowlist at all (a
  // raw HEIC straight off a phone, some other screenshot format) landing at
  // a key/Content-Type that lies about what it actually is.
  const extension = ACCEPTED_FINAL_FORMATS[file.type];
  if (extension === undefined) {
    return { ok: false, error: "not_an_image", status: 415 };
  }

  const bytes = await file.arrayBuffer();
  return { ok: true, bytes, contentType: file.type, extension };
}

// POST — task #26: the admin attaches an edited, full-resolution export to
// an existing asset. See the file header for the shared ownership check;
// this handler adds the admin-only + selected-only gates on top of it.
//
// TASK #220: accepts JPEG **or** PNG (`ACCEPTED_FINAL_FORMATS`,
// src/lib/final-formats.ts), not JPEG-only. #218 tightened the gate to
// `image/jpeg` because — at the time —
// every final really was a Lightroom JPEG export; that premise turned out to
// be false (the owner's own finals include PNG exports from a second editing
// pass). Widening the gate means `finalKey()` (src/lib/r2.ts) now takes the
// extension as an argument instead of hardcoding `.jpg`, which in turn means
// a re-upload that changes format writes a genuinely different key — see the
// stale-object cleanup further down in this handler for how that stays from
// orphaning the previous object.
//
// Unauthenticated -> 401 JSON, never a redirect. Same `withApiSession()`
// shape as GET above — see its own comment.
export const POST = withApiSession(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
  session,
): Promise<NextResponse> {
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

  // Parses, validates and reads the upload in its OWN function frame — see
  // `readUploadedFinal`'s own comment for why that scoping is load-bearing,
  // not stylistic: it is what actually lets the multipart-parsed `File`'s
  // own backing buffer become collectible before the decode below runs,
  // instead of staying pinned alive by a `file`/`formData` reference this
  // handler never holds at all any more.
  const uploadResult = await readUploadedFinal(request);
  if (!uploadResult.ok) {
    return errorResponse(uploadResult.error, uploadResult.status);
  }
  const { bytes: uploadedBytes, contentType, extension } = uploadResult;

  let display;
  try {
    // Task #89's browsing-sized, unwatermarked derivative a DELIVERED
    // gallery shows in its grid and lightbox. Fed the SAME raw bytes that
    // get stored at `finalKey` — see src/lib/images.ts's file header and
    // `processDisplay`'s own section header for why that function is now the
    // ONLY thing in this pipeline that strips metadata (GPS included) from a
    // final-shaped image. This still runs BEFORE either object is written,
    // so a failure here leaves R2 untouched by this request rather than half
    // updated.
    display = await processDisplay(uploadedBytes);
  } catch {
    // Covers a genuinely corrupt/undecodable body and `processDisplay`'s own
    // guard (the shared pixel-count bomb check in src/lib/images.ts).
    return errorResponse("processing_failed", 422);
  }

  // `displayKey` stays fully deterministic per (galleryId, assetId) — see its
  // own comment in src/lib/r2.ts for why that is what lets this whole feature
  // need no new column. `finalKey` is NO LONGER unconditionally deterministic
  // as of task #220: it also depends on `extension` above, so the SAME asset
  // can resolve to a DIFFERENT key across two uploads if the format changes.
  // `previousFinalKey` is captured here, before any write below, specifically
  // so the cleanup step further down can tell "same key, ordinary overwrite"
  // apart from "different key, an old object needs deleting" — see that
  // step's own comment for the full reasoning and why the ordering around it
  // is not negotiable.
  const key = finalKey(gallery.id, asset.id, extension);
  const displayObjectKey = displayKey(gallery.id, asset.id);
  const previousFinalKey = asset.finalKey;

  try {
    // TASK #218: `uploadedBytes` is written VERBATIM — the exact bytes the
    // admin uploaded, no sharp pass in between. `contentType: contentType`
    // (task #220 — no longer hardcoded to `"image/jpeg"`): this string came
    // off `readUploadedFinal`'s own `file.type` read, already checked
    // against `ACCEPTED_FINAL_FORMATS` there, so it is one of that map's own
    // keys here, honestly describing whichever format was actually accepted
    // — and, per that function's own comment, reading it from THIS returned
    // value rather than a `file.type` dereference here is what keeps the
    // original `File` object out of this handler's scope entirely. Same
    // caveat as #218's original comment: this is still the browser's own
    // extension-based guess, not a sniff of the actual bytes, so a PNG
    // renamed `edit.jpg` still stores as a real PNG under a `.jpg` key
    // labeled `image/jpeg` — an unchanged risk, just no longer the ONLY
    // format this route will ever honestly store.
    await putObject(key, uploadedBytes, { contentType });
    // Written in the SAME request, and its failure fails the whole upload
    // (502, same as the final's own). A partial success here would leave the
    // photographer believing the photo is delivered while the client keeps
    // seeing a watermark on it — an outcome nobody would notice until the
    // client mentioned it. Failing loudly costs the photographer one retry;
    // both keys are deterministic FOR A GIVEN EXTENSION, so a same-format
    // retry is a clean overwrite; a different-format retry mints a new key
    // and leaves the old one for the cleanup step below to catch on its own
    // next successful attempt. The final is written FIRST so that an
    // interruption between the two can only ever leave the SMALLER,
    // browsing-sized copy stale relative to the full-resolution one the
    // client downloads — never the reverse.
    await putObject(displayObjectKey, display.data, { contentType: "image/webp" });
  } catch {
    return errorResponse("upload_failed", 502);
  }

  // DB write happens AFTER the R2 write — same ordering rationale as the
  // proofs route (a DB row pointing at bytes that don't exist yet is worse
  // than bytes with no row pointing at them yet: the former is a broken
  // image on every normal read path, the latter is invisible everywhere
  // reads go through `assets.finalKey`).
  //
  // UNLIKE the proofs route, there is still deliberately NO compensating
  // delete on THIS failure path (a failed DB update). `previousFinalKey`
  // (captured above, before either R2 write) is exactly what `asset.finalKey`
  // still is if this update fails — untouched, still resolving to a real
  // object — so there is nothing here that needs cleaning up on THIS branch:
  //   - First-ever upload for this asset: `previousFinalKey` was `null`,
  //     nothing referenced `key` before this request, so an orphan at `key`
  //     here is harmless — costs storage, not correctness, same as the
  //     proofs route's own orphan case.
  //   - RE-upload: `asset.finalKey` still equals `previousFinalKey`, which
  //     the database never stopped pointing at. `key` (whether identical to
  //     `previousFinalKey` or a new, different-extension key) is once again
  //     just an orphan if this branch is hit — nothing was ever deleted, so
  //     nothing was ever destroyed out from under the client.
  // The stale-object DELETE only ever runs after a SUCCESSFUL update, below —
  // see that block's own comment for why the ordering there is the part that
  // actually matters.
  try {
    await db.update(assets).set({ finalKey: key, isEdited: true }).where(eq(assets.id, asset.id));
  } catch {
    return errorResponse("update_failed", 500);
  }

  // Stale-object cleanup (task #220) — the ordering below is NOT negotiable,
  // and it is the reason #218's "no compensating delete" comment above no
  // longer describes this whole handler: that comment now only covers the DB
  // -update-failure branch. This block covers the branch #218 never had to:
  // a SUCCESSFUL re-upload that changed format.
  //
  //   1. Write the new object(s) at `key`/`displayObjectKey` (above).
  //   2. Update `assets.finalKey` to `key` (above, just succeeded).
  //   3. ONLY THEN, if `previousFinalKey` was non-null and differs from
  //      `key`, best-effort delete the OLD object.
  //
  // #218 needed no compensating delete anywhere because `finalKey()` was
  // fully deterministic per (galleryId, assetId): every upload for the same
  // asset produced the exact SAME key, so a re-upload was always an in-place
  // overwrite and there was never an "old" object to clean up. #220 breaks
  // that determinism on purpose — the key now also depends on the accepted
  // upload's format — so a re-upload that changes format (a `.jpg` final
  // replaced by a `.png` one, the owner's actual situation) writes a NEW key
  // and, without this step, would leave the OLD object behind: still in the
  // bucket, costing storage, never referenced by anything again.
  //
  // Why the delete happens HERE — after the DB update has ACTUALLY
  // SUCCEEDED — and not before it or interleaved with the R2 writes above:
  // deleting `previousFinalKey` before confirming the database has moved on
  // from it would, on any failure between the delete and the update, leave
  // `assets.finalKey` pointing at an object that no longer exists — exactly
  // task #93's `final_missing` 502 state ("we lost your photo"), on data the
  // photographer may have already told a client was delivered. An orphaned
  // NEW object costs storage; a row pointing at nothing costs a support
  // conversation and an admin alert. Only once the DB update above has
  // actually committed is it safe to know `previousFinalKey` is no longer
  // referenced by anything — that is the one moment this handler can be sure
  // deleting it does not destroy a still-live final.
  //
  // The delete itself is best-effort: a failure here (network hiccup, R2
  // outage) leaves `previousFinalKey`'s object as an ORPHAN — unreferenced,
  // unreachable through any read path (`assets.finalKey` already points at
  // `key`), costing storage and nothing else. That is the strictly cheaper
  // failure this design accepts, which is why this NEVER fails the request
  // whose client already has their new final — but "never fails the
  // request" is not the same as "nobody ever finds out": a silent swallow
  // here means storage leaks forever with no signal to anyone. `console.error`
  // logged, request still succeeds — the cheap middle between failing the
  // upload and losing the orphan entirely.
  if (previousFinalKey !== null && previousFinalKey !== key) {
    try {
      await deleteObject(storedKey(previousFinalKey));
    } catch (error) {
      // `no-console` is a project-wide error (eslint.config.mjs) with no
      // exception for `src/app/api/**` — this is deliberately the FIRST
      // `console.*` call in this codebase outside `scripts/`/`tooling/`, not
      // a precedent to reach for elsewhere. There is no logging utility here
      // to route this through instead (checked — none exists), and this
      // specific failure has no OTHER signal anywhere: it must never fail
      // the response (the client already has their new final — see the
      // comment above), so the only way anyone ever learns storage is
      // leaking is a line in the server's own stderr, picked up by whatever
      // already captures `systemd`/`journalctl` output for this service.
      // eslint-disable-next-line no-console -- see comment above; this exact call is the one deliberate exception.
      console.error(
        `Failed to delete stale final object at "${previousFinalKey}" after a ` +
          `format-changing re-upload for asset ${asset.id} (now at "${key}"). ` +
          `The old object is now an orphan — costs storage, not correctness.`,
        error,
      );
    }
  }

  return NextResponse.json({
    asset: { id: asset.id, finalKey: key, isEdited: true },
  });
});
