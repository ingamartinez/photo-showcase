// PATCH /api/assets/[assetId]/reorder — admin swaps a proof's `sort_order`
// with its immediate neighbor (task #20's "reorder" acceptance criterion).
//
// Deliberately a single up/down swap, not "post a whole new ordering array":
// the admin grid has no drag-and-drop library in this app (none is a
// dependency, and scope discipline says not to add one for this slice), so
// the UI only ever offers "move earlier" / "move later" per asset — a swap
// is the entire operation that action needs, and it needs no transaction
// (see below).
//
// Not wrapped in `db.transaction()`: the two `UPDATE`s below are the same
// kind of best-effort ordering the proofs route already accepts for
// `sort_order` (see task #15's comment on `existingCount` racing) —
// `sort_order` carries no uniqueness constraint (schema.ts), so a caller
// racing this route with another request could, at worst, land on a
// temporary duplicate/gap in display order, never a corrupted row or a lost
// asset. Not worth a transaction for a value that is cosmetic ordering only.
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();
const bodySchema = z.object({ direction: z.enum(["up", "down"]) });

// Same gate, same reasoning, as the sibling DELETE route right next to this
// one (task #56) — see its comment on this constant for the full rationale.
// Reordering after SELECTED/DELIVERED/ARCHIVED is just as much a silent
// change to what the client already committed to or received as deleting
// is; ARCHIVED refuses outright rather than merely warning.
const ASSET_MUTATION_BLOCKED_STATUSES = new Set<Gallery["status"]>([
  "selected",
  "delivered",
  "archived",
]);

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  // Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts). This
  // MUST be an early return on the `instanceof NextResponse` branch — the
  // same trap task #16's review caught once already.
  const sessionOrResponse = await requireApiSession();
  if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
  const session = sessionOrResponse;

  // Reordering is an admin-only action, same reasoning as the DELETE route
  // right next to this one: stricter than loadOwnedAsset()'s "admin OR
  // owning client" rule, which is correct only for read-only routes.
  if (session.user.role !== "admin") {
    forbidden();
  }

  const { assetId: rawAssetId } = await params;
  const assetIdResult = assetIdSchema.safeParse(rawAssetId);
  if (!assetIdResult.success) {
    return errorResponse("invalid_asset_id", 400);
  }

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

  // Reused, not re-rolled — see src/lib/asset-access.ts's header comment.
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // The status gate, checked BEFORE any mutation — see the constant's
  // comment above. Matches #15's convention for a wrong-state gallery: 409,
  // not 403 (the caller is authorized, the gallery's current state just
  // refuses this action).
  if (ASSET_MUTATION_BLOCKED_STATUSES.has(gallery.status)) {
    return errorResponse("gallery_locked", 409);
  }

  // The gallery's current ordering, ascending — the same ordering the
  // detail page renders and the proofs route appends new uploads to the end
  // of. Only id + sortOrder are needed to compute the swap.
  const siblings = await db
    .select({ id: assets.id, sortOrder: assets.sortOrder })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id))
    .orderBy(asc(assets.sortOrder));

  const index = siblings.findIndex((row) => row.id === asset.id);
  if (index === -1) {
    // Defensive only: `asset` was just loaded via `loadOwnedAsset` above, so
    // it must be a member of `siblings` (same galleryId, no delete raced in
    // between an `await` this route never yields across otherwise).
    return errorResponse("asset_not_found", 404);
  }

  const neighborIndex = bodyResult.data.direction === "up" ? index - 1 : index + 1;
  const neighbor = siblings[neighborIndex];
  if (!neighbor) {
    // Already at the edge of the ordering — not an error, just a no-op: the
    // UI disables the button at the edge, but a stale click (e.g. a second
    // tab) must not 400 for something this cheap to just do nothing about.
    return NextResponse.json({ updated: [] });
  }

  const current = siblings[index]!;
  await db.update(assets).set({ sortOrder: neighbor.sortOrder }).where(eq(assets.id, current.id));
  await db.update(assets).set({ sortOrder: current.sortOrder }).where(eq(assets.id, neighbor.id));

  return NextResponse.json({
    updated: [
      { id: current.id, sortOrder: neighbor.sortOrder },
      { id: neighbor.id, sortOrder: current.sortOrder },
    ],
  });
}
