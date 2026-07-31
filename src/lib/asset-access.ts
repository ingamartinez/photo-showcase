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
import { isGalleryOwner } from "@/lib/gallery-access";

export type AssetLookupResult =
  { ok: true; asset: Asset; gallery: Gallery } | { ok: false; status: 403 | 404; error: string };

// Statuses in which a gallery's asset SET (which assets exist, their order,
// which are selected) is considered settled and refuses mutation to EVERY
// caller, including admins — the single shared definition task #58 replaced
// three verbatim copies with (the DELETE route, the reorder route, and the
// client-facing selection-toggle route each carried their own).
//
// Once a gallery has moved past `draft`/`proofing`, task #56 (raised by the
// #20 review) requires this gate: deleting or reordering an asset after the
// client has SELECTED it would silently change what they already committed
// to — including the price they accepted, since selection counts and the
// surcharge are derived from which assets exist and are marked selected
// (PLAN.md), never stored independently. DELIVERED is worse: the client
// already has the photos, and a mutation here would move the record of what
// they were given out from under them. ARCHIVED refuses outright, not
// merely warns — an archived gallery is a closed historical record, there is
// no legitimate workflow reason left to mutate it, and "warn but allow"
// would still let through exactly the mutation this gate exists to stop.
//
// Deliberately does NOT include `draft`: an admin is expected to write
// there (uploading/arranging proofs before publishing) — refusing draft is
// the job of a SEPARATE, non-admin-only gate (`isGalleryVisibleToClient` in
// src/lib/galleries.ts), not this one. That gate answers "is this gallery's
// current status one a non-admin caller is allowed to know exists"; this set
// answers "is the asset set settled enough that NO ONE may mutate it
// anymore". Different principals, different questions — do not fold the two
// into one set just because their status lists overlap today. The
// client-facing selection route (task #24) applies BOTH gates, in that
// order: visibility first, then this mutation lock.
export const ASSET_MUTATION_BLOCKED_STATUSES = new Set<Gallery["status"]>([
  "selected",
  "delivered",
  "archived",
]);

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

  // Task #94: a gallery can now belong to SEVERAL clients — see
  // src/lib/gallery-access.ts's own header comment for why this single
  // check, not a rewritten comparison, is the one every route shares.
  if (!(await isGalleryOwner(gallery.id, session))) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, asset, gallery };
}
