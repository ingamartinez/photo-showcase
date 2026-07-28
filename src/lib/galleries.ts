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

import { desc, eq } from "drizzle-orm";
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
  client: { id: string; name: string | null; email: string };
  package: { id: number; name: string };
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  photoCount: number;
};

/** Every gallery, most recently created first, with the client and package it
 * is bound to, its frozen terms, and its (derived, never stored) photo
 * count. */
export async function getGalleriesWithDetails(): Promise<GalleryWithDetails[]> {
  const rows = await db.query.galleries.findMany({
    orderBy: desc(galleries.createdAt),
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

/** Colombian peso, whole units (the schema's *_cop columns carry no
 * decimals — see schema.ts). Used for the frozen package terms shown on the
 * gallery detail page; never for anything computed off the LIVE `packages`
 * row (see this file's header comment and PLAN.md §3's snapshot rule). */
export function formatCop(amountCop: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(amountCop);
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
