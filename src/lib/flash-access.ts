// Who may VIEW a flash gallery (epic #232, slice #234).
//
// ONE pure predicate, `canViewFlashGallery`, decides it for the link page and
// for every binary route (display, final, zip, og-image). It is deliberately
// NOT `canReadFinalDeliverable` / `isGalleryOwner`: those guard PAID work on a
// different aggregate, and bending them to know about gifts would weaken the
// gate on paid deliverables. The loaders below only gather the facts (the
// gallery row, the session, the active assignment) and hand them to the
// predicate; they decide nothing themselves.
//
// A denied viewer and a missing gallery are indistinguishable to the caller
// (both resolve to `null`) so the response can be an ambiguous 404.
import "server-only";

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { flashAssets, flashGalleries, flashGalleryClients } from "@/lib/db/schema";
import type { FlashAsset, FlashGallery } from "@/lib/db/schema";

export type FlashViewer = {
  isAdmin: boolean;
  /** An ACTIVE assignment (`removedAt IS NULL`) to this very gallery. */
  isAssignedClient: boolean;
};

/** Public link, an admin, or an actively assigned client. Nobody else. */
export function canViewFlashGallery(
  gallery: Pick<FlashGallery, "isPublic">,
  viewer: FlashViewer | null,
): boolean {
  if (gallery.isPublic) return true;
  if (!viewer) return false;
  return viewer.isAdmin || viewer.isAssignedClient;
}

/** Deterministic photo order: `sortOrder` can repeat under concurrent uploads
 * (slice #233 review), so ties fall back to `createdAt`, then `id`. The grid,
 * the zip and the og:image ("first photo") all share it. */
export const flashAssetOrder = [
  asc(flashAssets.sortOrder),
  asc(flashAssets.createdAt),
  asc(flashAssets.id),
] as const;

async function loadGalleryBySlug(publicSlug: string): Promise<FlashGallery | null> {
  const [gallery] = await db
    .select()
    .from(flashGalleries)
    .where(eq(flashGalleries.publicSlug, publicSlug))
    .limit(1);
  return gallery ?? null;
}

async function loadViewer(galleryId: string, session: Session | null): Promise<FlashViewer | null> {
  if (!session) return null;
  if (session.user.role === "admin") return { isAdmin: true, isAssignedClient: false };
  const [row] = await db
    .select({ userId: flashGalleryClients.userId })
    .from(flashGalleryClients)
    .where(
      and(
        eq(flashGalleryClients.flashGalleryId, galleryId),
        eq(flashGalleryClients.userId, session.user.id),
        // Soft removal: a removed client must stop seeing the gallery.
        isNull(flashGalleryClients.removedAt),
      ),
    )
    .limit(1);
  return { isAdmin: false, isAssignedClient: row !== undefined };
}

/** The gallery for the CURRENT request's viewer, or `null` when it does not
 * exist or the viewer may not see it. */
export async function resolveFlashGallery(publicSlug: string): Promise<FlashGallery | null> {
  const gallery = await loadGalleryBySlug(publicSlug);
  if (!gallery) return null;
  // A public gallery needs no session lookup at all.
  const session = gallery.isPublic ? null : await auth();
  const viewer = await loadViewer(gallery.id, session);
  return canViewFlashGallery(gallery, viewer) ? gallery : null;
}

/** The gallery only when it is PUBLIC, whoever is asking. For the og-image
 * route: crawlers carry no session and a preview must never depend on one. */
export async function resolvePublicFlashGallery(publicSlug: string): Promise<FlashGallery | null> {
  const gallery = await loadGalleryBySlug(publicSlug);
  if (!gallery) return null;
  return canViewFlashGallery(gallery, null) ? gallery : null;
}

export async function listFlashAssets(flashGalleryId: string): Promise<FlashAsset[]> {
  return db
    .select()
    .from(flashAssets)
    .where(eq(flashAssets.flashGalleryId, flashGalleryId))
    .orderBy(...flashAssetOrder);
}

/** One asset, scoped to its gallery so an id from another gallery is a miss. */
export async function getFlashAsset(
  flashGalleryId: string,
  assetId: string,
): Promise<FlashAsset | null> {
  const [asset] = await db
    .select()
    .from(flashAssets)
    .where(and(eq(flashAssets.id, assetId), eq(flashAssets.flashGalleryId, flashGalleryId)))
    .limit(1);
  return asset ?? null;
}

/** The first photo (smallest `sortOrder`, then `createdAt`, then `id`). */
export async function getFirstFlashAsset(flashGalleryId: string): Promise<FlashAsset | null> {
  const [asset] = await db
    .select()
    .from(flashAssets)
    .where(eq(flashAssets.flashGalleryId, flashGalleryId))
    .orderBy(...flashAssetOrder)
    .limit(1);
  return asset ?? null;
}

/** Flash galleries the client is ACTIVELY assigned to, newest first. */
export async function getFlashGalleriesForClient(
  userId: string,
): Promise<{ id: string; title: string; publicSlug: string; sessionDate: string | null }[]> {
  return db
    .select({
      id: flashGalleries.id,
      title: flashGalleries.title,
      publicSlug: flashGalleries.publicSlug,
      sessionDate: flashGalleries.sessionDate,
    })
    .from(flashGalleryClients)
    .innerJoin(flashGalleries, eq(flashGalleries.id, flashGalleryClients.flashGalleryId))
    .where(and(eq(flashGalleryClients.userId, userId), isNull(flashGalleryClients.removedAt)))
    .orderBy(desc(flashGalleries.createdAt));
}
