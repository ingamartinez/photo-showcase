// PATCH /api/assets/[assetId]/selection — the client toggles whether one
// asset is picked for editing (task #24's headline mutation).
//
// `is_selected` / `selected_at` / `selected_by` are the only things this
// route writes (`selected_by`, task #94 — see schema.ts's comment on
// `assets.selectedBy` for the attribution decision this lockstep write
// implements). `selected` (the count), `extras`, and `surchargeCop` are
// never stored —
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
import { withApiSession } from "@/lib/auth-guards";
import { ASSET_MUTATION_BLOCKED_STATUSES, loadOwnedAsset } from "@/lib/asset-access";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { computeQuota } from "@/lib/quota";
import { notifySelectionChanged } from "@/lib/selection-events";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();
const bodySchema = z.object({ selected: z.boolean() });

// The mutation lock — task #58 unified this with the identical set the
// DELETE and reorder routes each carried as their own local copy (three
// verbatim `["selected","delivered","archived"]` literals across three
// files was the drift risk task #58 closed; see
// src/lib/asset-access.ts's comment on `ASSET_MUTATION_BLOCKED_STATUSES`
// for the full rationale, which now covers this route too). This alias
// keeps the route-local, task-#73-established export name (see below) so
// nothing importing `SELECTION_LOCKED_STATUSES` from THIS module needs to
// change — but there is exactly one Set behind both names.
//
// Note this set does NOT include `draft`. `draft` is refused by the
// SEPARATE `isGalleryVisibleToClient` gate above (non-admin only) rather
// than by this one, because this set's job is "the selection is settled,
// refuse EVERYONE including admin"; `draft` is the opposite situation — an
// admin is expected to be able to write there (uploading/arranging proofs
// before publishing), only a client is not. `selected` here means "the
// client already submitted their selection" (a later task's transition, not
// this one) — letting a toggle through after that would silently change
// what the client already committed to, including the surcharge they were
// quoted. `delivered` and `archived` are closed states for the same reason
// the other two routes refuse them. Do NOT fold this with the
// `isGalleryVisibleToClient` gate above just because their status lists
// happen to overlap today — they gate different principals (everyone
// including admin, vs. non-admins only) and are checked independently
// below.
//
// Exported (task #73) so the admin unlock action's own test suite
// (src/app/dashboard/galleries/actions.unlock.test.ts) can assert "after
// unlock, `proofing` is not in the REAL gate this route enforces" against
// this exact set, instead of asserting a hand-copied string literal that
// could silently drift from what this route actually checks.
export const SELECTION_LOCKED_STATUSES = ASSET_MUTATION_BLOCKED_STATUSES;

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const PATCH = withApiSession(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
  session,
): Promise<NextResponse> {
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
  // `selectedBy` is kept in lockstep with `isSelected` right here — the
  // acting session's own user id on select, `null` again on deselect — see
  // schema.ts's comment on `assets.selectedBy` for why deselect clears it
  // rather than keeping the last actor.
  const selectedBy = isSelected ? session.user.id : null;
  await db
    .update(assets)
    .set({ isSelected, selectedAt, selectedBy })
    .where(eq(assets.id, asset.id));

  // Task #114 — push the shared selection to every OTHER open session,
  // instead of making them wait for their next poll tick. Fire-and-forget on
  // purpose (never `await`ed into this response): the write above already
  // committed, and a slow or failed NOTIFY must never add latency to, or
  // fail, a toggle that otherwise fully succeeded. See
  // src/lib/selection-events.ts's own header comment for the full design —
  // this is one of the three call sites, not a trigger, deliberately.
  void notifySelectionChanged(gallery.id).catch(() => {
    // Swallowed on purpose, same stance as the comment above: the fallback
    // poll (proof-grid.tsx, 30s) is the backstop for a signal that never
    // arrives, so a failure here degrades staleness, not correctness.
  });

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

  // `pickedBy` (task #95) is the attribution this route JUST wrote, handed
  // straight back rather than left for the collaborative tray to infer. The
  // tray must show the client's own pick the instant it lands — waiting up to
  // one poll interval for their OWN action to appear would read as the app
  // being broken — and the only honest way to do that is for the server to
  // say who it recorded, in the same response that confirms the toggle. Same
  // stance as `quota` above: this component never derives a fact it can be
  // handed. The label is the `name ?? email` fallback every other surface in
  // this app uses for a person; `<SelectionTray>` renders the viewer's own
  // picks as "Vos" regardless (see `pickerLabelFor`), so this label is only
  // ever actually READ by another session, after the next poll re-reads it
  // from the database anyway.
  //
  // `null` on deselect, in lockstep with `selectedBy` — schema.ts's own rule.
  const pickedBy = isSelected
    ? { id: session.user.id, label: session.user.name ?? session.user.email ?? session.user.id }
    : null;

  return NextResponse.json({
    asset: {
      id: asset.id,
      isSelected,
      selectedAt: selectedAt ? selectedAt.toISOString() : null,
      pickedBy,
    },
    quota,
  });
});
