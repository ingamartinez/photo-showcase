// DELETE /api/assets/[assetId] — admin removes a proof entirely: both the
// `assets` row and its R2 object(s) (the proof, plus the final if one exists
// — schema.ts's `finalKey` is nullable until a later slice's final-upload
// route sets it, but this route cleans it up too if it's already there,
// rather than leaving a second orphan class for that slice to discover).
//
// Ordering / orphan-avoidance (task #20's acceptance criterion — "no orphan
// object in R2"), chosen deliberately, mirroring task #15's create-side
// reasoning but applied to the OPPOSITE operation:
//
// The DB row is deleted FIRST, the R2 object(s) SECOND, best-effort.
//   - If the DB delete fails, nothing else runs — no R2 object has been
//     touched, nothing to clean up on this side, ever.
//   - If the DB delete succeeds but the R2 delete fails, the R2 object is
//     now an orphan. THIS IS THE SIDE THAT CAN LEAK: storage, not
//     correctness — every read path in this app (the proof/final routes,
//     the gallery grid) resolves an object key through an `assets` row, and
//     that row is already gone by the time the leak could happen, so
//     nothing can ever reach the orphaned object again.
// The reverse order (delete the R2 object first, then the DB row) was
// rejected: a successful R2 delete followed by a failed DB delete would
// leave a REAL `assets` row pointing at a key that now 404s in R2 — a
// broken thumbnail visible on every normal read path (the gallery grid),
// which is worse than wasted storage nothing ever looks at. Same trade-off
// #15 made for creation (R2 write before insert), mirrored here for the
// opposite direction.
import { forbidden } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { requireApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { deleteObject } from "@/lib/r2";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  // Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts). This
  // MUST be an early return on the `instanceof NextResponse` branch — the
  // same trap task #16's review caught once already.
  const sessionOrResponse = await requireApiSession();
  if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
  const session = sessionOrResponse;

  // Deleting is an admin-only action. This is stricter than
  // `loadOwnedAsset()`'s own "admin OR the gallery's own client" rule, which
  // is correct for the READ-only proof/final routes but wrong here: a client
  // must never be able to delete an asset from a gallery they merely own.
  if (session.user.role !== "admin") {
    forbidden();
  }

  const { assetId: rawAssetId } = await params;
  const assetIdResult = assetIdSchema.safeParse(rawAssetId);
  if (!assetIdResult.success) {
    return errorResponse("invalid_asset_id", 400);
  }

  // Reused, not re-rolled — see src/lib/asset-access.ts's header comment.
  // The ownership branch inside is moot for an admin session (always true),
  // but this still resolves the asset (404 if it doesn't exist) and hands
  // back its proofKey/finalKey without a second hand-rolled query here.
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset } = lookup;

  await db.delete(assets).where(eq(assets.id, asset.id));

  // Best-effort, only after the row is gone — see the file header for
  // exactly which side leaks if either of these fails.
  await deleteObject(asset.proofKey).catch(() => {});
  if (asset.finalKey) {
    await deleteObject(asset.finalKey).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
