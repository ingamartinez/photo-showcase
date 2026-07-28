// Resolves an asset AND verifies the requesting session owns the gallery it
// belongs to — shared by every route that hands out a presigned URL for an
// asset (task #16, the security core of the media pipeline: PLAN.md §5).
//
// The gallery is always resolved FROM the asset row's own `galleryId`
// column, NEVER from anything the client supplied directly (a route param,
// a query string, a body field). Task #16 calls this out explicitly: a
// client-supplied gallery id must never be trusted for the ownership check,
// because a route that did `db.select().from(galleries).where(eq(galleries.id,
// clientSuppliedId))` and then checked ownership on THAT row would let a
// signed-in client pair their own session with an arbitrary asset id from a
// gallery they don't own, as long as the gallery id they typed happens to be
// one they DO own. Looking the gallery up through the asset's own foreign
// key removes that entire class of mistake — there is no client-controlled
// input left in the ownership check at all, only the asset id.
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import { assets, galleries } from "@/lib/db/schema";
import type { Asset, Gallery } from "@/lib/db/schema";

export type AssetLookupResult =
  { ok: true; asset: Asset; gallery: Gallery } | { ok: false; status: 403 | 404; error: string };

/**
 * Loads `assetId` and the gallery it belongs to, then checks that `session`
 * is allowed to see it: the gallery's own client, or an admin. Returns a
 * discriminated result instead of throwing, so every calling route decides
 * its own response shape without a try/catch — mirrors the style of
 * `requireApiSession()` in src/lib/auth-guards.ts.
 *
 * Deliberately returns 404 (not 403) when the asset id simply doesn't exist:
 * there is no gallery to check ownership against, and — unlike the
 * wrong-owner case task #16 requires a 403 for — this does not distinguish
 * "exists but isn't yours" from "never existed" for an unauthenticated-turned-
 * authenticated caller poking at random ids, since both look identical to
 * every caller except the asset's actual owner/admin.
 */
export async function loadOwnedAsset(
  assetId: string,
  session: Session,
): Promise<AssetLookupResult> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) {
    return { ok: false, status: 404, error: "asset_not_found" };
  }

  // Resolved FROM the asset row's own galleryId — see the file header. Never
  // from a gallery id supplied by the caller.
  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, asset.galleryId))
    .limit(1);
  if (!gallery) {
    // Defensive only: assets.galleryId carries a NOT NULL foreign key to
    // galleries (see schema.ts), so this branch should be unreachable
    // outside of a corrupted database. Fails closed rather than throwing.
    return { ok: false, status: 404, error: "gallery_not_found" };
  }

  const isOwner = session.user.role === "admin" || gallery.clientId === session.user.id;
  if (!isOwner) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, asset, gallery };
}
