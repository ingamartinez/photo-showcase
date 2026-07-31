// Task #138 — the batched replacement for the `galleries` resolver's N+1.
//
// THE BUG this file exists to fix: `query.ts`'s `galleries` field used to do
// `Promise.all(own.map((row) => getGalleryDetail(row.id)))` — one
// `getGalleryDetail` call per owned gallery, each of which is itself a
// `db.query.galleries.findFirst` with three joined relations. A client with N
// galleries triggered roughly 1 + 4N queries for one field.
//
// This function fetches the SAME shape `getGalleryDetail` returns
// (`GalleryDetail`, src/lib/galleries.ts) for a whole batch of ids in exactly
// ONE relational query — `inArray(galleries.id, ids)` instead of one `eq()`
// per id — mirroring the pattern `getGalleriesWithDetails` in that same file
// already uses for its own studio-wide listing.
//
// WHY THIS DOES NOT LIVE IN src/lib/galleries.ts, where `findGalleryDetail`'s
// `with`/mapping shape it mirrors already lives: at the time this was
// written, a sibling lane was editing that file's `deliverGallery` region in
// parallel, and touching it here would have collided with that work. The
// `with` clause and the row-to-`GalleryDetail` mapping below are therefore a
// deliberate, temporary duplication of `findGalleryDetail`'s private
// implementation (not exported) — NOT a second, independently-derived
// authorization or business rule. This function does no authorization
// filtering of its own: the caller (`query.ts`'s `galleries` field) already
// narrowed `ids` to exactly the galleries `getGalleriesForClient` decided the
// signed-in session may see, and this function trusts that set completely
// rather than re-deriving it. If a future change touches
// `findGalleryDetail`'s `with` shape, this file's copy should be folded back
// into `src/lib/galleries.ts` as a single shared helper rather than
// maintained as two copies indefinitely — see kanban #86/#87/#88/#91/#96 for
// why this codebase treats "two copies of one rule" as its own bug class.
import "server-only";

import { inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleries, galleryClients } from "@/lib/db/schema";
import type { GalleryDetail } from "@/lib/galleries";

/** Every `GalleryDetail` for the given ids, in ONE query regardless of how
 * many ids are passed — see this file's header comment for the full
 * reasoning. Returns `[]` immediately, without touching the database at all,
 * for an empty `ids` array (an `inArray` with no candidates is at best a
 * wasted round trip and at worst renders `IN ()`, which some drivers reject).
 *
 * Row order is NOT guaranteed to match `ids`' order — callers that care about
 * ordering (the `galleries` resolver, to preserve `getGalleriesForClient`'s
 * own recency order) must re-sort by `id` themselves. Silently returns fewer
 * rows than ids requested when some no longer exist, matching
 * `getGalleryDetail`'s own "not found comes back as absence, never a thrown
 * error" convention. */
export async function getGalleryDetailsByIds(ids: readonly string[]): Promise<GalleryDetail[]> {
  if (ids.length === 0) return [];

  const rows = await db.query.galleries.findMany({
    where: inArray(galleries.id, [...ids]),
    with: {
      // Identical shape to `findGalleryDetail`'s own `with` clause
      // (src/lib/galleries.ts) — see this file's header comment for why it
      // is duplicated here rather than imported.
      galleryClients: {
        where: isNull(galleryClients.removedAt),
        with: { user: { columns: { id: true, name: true, email: true } } },
      },
      package: { columns: { id: true, name: true } },
      assets: {
        orderBy: (assetsTable, { asc: assetAsc }) => [assetAsc(assetsTable.sortOrder)],
        columns: {
          id: true,
          originalFilename: true,
          proofKey: true,
          proofWidth: true,
          proofHeight: true,
          isSelected: true,
          sortOrder: true,
          finalKey: true,
          isEdited: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    publicSlug: row.publicSlug,
    status: row.status,
    sessionDate: row.sessionDate,
    createdAt: row.createdAt,
    clients: row.galleryClients.map((gc) => ({
      id: gc.user.id,
      name: gc.user.name,
      email: gc.user.email,
    })),
    package: { id: row.package.id, name: row.package.name },
    includedPhotosSnapshot: row.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: row.extraPhotoPriceCopSnapshot,
    assets: row.assets,
    selectionSubmittedAt: row.selectionSubmittedAt,
  }));
}
