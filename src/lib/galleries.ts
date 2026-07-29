// Read-side query for the admin gallery list. Server-only (used from RSC).
//
// Every field returned here that describes commercial terms comes off the
// gallery row's own snapshot columns (`includedPhotosSnapshot`,
// `extraPhotoPriceCopSnapshot`) — never off the joined `package` row's live
// price/quota. That join exists only to show the package's NAME; reading its
// price here would be the exact bug the snapshot columns exist to prevent
// (see schema.ts's comment on `galleries.includedPhotosSnapshot` and the
// epic's central rule).
import "server-only";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleries } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";

export type GalleryWithDetails = {
  id: string;
  title: string;
  publicSlug: string;
  status: Gallery["status"];
  sessionDate: string;
  createdAt: Date;
  // `Date | null`, same reasoning as `GalleryDetail.selectionSubmittedAt`
  // below: populated unconditionally off the row's own column, `null` is the
  // honest "not submitted yet" state, not an absent/optional one.
  selectionSubmittedAt: Date | null;
  client: { id: string; name: string | null; email: string };
  package: { id: number; name: string };
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  photoCount: number;
};

/** Every gallery, with the client and package it is bound to, its frozen
 * terms, and its (derived, never stored) photo count.
 *
 * Ordered by RECENCY OF ACTIVITY, not creation date (task #75) — a gallery's
 * `selectionSubmittedAt` if it has one, else its `createdAt`. A gallery
 * created six months ago that a client submitted this morning is the most
 * recently-active row in the list and must rise to the top; ordering by
 * `createdAt` alone (the previous behavior) would leave it exactly where it
 * was created, indistinguishable from a gallery nobody has touched in
 * months.
 *
 * This ordering is done IN SQL (`COALESCE(...)` below), not as a JS
 * `.sort()` after the fetch, even though this query has no `limit`/`offset`
 * today and either approach would return the same rows in the same order
 * right now. The moment this list is paginated — the obvious next move once
 * the studio has hundreds of galleries — a JS-side sort would be silently
 * wrong: Postgres would pick the wrong N rows for the requested page using
 * its own (unmodified) order, and re-sorting only that wrong subset in JS
 * cannot recover the correct page. Ordering in SQL is the only shape that
 * survives adding `limit`/`offset` later without a rewrite. `createdAt` is
 * `.notNull()` (schema.ts), so `COALESCE` here can never fall through to a
 * NULL — there is no NULLS FIRST/LAST ambiguity to reason about for this
 * particular expression.
 *
 * Depends on `selectionSubmittedAt` surviving unchanged once a gallery
 * leaves `selected` — a future change (e.g. #73's proof-unlock flow) that
 * clears this column on transition back to `proofing` would need to give
 * this sort a replacement "last activity" signal, or a gallery unlocked
 * seconds ago would fall back to its stale `createdAt` and look untouched. */
