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
import { galleries, galleryClients } from "@/lib/db/schema";
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
  // PLURAL since task #94 — a gallery can now belong to several clients (a
  // couple's own separate logins, a family, two businesses sharing a
  // shoot). Order matches the DB join's own row order (see
  // `getGalleriesWithDetails`'s query below); this list is for DISPLAY only
  // ("which humans is this gallery for"), never for an ownership decision —
  // see src/lib/gallery-access.ts for the one function that answers that.
  clients: { id: string; name: string | null; email: string }[];
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
      // Task #94: `client` (a single `one()` relation off the old
      // `clientId` FK) became `galleryClients` (a join table, `many()`) —
      // each row here carries the joined `user` alongside it, mapped below
      // into the plural `clients` list this function now returns.
      galleryClients: { with: { user: { columns: { id: true, name: true, email: true } } } },
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
    clients: row.galleryClients.map((gc) => ({
      id: gc.user.id,
      name: gc.user.name,
      email: gc.user.email,
    })),
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
  // `null` for every asset that has never had a final uploaded — most
  // assets, since finals exist only for selected ones (schema.ts's comment
  // on `assets.finalKey`). The admin workspace (task #26) uses this to show
  // which SELECTED assets still lack a final, not to build a client-facing
  // download URL — that always goes through the presigned read route
  // (src/app/api/assets/[assetId]/final/route.ts), never this raw key.
  finalKey: string | null;
  isEdited: boolean;
};

