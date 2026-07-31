// GET /api/galleries/[galleryId]/download-all — task #29: "one button that
// gets the whole delivered set." Streams every deliverable asset's final
// straight from R2 into a zip archive, in one response.
//
// THE DECISION THIS ROUTE RECORDS (kanban #29's own acceptance criterion:
// "a decision recorded with the measurement behind it") — droplet vs. a
// Cloudflare Worker:
//
// PLAN.md §5 states an invariant this product has honoured everywhere else:
// "the droplet never streams image bytes" — every other read path
// (src/app/api/assets/[assetId]/{proof,final}/route.ts) hands back a
// presigned URL and lets the BROWSER fetch R2 directly. Building a zip on
// the droplet necessarily breaks that: something has to read every final's
// bytes and re-emit them as one archive, and a browser cannot do that on its
// own (it cannot assemble a zip container across N cross-origin fetches).
// That "something" is either this Next process, or a Cloudflare Worker
// sitting between the client and R2.
//
// A Worker would preserve the invariant literally — R2 bytes would never
// touch the 2 GB droplet this app shares with `findash` (768M `MemoryMax`,
// infra/systemd/photoshowcase.service) at all. It was seriously considered
// and rejected FOR THIS SLICE, not out of laziness but because building one
// for real is materially more than "one route": a `wrangler.toml`, a worker
// script that re-implements (or calls back into) this app's ownership check
// (a client's session cookie means nothing to a Worker on a different
// origin/runtime), R2-scoped credentials issued to that Worker specifically,
// and a NEW deploy pipeline alongside the existing rsync-based one
// (.github/workflows/deploy.yml) — none of which exists in this repo today.
// That is a legitimate, separate infrastructure task, not a "download all"
// button, and this feature entered this slice explicitly marked "nice to
// have... do not let this block delivery" (kanban #29's own body).
//
// What makes the droplet acceptable ANYWAY for now — the actual exception,
// written down here for the next reader per this task's own instruction:
// this route NEVER buffers. `src/lib/zip-stream.ts` streams each entry
// through — one R2 object open at a time (`ZipEntry.openStream` is a lazy
// factory, invoked only when that entry's turn arrives, see that module's
// own comment) — and STORE-only (no re-compression of already-JPEG bytes),
// so peak memory is "one entry's current chunk plus a handful of tiny
// per-entry bookkeeping records", NOT "the whole gallery" and not even "one
// whole final". scripts/measure-zip-memory.ts measures this directly rather
// than assuming it: see that script's own output/comments for the numbers,
// and its own explicit caveat about which of those numbers are authoritative
// (this was run on a macOS laptop; the 768M cap belongs to a Linux droplet —
// `process.resourceUsage().maxRSS` units differ by platform, see that
// script's own comment and kanban #57's own note). If this shape is ever
// revisited (e.g. once this app needs a Worker for another reason, or once
// gallery sizes grow enough that per-request wall-clock time on the droplet
// becomes the bottleneck instead of memory), the Worker path is still the
// architecturally cleaner one — this route's existence is a scoped,
// deliberate exception, not a reversal of PLAN.md §5's rule.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleries } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { canReadFinalDeliverable } from "@/lib/final-access";
import { isGalleryOwner } from "@/lib/gallery-access";
import { notifyAdminOfMissingFinal } from "@/lib/missing-final-notification-email";
import { getObjectSize, getObjectStream } from "@/lib/r2";
import {
  buildZipStream,
  checkZip32Limits,
  toReadableStream,
  ZIP32_MAX_ENTRY_COUNT,
  type ZipEntry,
} from "@/lib/zip-stream";

export const runtime = "nodejs";

const galleryIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** Strips a filename's extension — duplicated from
 * src/app/api/assets/[assetId]/final/route.ts's own `stripExtension` rather
 * than imported, matching that file's own documented stance (see its header
 * comment on `parseContentLength`): each route owns its own small validation
 * helpers instead of sharing them through a grab-bag utility module. */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Same slugifier as buildFinalDownloadFilename's own — ASCII-only
 * `[a-z0-9-]` output by construction, which is what makes both this
 * function's result and buildZipEntryFilename's result below safe to embed
 * in a `Content-Disposition` header / a zip entry name without any
 * quote/CRLF/emoji-specific escaping: there is nothing in the OUTPUT
 * alphabet those characters could ever survive as. Duplicated for the same
 * reason as stripExtension above. */