export async function getGalleriesWithDetails(): Promise<GalleryWithDetails[]> {
  const rows = await db.query.galleries.findMany({
    orderBy: desc(sql`coalesce(${galleries.selectionSubmittedAt}, ${galleries.createdAt})`),
    with: {
      client: { columns: { id: true, name: true, email: true } },
      package: { columns: { id: true, name: true } },
      // Only the id is needed to count — pulling full asset rows here would
      // be wasted work for a list that only ever shows a number (same
      // reasoning as getClientsWithGalleryCount in src/lib/clients.ts).
      assets: { columns: { id: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    publicSlug: row.publicSlug,
    status: row.status,
    sessionDate: row.sessionDate,
    createdAt: row.createdAt,
    selectionSubmittedAt: row.selectionSubmittedAt,
    client: { id: row.client.id, name: row.client.name, email: row.client.email },
    // Narrowed explicitly to id + name — even though the query only selects
    // those two columns (the `with: { package: { columns: ... } }` above),
    // this makes it impossible for a future change to that `columns` list to
    // leak the package's live price/quota through this function without
    // ALSO changing the mapping here (see this file's header comment).
    package: { id: row.package.id, name: row.package.name },
    includedPhotosSnapshot: row.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: row.extraPhotoPriceCopSnapshot,
    photoCount: row.assets.length,
  }));
}

/** How many galleries are sitting in `selected` — submitted by a client and
 * awaiting the photographer's review. Powers the "N selecciones esperando"
 * count on `/dashboard` (task #75), which today reads no database at all;
 * without this, a submission is only visible by opening
 * `/dashboard/galleries` and reading every row's status text. A dedicated
 * `count()` query rather than reusing `getGalleriesWithDetails()` — the
 * dashboard home only needs a number, not every client/package/asset join. */
export async function getPendingSelectionCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(galleries)
    .where(eq(galleries.status, "selected"));
  return row?.value ?? 0;
}

/** Spanish, pluralized copy for `getPendingSelectionCount`'s result. Returns
 * `null` at zero — the dashboard renders nothing in that case rather than a
 * "0 selecciones esperando" that would just be noise (same shape as this
 * file's other `format*` helpers, but zero has no useful sentence here). */
export function formatPendingSelectionCount(pendingCount: number): string | null {
  if (pendingCount <= 0) return null;
  if (pendingCount === 1) return "1 selección esperando";
  return `${pendingCount} selecciones esperando`;
}

// Statuses a CLIENT (not an admin) may view via `/galleries/[publicSlug]`
// (task #23). A `draft` gallery is still being assembled by the
// photographer — PLAN.md §2's diagram has proof upload starting in DRAFT,
// before the client is even meant to know the gallery exists — so it must
// never render for a client, regardless of whether their session otherwise
// owns it. `archived` is future/undecided (PLAN.md §2 marks it "future")
// and deliberately left OUT of this set too, so a status this app doesn't
// have defined client-facing behavior for fails closed instead of silently
// rendering. The page that uses this lets an ADMIN session bypass this
// check entirely, so the photographer can preview a gallery before
// publishing it — see that page's own comment for why.
const CLIENT_VISIBLE_STATUSES = new Set<Gallery["status"]>(["proofing", "selected", "delivered"]);

/** Whether a client (as opposed to an admin) may view this gallery's status
 * via the client gallery page. See `CLIENT_VISIBLE_STATUSES` above for the
 * reasoning behind exactly which statuses are included. */
export function isGalleryVisibleToClient(status: Gallery["status"]): boolean {
  return CLIENT_VISIBLE_STATUSES.has(status);
}

/** Spanish copy for a gallery's workflow state (PLAN.md §2). */
export function formatGalleryStatus(status: Gallery["status"]): string {
  switch (status) {
    case "draft":
      return "Borrador";
    case "proofing":
      return "En pruebas";
    case "selected":
      return "Selección enviada";
    case "delivered":
      return "Entregada";
    case "archived":
      return "Archivada";
  }
}

/** `session_date` is stored as a plain "YYYY-MM-DD" string (no time, no
 * timezone — see schema.ts's `date("session_date")`). Formatting it via `new
 * Date(...)` would parse it as UTC midnight and can render a day off in a
 * timezone behind UTC; splitting the string avoids that entirely. */
export function formatSessionDate(sessionDate: string): string {
  const [year, month, day] = sessionDate.split("-");
  return `${day}/${month}/${year}`;
}

export type GalleryDetailAsset = {
  id: string;
  originalFilename: string;
  proofKey: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  sortOrder: number;
};

export type GalleryDetail = {
  id: string;
  title: string;
  publicSlug: string;
  status: Gallery["status"];
  sessionDate: string;
  createdAt: Date;
  client: { id: string; name: string | null; email: string };
  package: { id: number; name: string };
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  assets: GalleryDetailAsset[];
  // `Date | null`, not optional (task #25's own review): `findGalleryDetail`
  // below populates this UNCONDITIONALLY off the row's own column, so an
  // `undefined` arm can never actually occur — declaring it optional would
  // describe a shape wider than any real value this function ever returns,
  // and every `undefined`-shaped check downstream (this file's own
  // `?.toISOString()` callers) would be dead code no test could ever
  // exercise. `null` is the honest, reachable "not submitted yet" state —
  // `galleries.selectionSubmittedAt` was always nullable for exactly that
  // reason (unset until a client submits, schema.ts).
  selectionSubmittedAt: Date | null;
};

/** Shared by `getGalleryDetail` (admin, looked up by id) and
 * `getGalleryDetailBySlug` (client, looked up by the unguessable
 * `publicSlug` — see schema.ts's comment on that column for why a gallery
 * URL is keyed on the slug, never the id) below: same `with`/mapping shape,
 * different `where`. Returns `null` when no matching row exists, rather
 * than throwing — both callers' pages turn that into a real 404 via
 * `notFound()`. */
async function findGalleryDetail(where: ReturnType<typeof eq>): Promise<GalleryDetail | null> {
  const row = await db.query.galleries.findFirst({
    where,
    with: {
      client: { columns: { id: true, name: true, email: true } },
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
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    publicSlug: row.publicSlug,
    status: row.status,
    sessionDate: row.sessionDate,
    createdAt: row.createdAt,
    client: { id: row.client.id, name: row.client.name, email: row.client.email },
    package: { id: row.package.id, name: row.package.name },
    includedPhotosSnapshot: row.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: row.extraPhotoPriceCopSnapshot,
    assets: row.assets,
    selectionSubmittedAt: row.selectionSubmittedAt,
  };
}

/** A single gallery with every detail its admin workspace page
 * (`/dashboard/galleries/[galleryId]`) needs: the client and package it's
 * bound to, its frozen terms (never the live `packages` row — same rule as
 * `getGalleriesWithDetails` above), and its assets ordered for display
 * (`sort_order` ascending, the same ordering the proof-upload route appends
 * new uploads to the end of). Looked up by the gallery's own id — the admin
 * surface is allowed to use it directly, unlike the client-facing URL (see
 * `getGalleryDetailBySlug` below). */
export async function getGalleryDetail(galleryId: string): Promise<GalleryDetail | null> {
  return findGalleryDetail(eq(galleries.id, galleryId));
}

/** Same detail shape as `getGalleryDetail`, looked up by `publicSlug`
 * instead of `id` — this is what the CLIENT gallery page
 * (`/galleries/[publicSlug]`, task #23) resolves against. schema.ts's own
 * comment on `galleries.publicSlug` is explicit that the slug is the ONLY
 * identifier meant to ever appear in a client-facing URL: the gallery id is
 * sequential-feeling enough (a UUID, but still a stable per-row identifier)
 * that keying the client URL on it would let a client walk other clients'
 * galleries by guessing; the slug is 128 bits of randomness generated by
 * `generateGallerySlug()` specifically so that guessing is infeasible.
 *
 * That said, an unguessable slug is NOT an authorization check by itself —
 * it only stops enumeration. The page calling this still verifies the
 * resolved gallery's `clientId` against the signed-in session before
 * rendering anything; see that page's own comment. */
export async function getGalleryDetailBySlug(publicSlug: string): Promise<GalleryDetail | null> {
  return findGalleryDetail(eq(galleries.publicSlug, publicSlug));
}

export type ClientGalleryListItem = {
  id: string;
  title: string;
  publicSlug: string;
  status: Gallery["status"];
  sessionDate: string;
  photoCount: number;
};

/** Every gallery visible to a CLIENT (task #22's `/galleries` list) —
 * scoped to exactly one user's own galleries and nothing else.
 *
 * `clientId` MUST be the SESSION's own `user.id` (`requireSession()`'s
 * result) — never an id taken from the URL or a form field. This is the
 * task's own core acceptance criterion, and it holds structurally here, not
 * just by caller convention: this function has no "give me everyone's
 * galleries" code path at all, admin or otherwise — `eq(galleries.clientId,
 * clientId)` is unconditional. An admin calling this with their OWN user id
 * (the same way any client would) gets back only galleries where THAT id is
 * the client, i.e. their own — never every gallery in the system, which is
 * the separate, deliberately-unfiltered job `getGalleriesWithDetails` above
 * does for the ADMIN workspace.
 *
 * Also filters to `CLIENT_VISIBLE_STATUSES` (defined above,
 * `isGalleryVisibleToClient`'s own backing set) in the SAME `where`, so a
 * `draft` gallery is invisible here even though it already belongs to this
 * client — the photographer is still assembling it, see that set's own
 * comment for why draft must never reach a client. Done as a SQL `inArray`,
 * not a post-fetch `.filter()`, for the same pagination-safety reason
 * `getGalleriesWithDetails`'s header comment gives for its `orderBy`: once
 * this list is paginated, filtering in JS after the DB has already picked a
 * page would silently return the wrong rows. */
export async function getGalleriesForClient(clientId: string): Promise<ClientGalleryListItem[]> {
  const rows = await db.query.galleries.findMany({
    where: and(
      eq(galleries.clientId, clientId),
      inArray(galleries.status, [...CLIENT_VISIBLE_STATUSES]),
    ),
    orderBy: desc(galleries.sessionDate),
    with: {
      // Only the id is needed to count — same reasoning as
      // `getGalleriesWithDetails` above.
      assets: { columns: { id: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    publicSlug: row.publicSlug,
    status: row.status,
    sessionDate: row.sessionDate,
    photoCount: row.assets.length,
  }));
}

// ---------------------------------------------------------------------------
// Unlock audit trail (task #73) — read side. See
// src/app/dashboard/galleries/actions.ts's `unlockSelection` for the write
// side and the full reasoning behind what is/isn't recorded here.
// ---------------------------------------------------------------------------

export type GalleryUnlockAudit = {
  unlockedAt: Date | null;
  /** The acting admin's own session email, snapshotted at unlock time — see
   * schema.ts's comment on `galleries.unlockedByEmail` for why this is a
   * plain column, not a foreign key. `null` means this gallery has never
   * been unlocked. */
  unlockedByEmail: string | null;
  unlockReason: string | null;
};

/** The unlock audit trail for a single gallery: who last unlocked a
 * submitted selection back to `proofing`, when, and any note they left.
 *
 * A DEDICATED, minimal query — not folded into the shared
 * `GalleryDetail`/`findGalleryDetail` above — on purpose: this is
 * ADMIN-ONLY audit detail (the reason especially may record a private note
 * about a client conversation) that `getGalleryDetailBySlug` must never
 * hand to the client-facing gallery page. Folding these columns into the
 * shared type would also force every existing caller of that type
 * (including the client gallery page and its own tests, well outside this
 * task's footprint) to grow three fields with no benefit to them.
 *
 * Safe to call for a gallery that has never been unlocked: every column is
 * nullable and `null` is the honest "never happened" state — same "always
 * populate off the row, `null` means it never happened" stance as
 * `GalleryDetail.selectionSubmittedAt` above. Returns `null` only when no
 * gallery with this id exists at all, matching `findGalleryDetail`'s own
 * "not found" convention. */
export async function getGalleryUnlockAudit(galleryId: string): Promise<GalleryUnlockAudit | null> {
  const [row] = await db
    .select({
      unlockedAt: galleries.unlockedAt,
      unlockedByEmail: galleries.unlockedByEmail,
      unlockReason: galleries.unlockReason,
    })
    .from(galleries)
    .where(eq(galleries.id, galleryId))
    .limit(1);
  return row ?? null;
}
