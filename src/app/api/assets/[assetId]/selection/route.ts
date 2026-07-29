// PATCH /api/assets/[assetId]/selection — the client toggles whether one
// asset is picked for editing (task #24's headline mutation).
//
// `is_selected` / `selected_at` are the only things this route writes.
// `selected` (the count), `extras`, and `surchargeCop` are never stored —
// PLAN.md §3 and schema.ts's comment on `assets.isSelected` are explicit
// that the count is DERIVED. So after every toggle this route re-reads every
// sibling asset's `isSelected` flag from the database and hands the caller
// the server's own recomputation (via `computeQuota`, src/lib/quota.ts) —
// never an increment/decrement of whatever number the client last saw. A
// client that edits the request body, races two tabs, or simply lies about
// what it thinks the count is gets corrected on the very next response: the
// number it renders always traces back to a fresh `SELECT`, never to
// anything the client supplied (task #24's "the counter matches a
// server-side recomputation" acceptance criterion).
//
// Authorization has TWO gates, not one — a lesson learned from task #63's
// review of the neighboring proof route, and re-derived here rather than
// left stale (an earlier draft of this comment claimed authorization
// "mirrors the READ routes right next to this one", which was true before
// #63 and is no longer true — see .../proof/route.ts's own header for what
// changed there):
//
//   1. `loadOwnedAsset` — the gallery's own client OR an admin. This is the
//      right ownership rule for this route (unlike the admin-only
//      management routes, delete/reorder): toggling selection is the core
//      CLIENT action this whole page exists for.
//
//   2. `isGalleryVisibleToClient(gallery.status)` — a SEPARATE, non-admin-only
//      gate. `loadOwnedAsset` has no opinion on gallery status; it was built
//      for read routes where "owns the gallery" was historically the whole
//      story. It is NOT the whole story for a WRITE: PLAN.md §2 says a
//      `draft` gallery is "not yet visible to client", and
//      `/galleries/[publicSlug]` (page.tsx) already 404s a client who tries
//      to VIEW one. A route that only checked ownership would let that same
//      client PATCH `is_selected` into a gallery they can't even see — worse
//      than the read hole #63 closed, because it's a write. Admins bypass
//      this gate (they legitimately work in `draft`), exactly like the proof
//      route.
//
// The two gates are independent and both required: gate 1 answers "is this
// caller allowed near this asset at all", gate 2 answers "is this gallery's
// CURRENT status one a non-admin caller is allowed to know exists".
//
// The gallery's own `galleryId` is resolved FROM the asset row, never from
// anything the caller supplied directly — see src/lib/asset-access.ts's
// header comment for why that specific shortcut is the security bug this
// pattern exists to prevent.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireApiSession } from "@/lib/auth-guards";
import { loadOwnedAsset } from "@/lib/asset-access";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { computeQuota } from "@/lib/quota";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();
const bodySchema = z.object({ selected: z.boolean() });

// Same gate, same reasoning, as the sibling DELETE/reorder routes (task #56)
// — but note this set does NOT include `draft`. `draft` is refused by the
// SEPARATE `isGalleryVisibleToClient` gate above (non-admin only) rather
// than by this one, because this set's job is "the selection is settled,
// refuse EVERYONE including admin"; `draft` is the opposite situation — an
// admin is expected to be able to write there (uploading/arranging proofs
// before publishing), only a client is not. `selected` here means "the
// client already submitted their selection" (a later task's transition, not
// this one) — letting a toggle through after that would silently change
// what the client already committed to, including the surcharge they were
// quoted. `delivered` and `archived` are closed states for the same reason
// the other two routes refuse them.
//
// Exported (task #73) so the admin unlock action's own test suite
// (src/app/dashboard/galleries/actions.unlock.test.ts) can assert "after
// unlock, `proofing` is not in the REAL gate this route enforces" against
// this exact set, instead of asserting a hand-copied string literal that
// could silently drift from what this route actually checks.
export const SELECTION_LOCKED_STATUSES = new Set<Gallery["status"]>([
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
  // Admin OR the gallery's own client, per this file's header comment.
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // Gate 2 (see file header): a `draft` gallery is not visible to a client
  // via the page, so it must not be writable by them via this route either
  // — PLAN.md §2. Checked BEFORE the lock gate below and returns the same
  // 404 `loadOwnedAsset` already uses for "doesn't exist" (not a 403), so a
  // client fishing for which asset ids are real learns nothing new here.
  // Admin bypasses this — same as the proof route (task #63).
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && !isGalleryVisibleToClient(gallery.status)) {
    return errorResponse("asset_not_found", 404);
  }

  // The status gate, checked BEFORE any mutation — matches the sibling
  // routes' convention: 409, not 403 (the caller IS authorized, the
  // gallery's current state just refuses this action). Applies to
  // everyone, admin included — see SELECTION_LOCKED_STATUSES's own comment
  // for why this is a different rule from the gate just above.
  if (SELECTION_LOCKED_STATUSES.has(gallery.status)) {
    return errorResponse("gallery_locked", 409);
  }

  const isSelected = bodyResult.data.selected;
  const selectedAt = isSelected ? new Date() : null;
  await db.update(assets).set({ isSelected, selectedAt }).where(eq(assets.id, asset.id));

  // Re-read every sibling's flag AFTER the write above, so the count this
  // response reports already reflects the toggle that just happened — see
  // the file header for why this is a fresh read rather than a client-trusted
  // increment.
  const siblings = await db
    .select({ isSelected: assets.isSelected })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  const selected = siblings.filter((row) => row.isSelected).length;

  const quota = computeQuota(selected, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
  });

  return NextResponse.json({
    asset: { id: asset.id, isSelected, selectedAt: selectedAt ? selectedAt.toISOString() : null },
    quota,
  });
}
