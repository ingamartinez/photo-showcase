// Task #92 — "warn the photographer before a gallery outgrows the zip
// download": the photographer is who uploads the finals that make a
// gallery too large, and today finds out only when a client who already
// paid clicks "descargar todo" and gets refused by
// GET /api/galleries/[galleryId]/download-all's own pre-flight (task #29's
// `checkZip32Limits`). This module answers the SAME question that pre-
// flight asks — "how big would this gallery's archive be" — from the
// gallery detail page instead, so the photographer sees it BEFORE a client
// ever hits refuse.
//
// Reuses #29's own primitives rather than restating them: `getObjectSize`
// (src/lib/r2.ts, a HEAD-only lookup — no bytes read, same guarantee
// download-all's own pre-flight relies on) for each deliverable's size, and
// `computeZipArchiveByteSize`/`ZIP32_MAX_TOTAL_BYTES`/`ZIP32_MAX_ENTRY_COUNT`
// (src/lib/zip-stream.ts) for the exact ceiling download-all itself refuses
// against — this warning fires off the SAME numbers, so it can never say
// "you're fine" the moment before download-all says "refused".
import "server-only";
import { getObjectSize } from "@/lib/r2";
import {
  computeZipArchiveByteSize,
  ZIP32_MAX_ENTRY_COUNT,
  ZIP32_MAX_TOTAL_BYTES,
  type ZipEntrySizePlan,
} from "@/lib/zip-stream";

/** The same shape `download-all`'s own filter admits into the archive —
 * `isSelected && isEdited && finalKey` — reimplemented here rather than
 * imported from `src/lib/final-access.ts`'s `canReadFinalDeliverable`:
 * that predicate also takes a `gallery` (for the delivered/admin-carve-out
 * leg) and a `Session` (to decide whether the carve-out applies) because its
 * job is session-scoped AUTHORIZATION — "may THIS caller reach this
 * deliverable right now". This module answers a different question — "how
 * big WOULD the archive be" — from a page already gated by `requireAdmin()`
 * before this is ever called, so there is no session to thread through and
 * no delivered-status leg to apply. Pulling in a predicate built for
 * per-request authorization would be the wrong abstraction here, not a
 * saving; the three per-asset conditions are the part actually shared, and
 * they are exactly what this repeats. */
function isDeliverable<
  A extends { isSelected: boolean; isEdited: boolean; finalKey: string | null },
>(asset: A): asset is A & { finalKey: string } {
  return asset.isSelected && asset.isEdited && !!asset.finalKey;
}

export type ArchiveSizeStatus = "ok" | "approaching" | "over";

export type GalleryArchiveSize = {
  status: ArchiveSizeStatus;
  totalBytes: number;
  entryCount: number;
};

/** Same ratio applied to BOTH ceilings (bytes and entry count) — whichever
 * is closer to its own limit decides the status. Not a number #29 or #93
 * ever specified; it is this task's own judgment call, chosen so the
 * warning fires with real runway left to act (lighter exports, split the
 * delivery) rather than the instant before `download-all` would refuse. */
const WARNING_RATIO = 0.8;

/**
 * `null` when the gallery has no deliverable asset yet — the common case
 * for a `draft`/`proofing` gallery, and the guard that keeps this from ever
 * issuing an R2 HEAD request for a gallery no client could download in the
 * first place. This is what keeps the cost "per gallery, paid where it is
 * worth paying" (task #92's own acceptance criterion): the caller decides
 * WHEN to call this (the gallery detail page, never a list of galleries),
 * and this function itself skips the R2 round trips entirely until there is
 * something to size.
 *
 * An individual HEAD that itself fails (task #93's own gap — a stale
 * `finalKey`, an object deleted out from under the row) counts as a 0-byte
 * contribution to the total, and is NOT surfaced as an error here: sizing a
 * hypothetical download is this function's job, auditing data integrity is
 * not — that alarm already exists, on the paths that actually attempt a
 * download (`notifyAdminOfMissingFinal`, task #93). Firing it again here
 * would mean a photographer looking at ONE gallery's detail page could
 * trigger the same alert email on every render.
 */
export async function getGalleryArchiveSize(
  assets: { finalKey: string | null; isSelected: boolean; isEdited: boolean }[],
): Promise<GalleryArchiveSize | null> {
  const deliverable = assets.filter(isDeliverable);
  if (deliverable.length === 0) return null;

  const sizePlans: ZipEntrySizePlan[] = await Promise.all(
    deliverable.map(async (asset): Promise<ZipEntrySizePlan> => {
      let size = 0;
      try {
        size = await getObjectSize(asset.finalKey);
      } catch {
        // See this function's own header comment on why a missing object
        // is not this function's alarm to raise.
      }
      return { name: asset.finalKey, size };
    }),
  );

  const totalBytes = computeZipArchiveByteSize(sizePlans);
  const entryCount = deliverable.length;
  const byteRatio = totalBytes / ZIP32_MAX_TOTAL_BYTES;
  const entryRatio = entryCount / ZIP32_MAX_ENTRY_COUNT;
  const ratio = Math.max(byteRatio, entryRatio);

  const status: ArchiveSizeStatus =
    ratio >= 1 ? "over" : ratio >= WARNING_RATIO ? "approaching" : "ok";

  return { status, totalBytes, entryCount };
}