export type GalleryDetail = {
  id: string;
  title: string;
  publicSlug: string;
  status: Gallery["status"];
  sessionDate: string;
  createdAt: Date;
  // PLURAL since task #94 — see `GalleryWithDetails.clients`'s own comment
  // above for why, and src/lib/gallery-access.ts for the ownership check
  // this list must never substitute for.
  clients: { id: string; name: string | null; email: string }[];
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
      // Task #94: see `getGalleriesWithDetails`'s own comment on the
      // identical `galleryClients` shape above.
      galleryClients: { with: { user: { columns: { id: true, name: true, email: true } } } },
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

  if (!row) return null;

  return {
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
 * signed-in session against the resolved gallery's own clients (task #94 —
 * src/lib/gallery-access.ts's `isGalleryOwner`) before rendering anything;
 * see that page's own comment. */
export async function getGalleryDetailBySlug(publicSlug: string): Promise<GalleryDetail | null> {
  return findGalleryDetail(eq(galleries.publicSlug, publicSlug));
}

export type GalleryClientContact = { id: string; name: string | null; email: string };

/** Every client attached to one gallery, for the WRITE side (task #94):
 * `src/app/dashboard/galleries/actions.ts`'s publish/unlock/deliver actions
 * each used to look up exactly one client via the old `clientId` FK; now
 * that a gallery can have several, they call this instead of joining
 * `gallery_clients` themselves three separate times. A dedicated, minimal
 * query — not folded into `findGalleryDetail` above — because those actions
 * only ever need id/name/email, never the rest of `GalleryDetail`'s shape
 * (assets, package, snapshot terms).
 *
 * Returns an EMPTY array, never throws, when a gallery has no clients
 * attached — `gallery-form.tsx` requires picking at least one at creation
 * (see schema.ts's comment on `galleryClients` for why the database itself
 * cannot enforce that lower bound), so an empty result here would mean the
 * requirement was bypassed somehow (a manual DB edit, a bug), not a normal
 * state — every caller must decide what to do with zero clients rather than
 * assuming at least one, which is exactly why this returns a list instead of
 * throwing or returning `null`. */
export async function getGalleryClients(galleryId: string): Promise<GalleryClientContact[]> {
  const rows = await db.query.galleryClients.findMany({
    where: eq(galleryClients.galleryId, galleryId),
    with: { user: { columns: { id: true, name: true, email: true } } },
  });
  return rows.map((row) => ({ id: row.user.id, name: row.user.name, email: row.user.email }));
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
 * galleries" code path at all, admin or otherwise.
 *
 * Task #94 replaced the single `clientId` FK with the `galleryClients` join
 * table — a gallery can now belong to several clients — but this function's
 * NO-ADMIN-BYPASS property is unchanged and re-proven by mutation in this
 * file's own test suite: the `where` below is still an unconditional filter
 * to galleries where the GIVEN id is attached (expressed as a subquery
 * against `gallery_clients`, `inArray(galleries.id, <ids this user is
 * attached to>)`, since a gallery can now match on more than one row), never
 * a `role === "admin"` check anywhere in this function. An admin calling
 * this with their OWN user id (the same way any client would) gets back only
 * galleries THAT id is attached to, i.e. their own (almost certainly none) —
 * never every gallery in the system, which is the separate,
 * deliberately-unfiltered job `getGalleriesWithDetails` above does for the
 * ADMIN workspace. `isGalleryOwner` (src/lib/gallery-access.ts), by
 * contrast, DOES bypass for an admin — that is the correct rule for a
 * single-gallery access check, and a DIFFERENT question from this one; see
 * that module's own header comment for why the two must not be conflated.
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
      // Task #98 (production incident): this used to be a raw `sql`
      // template — `sql`${galleries.id} in (select ${galleryClients.galleryId}
      // from ${galleryClients} where ...)`` — on the stated theory that a
      // single plain SQL expression built out of `eq`/`inArray`/`sql` alone,
      // with no second query-builder chain buried inside it, would be easier
      // to reason about than a nested `db.select(...)`. That theory is
      // false for THIS query, and broke `/galleries` in production: inside
      // `db.query.galleries.findMany`, Drizzle's relational query builder
      // aliases the root table as `"galleries"`, and column references
      // embedded in a raw `sql` template inherit THAT alias instead of
      // their own table's — so `${galleryClients.galleryId}` and
      // `${galleryClients.userId}` above both rendered as
      // `"galleries"."gallery_id"` / `"galleries"."user_id"`, columns that
      // don't exist. The query-builder subquery below has no such problem:
      // `db.select(...).from(...).where(...)` qualifies its own columns
      // against ITS OWN `from`, independent of whatever alias the outer
      // relational query happens to use. Any raw `sql` template that
      // references a table OTHER than the relational query's root table is
      // this same trap waiting to fire — see
      // galleries.query-rendering.test.ts, which asserts on the SQL the
      // real relational query builder actually renders rather than the
      // expression in isolation, precisely because that isolation is what
      // let this ship.
      inArray(
        galleries.id,
        db
          .select({ id: galleryClients.galleryId })
          .from(galleryClients)
          .where(eq(galleryClients.userId, clientId)),
      ),
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

// ---------------------------------------------------------------------------
// Studio-wide gallery total (task #88) — read side for the `/dashboard`
// index, which until this task read exactly one thing from the database
// (`getPendingSelectionCount` above) and hardcoded everything else,
// including the empty state, even after #18/#19 gave the studio real
// clients and galleries. See src/app/dashboard/page.tsx's header comment.
// ---------------------------------------------------------------------------

/** How many galleries exist, total, across every status. Powers the
 * "Galerías" summary on `/dashboard` (task #88) — a dedicated `count()`
 * query, same reasoning as `getPendingSelectionCount` above: the dashboard
 * index only needs a number, not `getGalleriesWithDetails().length`, which
 * would pull every gallery's client/package/asset joins just to discard
 * everything but a count. */
export async function getGalleryCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(galleries);
  return row?.value ?? 0;
}

/** Spanish, pluralized copy for `getGalleryCount`'s result — the total
 * gallery count on `/dashboard` (task #88). Distinct from `formatGalleryCount`
 * in src/lib/clients.ts, which describes how many galleries belong to ONE
 * client, not the studio-wide total. */
export function formatGalleryCountTotal(galleryCount: number): string {
  if (galleryCount === 1) return "1 galería";
  return `${galleryCount} galerías`;
}
