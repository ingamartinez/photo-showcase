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

import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleries, galleryClients } from "@/lib/db/schema";
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
      //
      // Task #97: `where: isNull(galleryClients.removedAt)` — this is the
      // ADMIN GALLERY LIST, and a removed client is no longer one of this
      // gallery's clients for display purposes here, the same way they no
      // longer own it per src/lib/gallery-access.ts's `isGalleryOwner`. A
      // removed row still exists in the database (soft delete, schema.ts's
      // own comment), it just never surfaces through this read.
      galleryClients: {
        where: isNull(galleryClients.removedAt),
        with: { user: { columns: { id: true, name: true, email: true } } },
      },
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

// `formatPendingSelectionCount` (this count's Spanish copy) moved to
// `@/lib/format` by task #122 — see that module's section comment for why.

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

/** Whether a gallery in this status must have at least one ACTIVE client
 * attached (task #97). `draft` is the one exception: a `draft` gallery is
 * still being set up, while a `proofing`/`selected`/`delivered` gallery
 * nobody is attached to is a dead end nobody can ever open.
 *
 * This is HALF of the rule — the status half. It says which statuses care,
 * not whether a given gallery satisfies it. Nothing enforces anything with
 * this function alone: `activeClientRuleViolation()` right below is the ONE
 * place the two halves (status + active-client count) are put together, and
 * it is the only runtime consumer of this function in the codebase. Kept
 * exported because it is the crisp, table-testable statement of exactly
 * which statuses are involved (see galleries.test.ts) — NOT so that a caller
 * can rebuild the conjunction itself. If you are about to write
 * `requiresActiveClient(x) && someCount === 0`, you are writing the second
 * copy of a rule that already exists; call `activeClientRuleViolation()`
 * instead. Two copies of one rule is the bug shape this project keeps
 * shipping (kanban #86/#87/#88/#91/#96). */
export function requiresActiveClient(status: Gallery["status"]): boolean {
  return status !== "draft";
}

/** The operation being attempted, used only to pick which Spanish sentence
 * `activeClientRuleViolation()` returns. The RULE is identical for all
 * three; what differs is what the admin should do about it. */
export type ActiveClientRuleAction = "publish" | "deliver" | "remove-client";

const ACTIVE_CLIENT_RULE_MESSAGES: Record<ActiveClientRuleAction, string> = {
  publish:
    "Esta galería todavía no tiene ningún cliente activo. Agregale al menos uno antes de " +
    "publicarla — si no, el correo con el enlace no le llega a nadie.",
  deliver:
    "Esta galería no tiene ningún cliente activo. Agregale al menos uno antes de entregarla — " +
    "si no, nadie recibe el aviso ni puede abrir las fotos.",
  // Task #97's own wording, kept verbatim when its inline guard was folded
  // into this function by task #100 — the operation's copy did not change,
  // only where the condition lives.
  "remove-client":
    "No podés quitar al último cliente activo de una galería que ya no está en borrador — " +
    "agregá otro cliente antes de quitar este, o la galería queda sin nadie que pueda entrar.",
};

/**
 * THE rule, in the one place it exists (task #100): **a gallery past `draft`
 * has at least one active client.**
 *
 * Returns the Spanish refusal to show the admin, or `null` when the rule
 * holds. Callers never re-derive the condition — they ask this function and
 * surface whatever string it hands back.
 *
 * `activeClientCount` is the count the operation would LEAVE BEHIND, and
 * `targetStatus` is the status the gallery would BE IN afterwards. Both are
 * about the destination, not the present, which is what makes one function
 * able to serve three different operations:
 *   - `publishGallery`  — target `proofing`, count unchanged. A `draft`
 *     gallery may legitimately sit at zero clients (task #97 made that
 *     reachable, task #100 made it creatable); `proofing` may not. Asking
 *     about the CURRENT status here would answer the wrong question and
 *     permit exactly what this refuses.
 *   - `deliverGallery`  — target `delivered`, count unchanged.
 *   - `removeGalleryClient` — target = the gallery's current status (removal
 *     moves nothing), count = active memberships MINUS the one being removed.
 *
 * WHO CONSULTS IT (grep `activeClientRuleViolation` — this list is checkable,
 * not a promise):
 *   - the three server actions above, in src/app/dashboard/galleries/
 *     actions.ts. These are the AUTHORITY.
 *   - the gallery detail page (src/app/dashboard/galleries/[galleryId]/
 *     page.tsx), twice: to hide "Quitar" and to replace the publish button
 *     with the reason it cannot be used. UX only — every action re-checks
 *     regardless of what was rendered, the same stance `isDeliverable` and
 *     friends already take.
 *
 * A Postgres trigger pair (drizzle/0005_gallery-active-client-trigger.sql)
 * enforces the same invariant as a BACKSTOP, for hand-written SQL against
 * production. It is deliberately NOT the primary check: the application must
 * know the answer before it writes, so the admin gets this sentence instead
 * of a stack trace. Never restructure a caller to rely on catching that
 * exception.
 */
