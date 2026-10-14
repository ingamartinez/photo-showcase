// Read side of flash galleries (epic #232, slice #233) — the admin dashboard
// only. Nothing here decides who may VIEW a flash gallery; that is slice #234's
// job. Callers are admin pages that have already run `requireAdmin()`.
import { asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { flashGalleries } from "@/lib/db/schema";
import type { FlashAsset, FlashGallery } from "@/lib/db/schema";

export type FlashGalleryClient = { id: string; name: string | null; email: string };

export type FlashGalleryWithDetails = FlashGallery & {
  /** ACTIVE clients only (`removedAt IS NULL`). */
  clients: FlashGalleryClient[];
  photoCount: number;
};

export type FlashGalleryDetail = FlashGallery & {
  clients: FlashGalleryClient[];
  assets: FlashAsset[];
};

/** Path a flash gallery is shared at. The page itself ships in slice #234. */
export function flashGalleryPath(publicSlug: string): string {
  return `/flash/${publicSlug}`;
}

export async function getFlashGalleriesWithDetails(): Promise<FlashGalleryWithDetails[]> {
  const rows = await db.query.flashGalleries.findMany({
    orderBy: [desc(flashGalleries.createdAt)],
    with: {
      clients: { where: (c) => isNull(c.removedAt), with: { user: true } },
      assets: { columns: { id: true } },
    },
  });
  return rows.map(({ clients, assets, ...gallery }) => ({
    ...gallery,
    clients: clients.map((c) => ({ id: c.user.id, name: c.user.name, email: c.user.email })),
    photoCount: assets.length,
  }));
}

export async function getFlashGalleryDetail(id: string): Promise<FlashGalleryDetail | null> {
  const row = await db.query.flashGalleries.findFirst({
    where: eq(flashGalleries.id, id),
    with: {
      clients: { where: (c) => isNull(c.removedAt), with: { user: true } },
      assets: { orderBy: (a) => [asc(a.sortOrder), asc(a.createdAt)] },
    },
  });
  if (!row) return null;
  const { clients, ...gallery } = row;
  return {
    ...gallery,
    clients: clients.map((c) => ({ id: c.user.id, name: c.user.name, email: c.user.email })),
  };
}