function slugifyForFilename(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The archive's own download filename — same spirit as
 * buildFinalDownloadFilename (task #28): a slugified gallery title, never a
 * gallery id, always ending in `.zip`. Falls back to "galeria" for a title
 * that slugifies to nothing (e.g. emoji-only), same as that function. */
export function buildZipDownloadFilename(galleryTitle: string): string {
  const gallerySlug = slugifyForFilename(galleryTitle) || "galeria";
  return `${gallerySlug}-fotos.zip`;
}

/** One entry's name INSIDE the archive: the asset's own original filename
 * (recognizable to the client, same reasoning as buildFinalDownloadFilename),
 * slugified and always `.jpg` (`processFinal` always outputs JPEG). `used`
 * is the set of names already assigned to EARLIER entries in the same
 * archive — two assets can share an original filename (a camera's own
 * numbering resetting across cards/sessions is common), and a zip with two
 * entries of the same name silently loses one of them in most readers, so a
 * collision gets a numeric suffix instead of colliding. */
export function buildZipEntryFilename(originalFilename: string, used: Set<string>): string {
  const base = slugifyForFilename(stripExtension(originalFilename)) || "foto";
  let candidate = `${base}.jpg`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}.jpg`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return. The
// response streamed below is still a `new NextResponse(readableStream,
// init)` — a real `NextResponse` instance, just constructed directly instead
// of via `NextResponse.json()` — so it fits `withApiSession`'s
// `Promise<NextResponse>` return type without any widening: `NextResponse`'s
// constructor accepting a `ReadableStream` body is what makes streaming
// possible at all here, and that capability lives entirely in the `Response`
// this route builds, not in anything the wrapper's signature would need to
// know about.
export const GET = withApiSession(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
  session,
): Promise<NextResponse> {
  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) {
    return errorResponse("invalid_gallery_id", 400);
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, galleryIdResult.data))
    .limit(1);
  if (!gallery) {
    return errorResponse("gallery_not_found", 404);
  }

  // Ownership — one of the gallery's OWN clients (task #94 — several are
  // possible now), or an admin. Same rule as every sibling route
  // (src/lib/asset-access.ts's loadOwnedAsset, the submit-selection route's
  // own gate 1), shared through src/lib/gallery-access.ts's isGalleryOwner
  // rather than a rewritten comparison — see that module's header comment.
  // 403, not a redirect, not a 404: the gallery id is a random UUID
  // (schema.ts), not sequential, so confirming "this id exists" here leaks
  // nothing an attacker could walk — same reasoning submit-selection's own
  // comment gives.
  const isAdmin = session.user.role === "admin";
  if (!(await isGalleryOwner(gallery.id, session))) {
    return errorResponse("forbidden", 403);
  }

  // Delivered gate — non-admin only, same admin-preview carve-out as
  // GET /api/assets/[assetId]/final's own gate (see that route's own long
  // comment for the full reasoning): the photographer can zip-preview their
  // own uploads before delivering, a client can never reach a final before
  // the gallery is actually delivered.
  if (!isAdmin && gallery.status !== "delivered") {
    return errorResponse("gallery_not_delivered", 404);
  }

  // The exact same gate GET .../final enforces PER ASSET, via the ONE
  // shared predicate (task #103 — see src/lib/final-access.ts's own header
  // comment on why two copies of a four-condition boolean drift the first
  // time one is edited). This is the one gate this whole route exists to
  // get right — it hands over an entire gallery's paid deliverables in a
  // single request, so there is no "close enough" here. An asset the client
  // never selected, or one the photographer never finished editing, must
  // never end up in the archive even if it happens to carry a stray
  // `finalKey` (e.g. a mistaken upload — see the final route's own POST
  // handler comment on why `finalKey` alone is never treated as
  // sufficient). Calling `canReadFinalDeliverable` here re-checks the
  // delivered/admin-carve-out leg this route already gated above at the
  // GALLERY level — redundant for a non-admin (the gallery-level check
  // above already ensures it), harmless for an admin (same carve-out
  // either way), and it is what keeps this filter from EVER drifting from
  // the gate `GET .../final` enforces per asset.
  const assetRows = await db
    .select({
      originalFilename: assets.originalFilename,
      finalKey: assets.finalKey,
      isSelected: assets.isSelected,
      isEdited: assets.isEdited,
      sortOrder: assets.sortOrder,
    })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));

  const deliverable = assetRows
    .filter((asset): asset is typeof asset & { finalKey: string } =>
      canReadFinalDeliverable(asset, gallery, session),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (deliverable.length === 0) {
    return errorResponse("no_finals_available", 404);
  }

  // Cheap half of the pre-flight capacity check (review follow-up on task
  // #29) — entry COUNT is known from the DB rows already in hand, no R2
  // round trip needed to rule this out. Checked first, before a single
  // `getObjectSize` HEAD request goes out, so a gallery that's already
  // disqualified by count alone never pays for N needless HEAD calls.
  if (deliverable.length > ZIP32_MAX_ENTRY_COUNT) {
    return errorResponse("too_many_files", 413);
  }

  const usedNames = new Set<string>();
  // Computed once, up front, and reused below for both the capacity check
  // and the entries themselves — `buildZipEntryFilename` mutates `usedNames`
  // as it dedupes, so it must run in this exact order exactly once, not be
  // re-derived a second time for the check.
  const zipEntryNames = deliverable.map((asset) =>
    buildZipEntryFilename(asset.originalFilename, usedNames),
  );

  // The rest of the pre-flight capacity check: every entry's R2 object
  // size, via a HEAD request each (`getObjectSize` — no bytes read, no
  // stream opened). This MUST run, and complete, before `getObjectStream`
  // is ever called below: this format's writer (src/lib/zip-stream.ts) has
  // no way to abort mid-archive without truncating an already-sent HTTP
  // response, so the only place a clean refusal for the BYTE ceiling can
  // happen is before the first byte goes out. See `checkZip32Limits`'s own
  // comment for why this exists at all — the format's fixed 32-bit/16-bit
  // header fields, and what crossing them does if this check weren't here.
  //
  // N HEAD requests, one per deliverable asset, considered and left
  // UNCAPPED (task #93's own acceptance criterion asks this be written down
  // rather than silently decided): `deliverable.length` is already bounded
  // above by `ZIP32_MAX_ENTRY_COUNT` (65,534) before this point is ever
  // reached, but the real ceiling is PLAN.md §3's own package shape — the
  // largest package caps at 20 included photos, and only an admin can
  // create assets at all, so no real gallery gets anywhere near a fan-out
  // that would matter. Revisit only if that shape changes.
  //
  // TASK #93's DECISION on a HEAD that comes back "not there": a stale
  // `finalKey`, or an object deleted out from under the row, used to reject
  // this whole `Promise.all` and escape as an unhandled 500 (this task's
  // own body). Every entry's own HEAD is now caught individually instead of
  // letting one rejection sink the batch — this is a single request for an
  // entire gallery's paid deliverables, so ONE missing object must not
  // silently take down the other N-1 that are fine. Three options were
  // weighed for what happens to a caller who hits this (same reasoning GET
  // .../final's own header comment spells out in full — read that for the
  // 404-vs-502 tradeoff, not repeated here):
  //   - Skip the missing entr(y/ies) and deliver the rest, logging loudly:
  //     REJECTED. The client asked for "every photo I selected" and would
  //     silently receive fewer, with nothing in the archive itself to tell
  //     them one is missing — this task's own body calls that "its own
  //     quiet wrongness", and this route's whole reason to exist (its own
  //     header comment) is "one button that gets the WHOLE delivered set".
  //   - A 404: rejected for the same reason as GET .../final's own —
  //     `no_finals_available` above already means 404 on THIS route, and
  //     that is a genuinely different situation (nothing to deliver at
  //     all, no data-integrity problem) from "some of what we owe this
  //     client is unexpectedly gone".
  //   - 502, same code (`final_missing`) as GET .../final: chosen, for
  //     the same "our dependency, not your request" reasoning, and because
  //     giving the two download paths the SAME error code for the SAME
  //     underlying gap is what lets a client (or a future admin dashboard)
  //     treat them as one problem, not two.
  const sizePlans: { name: string; size: number }[] = [];
  const missingFilenames: string[] = [];
  await Promise.all(
    deliverable.map(async (asset, index) => {
      try {
        sizePlans[index] = {
          name: zipEntryNames[index]!,
          size: await getObjectSize(asset.finalKey),
        };
      } catch {
        missingFilenames.push(asset.originalFilename);
      }
    }),
  );
  if (missingFilenames.length > 0) {
    // Best-effort — see notifyAdminOfMissingFinal's own comment
    // (src/lib/missing-final-notification-email.ts). Awaited for the same
    // reason GET .../final awaits it: this request is about to end, and the
    // alert must actually have been attempted before it does.
    await notifyAdminOfMissingFinal({ gallery, missingFilenames });
    return errorResponse("final_missing", 502);
  }

  const capacityCheck = checkZip32Limits(sizePlans);
  if (!capacityCheck.ok) {
    return errorResponse(capacityCheck.reason, 413);
  }

  const entries: ZipEntry[] = deliverable.map((asset, index) => ({
    name: zipEntryNames[index]!,
    // Lazy — see zip-stream.ts's own comment on `ZipEntry.openStream`. Each
    // asset's R2 object is only actually opened once every PRIOR entry in
    // this archive has been fully streamed out, never all at once up front.
    openStream: () => getObjectStream(asset.finalKey),
  }));

  const filename = buildZipDownloadFilename(gallery.title);
  const body = toReadableStream(buildZipStream(entries));

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