export function activeClientRuleViolation({
  targetStatus,
  activeClientCount,
  action,
}: {
  targetStatus: Gallery["status"];
  activeClientCount: number;
  action: ActiveClientRuleAction;
}): string | null {
  if (activeClientCount > 0) return null;
  if (!requiresActiveClient(targetStatus)) return null;
  return ACTIVE_CLIENT_RULE_MESSAGES[action];
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

/** The `with` clause for the full gallery-detail projection — shared, as of
 * task #154, by every reader of that projection: `findGalleryDetail` (single
 * gallery, below) and `getGalleryDetailsByIds` (batched, below). Both pass
 * this SAME object to Drizzle rather than each carrying their own copy.
 *
 * History worth keeping: task #138 needed a batched read to kill the
 * `galleries` GraphQL resolver's N+1, but at the time a sibling lane held
 * this file (the `deliverGallery` region, task #85), so its brief told it to
 * escalate rather than edit here. It added `src/lib/graphql/gallery-details-
 * by-ids.ts` with its OWN, independently-typed copy of this exact shape — a
 * real, temporary duplication of a schema projection, not a difference in
 * what either caller is allowed to see. That file now just re-exports
 * `getGalleryDetailsByIds` from here.
 *
 * What sharing this constant (and `toGalleryDetail` below) actually buys:
 * ONE place to edit when the projection's shape changes — a new relation, a
 * narrowed `columns` list, whatever — so both callers pick up that change
 * the moment this file compiles, instead of one of them silently keeping the
 * old shape until someone remembers a second file exists. It does NOT add
 * any new authorization or runtime enforcement; see `getGalleryDetailsByIds`
 * below for the auth contract, which this consolidation does not change. See
 * galleries.test.ts's "a shape change reaches both callers" test, which
 * demonstrates this rather than asserting it. */
// `as const` below is load-bearing, not decoration: without it, TypeScript
// widens `columns: { id: true, ... }`'s `true` literals to plain `boolean`,
// and Drizzle's relational-query result inference keys off the LITERAL
// `true`/`false` to decide which columns a row actually carries — a widened
// `boolean` matches neither branch, and every relation below (`assets`,
// `galleryClients.user`) silently types as `{}` instead of the real row
// shape. That failure mode is invisible until a caller tries to read a
// field off the result, which is exactly why `toGalleryDetail` below reading
// `row.assets`, `row.galleryClients[i].user.id`, etc. is what caught it.
const galleryDetailWith = {
  // Task #94/#97: see `getGalleriesWithDetails`'s own comment on the
  // identical `galleryClients` shape (including the `removedAt` filter)
  // above — this powers the admin detail page, the client-facing
  // `/galleries/[publicSlug]` page (via `getGalleryDetailBySlug` below), AND
  // the batched GraphQL read (`getGalleryDetailsByIds` below), none of which
  // should ever list a removed client as one of the gallery's own.
  galleryClients: {
    where: isNull(galleryClients.removedAt),
    with: { user: { columns: { id: true, name: true, email: true } } },
  },
  package: { columns: { id: true, name: true } },
  assets: {
    // A direct column reference (`asc(assets.sortOrder)`), not the
    // relational-callback form (`(assetsTable, { asc }) => ...`) the
    // pre-extraction version of this clause used: the callback form's
    // parameter types are inferred from the SPECIFIC `db.query.<table>.
    // find*()` call site it is written inside, and are lost (both resolve to
    // `{}`) once the clause is lifted into a standalone object shared across
    // call sites, as this one now is. `assets` (the table, imported above)
    // is available at module scope regardless of which query uses this
    // constant, so referencing it directly sidesteps that inference gap
    // entirely.
    orderBy: asc(assets.sortOrder),
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
} as const;

/** The one query `findGalleryDetail` (single) issues, kept as its own
 * function so its return type can be reused as `toGalleryDetail`'s parameter
 * type below without hand-typing a second copy of the row shape. */
async function fetchGalleryDetailRow(where: ReturnType<typeof eq>) {
  return db.query.galleries.findFirst({ where, with: galleryDetailWith });
}

type RawGalleryDetailRow = NonNullable<Awaited<ReturnType<typeof fetchGalleryDetailRow>>>;

/** Row -> `GalleryDetail` mapping, shared by `findGalleryDetail` and
 * `getGalleryDetailsByIds` below — see `galleryDetailWith`'s own comment
 * above for why this is one function rather than two. `db.query.galleries.
 * findMany({ with: galleryDetailWith })`'s rows are structurally the same
 * shape as `findFirst`'s (the row type is derived from `with`, not from
 * which of the two methods issued the query), which is what lets
 * `getGalleryDetailsByIds` pass its rows straight through this same
 * function. */
function toGalleryDetail(row: RawGalleryDetailRow): GalleryDetail {
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

/** Shared by `getGalleryDetail` (admin, looked up by id) and
 * `getGalleryDetailBySlug` (client, looked up by the unguessable
 * `publicSlug` — see schema.ts's comment on that column for why a gallery
 * URL is keyed on the slug, never the id) below: same `with`/mapping shape
 * (`galleryDetailWith`/`toGalleryDetail` above), different `where`. Returns
 * `null` when no matching row exists, rather than throwing — both callers'
 * pages turn that into a real 404 via `notFound()`. */
async function findGalleryDetail(where: ReturnType<typeof eq>): Promise<GalleryDetail | null> {
  const row = await fetchGalleryDetailRow(where);
  if (!row) return null;
  return toGalleryDetail(row);
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

/** Every `GalleryDetail` for the given ids, in ONE query regardless of how
 * many ids are passed — task #138's fix for the `galleries` GraphQL
 * resolver's N+1 (see `src/lib/graphql/types/query.ts`'s own comment on that
 * field). Shares `galleryDetailWith`/`toGalleryDetail` above with
 * `findGalleryDetail` (task #154) — see the comment above
 * `galleryDetailWith` for why, and for what that sharing does and does not
 * buy.
 *
 * Deliberately does NO authorization filtering of its own: it trusts `ids`
 * completely. Every caller MUST pre-scope `ids` to exactly what the
 * signed-in session may see before calling this — today that is
 * `getGalleriesForClient`'s own ownership subquery plus its
 * `CLIENT_VISIBLE_STATUSES` filter (both above in this file). Passing an
 * unscoped id list here would read any gallery in the studio; nothing inside
 * this function would catch that.
 *
 * Returns `[]` immediately, without touching the database at all, for an
 * empty `ids` array (an `inArray` with no candidates is at best a wasted
 * round trip and at worst renders `IN ()`, which some drivers reject).
 *
 * Row order is NOT guaranteed to match `ids`' order — callers that care
 * about ordering (the `galleries` resolver, to preserve
 * `getGalleriesForClient`'s own recency order) must re-sort by `id`
 * themselves. Silently returns fewer rows than ids requested when some no
 * longer exist, matching `getGalleryDetail`'s own "not found comes back as
 * absence, never a thrown error" convention. */
export async function getGalleryDetailsByIds(ids: readonly string[]): Promise<GalleryDetail[]> {
  if (ids.length === 0) return [];

  const rows = await db.query.galleries.findMany({
    where: inArray(galleries.id, [...ids]),
    with: galleryDetailWith,
  });

  return rows.map(toGalleryDetail);
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
 * attached. As of task #100, that is the ORDINARY state for a `draft`
 * gallery — the photographer can create one, and upload proofs to it,
 * before any client record exists (see schema.ts's comment on
 * `galleryClients` for the full rule, `activeClientRuleViolation()` in this
 * file for where it is enforced). Past `draft` an empty result means that
 * rule has been violated — rare, but callers must still handle it rather
 * than assuming at least one client, which is exactly why this returns a
 * list instead of throwing or returning `null`.
 *
 * Task #97: filtered to `removedAt IS NULL` — this is THE query every email
 * fan-out in src/app/dashboard/galleries/actions.ts (publish/unlock/deliver)
 * calls to decide who to notify. A removed client must never receive a
 * gallery-access email again; without this filter, removal would revoke
 * authorization (once `isGalleryOwner` is also fixed) while this function
 * kept mailing them a working magic link regardless — the exact "a soft row
 * is still a row" trap the task exists to close. */
export async function getGalleryClients(galleryId: string): Promise<GalleryClientContact[]> {
  const rows = await db.query.galleryClients.findMany({
    where: and(eq(galleryClients.galleryId, galleryId), isNull(galleryClients.removedAt)),
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
 * page would silently return the wrong rows.
 *
 * Task #98 fixed a production 500 here: this used to be a raw `sql`
 * template subquery (`` sql`${galleries.id} in (select ... where ...)` ``).
 * Inside `db.query.*` (the relational query builder), a raw `sql` template
 * silently inherits the ROOT table's own alias for EVERY column reference in
 * it, whatever table those columns actually belong to — so
 * `galleryClients.galleryId`/`galleryClients.userId` rendered as
 * `"galleries"."gallery_id"`/`"galleries"."user_id"` instead of
 * `"gallery_clients"."..."`, columns that don't exist on `galleries` at all.
 * Replaced with `inArray(galleries.id, db.select(...).from(galleryClients)
 * .where(...))` — a genuine subquery with its OWN `FROM gallery_clients`, so
 * its column references carry their own correct alias regardless of what
 * table this whole query is rooted at. Task #97 (this task) adds
 * `isNull(galleryClients.removedAt)` to that SAME subquery's own `where` —
 * a removed client must not see this gallery in their own list, same "a
 * soft row is still a row" guard as every other reader of `gallery_clients`.
 * NOTE for future readers: `removedAt` belongs to `gallery_clients`, not
 * `galleries` — it MUST live inside the subquery's `where`, never as a
 * sibling condition in the outer `and(...)` below, or it would filter a
 * column that doesn't exist on the outer query's own table.
 *
 * AND THE GENERAL RULE, worth more than this one query's fix: any raw `sql`
 * template that references a table OTHER than the relational query's root
 * table is this same trap waiting to fire. It applies to every `db.query.*`
 * call in this codebase, not just this one.
 *
 * Verified with `.toSQL()` against the REAL relational query (not a
 * `where`-object deep-equal, and not a `sql` template rendered in
 * isolation) — in src/lib/galleries.query-rendering.test.ts, which mocks
 * nothing, NOT in galleries.test.ts, which mocks `db.query.*` away. See that
 * file's own header comment for why the distinction is what would actually
 * have caught the bug above. */
export async function getGalleriesForClient(clientId: string): Promise<ClientGalleryListItem[]> {
  const rows = await db.query.galleries.findMany({
    where: and(
      inArray(
        galleries.id,
        db
          .select({ id: galleryClients.galleryId })
          .from(galleryClients)
          .where(and(eq(galleryClients.userId, clientId), isNull(galleryClients.removedAt))),
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

/** The one status `getGalleryCount()` excludes from its "en marcha" tally —
 * see that function's own comment below for the reasoning. Exported (task
 * #121) so this file's own pinning test (galleries.test.ts) can assert
 * against the ACTUAL value the query filters on, not a second, hand-typed
 * copy of the string `"archived"` that could silently drift from it — same
 * "one copy, not two" concern `ASSET_MUTATION_BLOCKED_STATUSES`
 * (src/lib/asset-access.ts, task #58) exists to close for its own
 * denylist. Unlike that denylist, this is a single status rather than a
 * `Set`, because `getGalleryCount()`'s `ne()` filter can only ever exclude
 * one value at a time — the day a second status needs excluding, this
 * becomes a `Set` and the query becomes `notInArray`, together. */
export const GALLERY_COUNT_EXCLUDED_STATUS: Gallery["status"] = "archived";

/** How many galleries are currently "en marcha" — every status EXCEPT
 * `archived`. Powers the "Galerías" summary on `/dashboard` (task #88) and
 * the sentence right above it ("Tenés N clientes y M galerías en marcha.")
 * — a dedicated `count()` query, same reasoning as `getPendingSelectionCount`
 * above: the dashboard index only needs a number, not
 * `getGalleriesWithDetails().length`, which would pull every gallery's
 * client/package/asset joins just to discard everything but a count.
 *
 * Task #90: originally counted EVERY status, including `archived`, while
 * the sentence it powers already said "en marcha" — harmless only because
 * no code path set a gallery to `archived` yet (PLAN.md §2 marks archival as
 * future, task #42). Excluding it here, rather than softening the copy to
 * something status-agnostic like "en total", was chosen because the rest of
 * this codebase already treats `archived` as a closed, historical state the
 * moment it exists — see `CLIENT_VISIBLE_STATUSES` above and
 * `src/app/api/assets/[assetId]/route.ts`'s own comment — so a dashboard
 * that greets the photographer with "how your studio is doing right now"
 * should not count a gallery nobody is working on anymore toward that
 * number. The two (this query and the sentence in
 * src/app/dashboard/page.tsx) must keep agreeing — see this function's own
 * test in galleries.test.ts, which asserts the `archived` exclusion
 * directly rather than trusting a mock's return value.
 *
 * Task #121: `GALLERY_COUNT_EXCLUDED_STATUS` above is pinned in
 * galleries.test.ts against the live `gallery_status` enum — a sixth status
 * added to that enum without updating this exclusion now fails a test
 * instead of silently being counted as "en marcha". This is a cheap
 * hardening, not a correction of #90: see that task's own body for why a
 * denylist is the right shape here (an admin-facing display metric), unlike
 * `CLIENT_VISIBLE_STATUSES`'s allowlist (a client-facing authorization-
 * adjacent gate, where default-deny is the correct posture). */
export async function getGalleryCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(galleries)
    .where(ne(galleries.status, GALLERY_COUNT_EXCLUDED_STATUS));
  return row?.value ?? 0;
}
