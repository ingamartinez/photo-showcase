// POST /api/galleries/[galleryId]/reorder — admin persists a NEW, COMPLETE
// ordering of a gallery's assets (task #199), replacing the old per-asset
// "swap with a neighbor" route (`../../../assets/[assetId]/reorder`, task
// #20). Two client-side actions share this one endpoint:
//
//   1. Drag-and-drop, tile to an arbitrary position (gallery-workspace.tsx's
//      `handleDragEnd`) — a drop can land anywhere, not just next to a
//      neighbor, so a swap-with-neighbor endpoint is not a smaller version of
//      this operation; it is the WRONG operation entirely.
//   2. The "Ordenar por nombre de archivo" button — computed CLIENT-SIDE off
//      the already-loaded asset list via `compareByFilenameNatural` (src/lib/
//      natural-sort.ts), then posted here as an ordinary reorder. This is
//      deliberately not a second, dedicated "sort alphabetically" endpoint:
//      the owner's own decision (this task's kanban body) is that the
//      alphabetical order is an ACTION, not a stored mode — from the
//      server's point of view it is exactly the same fact as a drag result,
//      "here is the ordering `sort_order` should now hold," so it goes
//      through the exact same validated, single-transaction write path.
//
// THE WHOLE LIST, NOT A PATCH PER ASSET. `assetIds` is the gallery's
// complete, final ordering. A drop in an 84-photo gallery can, in principle,
// change every row's `sort_order` (moving photo 1 to position 84 shifts
// every other photo's position by one) — sending 84 separate PATCH requests
// would be both slow and, worse, non-atomic: a failure partway through would
// leave the gallery's ordering genuinely incoherent (some rows reflecting
// the new order, some the old). One request, one `db.transaction()`, all or
// nothing.
//
// EXACT-SET VALIDATION, NOT A PARTIAL APPLY. The posted `assetIds` must be
// exactly the gallery's current asset ids — same members, no more, no fewer
// (order aside). A caller whose local list has drifted (e.g. another tab
// uploaded a proof after this one loaded) gets a 409 telling it to refetch,
// rather than this route silently reordering only the ids it recognizes and
// leaving whatever it doesn't know about with a stale/colliding `sort_order`.
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleries } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { ASSET_MUTATION_BLOCKED_STATUSES } from "@/lib/asset-access";

export const runtime = "nodejs";

const galleryIdSchema = z.uuid();
const bodySchema = z.object({
  assetIds: z.array(z.uuid()).min(1, "at_least_one_id_required"),
});

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const POST = withApiSession(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
  session,
): Promise<NextResponse> {
  // Reordering is an admin-only action — same reasoning as the route this
  // replaces, and as the sibling proofs-upload route right next to this one
  // (src/app/api/galleries/[galleryId]/proofs/route.ts): a client must never
  // be able to reorder a gallery it merely owns.
  if (session.user.role !== "admin") {
    forbidden();
  }

  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) {
    return errorResponse("invalid_gallery_id", 400);
  }
  const galleryId = galleryIdResult.data;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse("invalid_body", 400);
  }
  const bodyResult = bodySchema.safeParse(json);
  if (!bodyResult.success) {
    return errorResponse("invalid_body", 400);
  }

  const [gallery] = await db.select().from(galleries).where(eq(galleries.id, galleryId)).limit(1);
  if (!gallery) {
    return errorResponse("gallery_not_found", 404);
  }

  // The status gate, checked BEFORE any mutation — same shared constant, and
  // same reasoning, as every other asset-set mutation in this app (see
  // src/lib/asset-access.ts's comment on the constant). A gallery whose asset
  // set is settled (selected/delivered/archived) refuses a reorder exactly
  // as it refuses a delete: the client already saw, or already has, this
  // order.
  if (ASSET_MUTATION_BLOCKED_STATUSES.has(gallery.status)) {
    return errorResponse("gallery_locked", 409);
  }

  const siblings = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.galleryId, galleryId));

  // Exact-set check — see the file header. Compares the POSTED LIST'S OWN
  // length (not a de-duped `Set` of it) against the current member count:
  // review found that comparing two `Set` sizes lets a list with a
  // REPEATED id through as long as its distinct-member count happens to
  // match (e.g. `[a3, a1, a2, a3]` against a 3-asset gallery) — the loop
  // below would then write `a3`'s `sort_order` twice, at two different
  // positions, and the LAST write wins in the database while `updated`
  // (built from `postedIds` itself) reports BOTH positions for the same id,
  // so a client reconciling against its own first match would show a
  // `sort_order` the database does not actually hold.
  const currentIds = new Set(siblings.map((row) => row.id));
  const postedIds = bodyResult.data.assetIds;
  const sameMembers = postedIds.every((id) => currentIds.has(id));
  if (postedIds.length !== currentIds.size || !sameMembers) {
    return errorResponse("stale_asset_list", 409);
  }

  // ONE transaction for every row — see the file header's "the whole list,
  // not a patch per asset". `eq(assets.galleryId, galleryId)` is included in
  // every WHERE alongside the id, matching the convention
  // submit-selection/route.ts's own comment calls out (kanban #61): scope
  // every write to the gallery it's meant to touch, never bare on the id
  // alone.
  await db.transaction(async (tx) => {
    for (const [index, assetId] of postedIds.entries()) {
      await tx
        .update(assets)
        .set({ sortOrder: index })
        .where(and(eq(assets.id, assetId), eq(assets.galleryId, galleryId)));
    }
  });

  return NextResponse.json({
    updated: postedIds.map((id, index) => ({ id, sortOrder: index })),
  });
});
