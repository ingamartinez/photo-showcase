// PATCH /api/assets/[assetId]/selection — the client toggles whether one
// asset is picked for editing (task #24's headline mutation), and — since
// task #206 — sets what TYPE that pick is (`edited` or `original`).
//
// `is_selected` / `selected_at` / `selected_by` / `selection_kind` are the
// only things this route writes (`selected_by`, task #94 — see schema.ts's
// comment on `assets.selectedBy` for the attribution decision this lockstep
// write implements). `selected` (the count), `extras`, and `surchargeCop` are
// never stored —
// PLAN.md §3 and schema.ts's comment on `assets.isSelected` are explicit
// that the count is DERIVED. So after every write this route re-reads every
// sibling asset's `isSelected`/`selectionKind` from the database and hands
// the caller the server's own recomputation (via `computeQuota`,
// src/lib/quota.ts) — never an increment/decrement of whatever number the
// client last saw. A client that edits the request body, races two tabs, or
// simply lies about what it thinks the count is gets corrected on the very
// next response: the number it renders always traces back to a fresh
// `SELECT`, never to anything the client supplied (task #24's "the counter
// matches a server-side recomputation" acceptance criterion).
//
// TWO KINDS OF WRITE, ONE BODY SCHEMA (task #206). The request may carry
// `selected` (the original select/deselect toggle), `selectionKind` (set the
// type of an ALREADY-selected pick), or both — at least one is required (see
// `bodySchema`'s own `.refine`). Splitting them into two routes was
// considered and rejected: the task's own kanban body is explicit that this
// SAME route grows the ability to set the type, not a sibling one, and the
// two writes share every gate below (ownership, visibility, the lock) — a
// second route would either duplicate all three or import this one's
// internals, neither of which buys anything.
//
//   - `selected` present: the ordinary select/deselect toggle, UNCHANGED in
//     shape. Selecting (`true`) ALWAYS (re)sets `selectionKind` to `edited`,
//     even if the asset was previously marked `original` — criterion 2's own
//     rule ("deselecting it and selecting it again returns it to `edited`"),
//     enforced here rather than left to whatever the row happened to hold
//     before. Deselecting also resets it to `edited`, for the same reason
//     `selectedBy` already goes back to `null` on deselect: the column is
//     meaningless while `isSelected` is `false` (schema.ts's own comment on
//     `assets.selectionKind`), so there is nothing to preserve.
//   - `selected` absent, `selectionKind` present: a TYPE-ONLY change. Refused
//     with 409 unless the asset is ALREADY selected — the type has no
//     meaning otherwise, and accepting it silently would let a client set a
//     type on a photo nobody picked. Does not touch `isSelected`/
//     `selectedAt`/`selectedBy` at all.
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
import { assets, users } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { ASSET_MUTATION_BLOCKED_STATUSES, loadOwnedAsset } from "@/lib/asset-access";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { computeQuota } from "@/lib/quota";
import { notifySelectionChanged } from "@/lib/selection-events";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();
// `selectionKind` is a plain `z.enum`, not imported from `@/lib/db/schema`'s
// own `selectionKind` pgEnum — same "duplicate the two-value union rather
// than import anything DB-adjacent into a route that already imports the
// real `db`" stance is unnecessary here (this route already imports
// `@/lib/db` directly), but the LITERAL union still has to match
// `selection-snapshot.ts`'s hand-rolled `SelectionKind` type, which a
// Client Component reads — keep the two in sync by hand, same as that file's
// own comment asks.
const bodySchema = z
  .object({
    selected: z.boolean().optional(),
    selectionKind: z.enum(["edited", "original"]).optional(),
  })
  // At least one of the two — an empty `{}` body does nothing and is refused
  // rather than silently treated as a no-op 200, matching this route's own
  // `invalid_body` stance for any other malformed request.
  .refine((body) => body.selected !== undefined || body.selectionKind !== undefined, {
    message: "at_least_one_of_selected_or_selectionKind_required",
  });

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
  // for why this is a different rule from the gate just above. Deliberately
  // covers BOTH kinds of write below: it is easy to remember to gate
  // "select" and forget to gate "change the type", and a submitted
  // selection's type is the same money as its count — a client changing
  // `edited` to `original` after submitting would change what they owe
  // without the photographer ever seeing it happen.
  if (SELECTION_LOCKED_STATUSES.has(gallery.status)) {
    return errorResponse("gallery_locked", 409);
  }

  const { selected, selectionKind } = bodyResult.data;

  // Task #214 — THE SERVER GATE, independent of anything the client's own
  // UI hides. Refuses ANY write that would set `selectionKind` to
  // `"original"` unless this gallery's own `allowsOriginalSelection` is
  // true. Covers BOTH shapes the file header above documents: the type-only
  // branch below (`selected` absent) AND the atomic "select AND mark
  // original" combo (`selected` present, `selectionKind: "original"` in the
  // SAME request) — both are a client requesting the cheaper "original"
  // tariff on a gallery whose photographer never turned that choice on, and
  // a gate that only covered one of the two shapes would leave the other
  // reachable. Checked BEFORE either branch runs, using the SAME 409 "state
  // conflict" shape `SELECTION_LOCKED_STATUSES`/`asset_not_selected` above
  // already use: the caller IS authorized to act on this asset, the
  // GALLERY's own settings just refuse this particular value. A UI-only gate
  // (hiding the tile's type buttons, proof-tile.tsx) is not enough on its
  // own — this route is reachable by any client attached to the gallery
  // regardless of what their own tab currently renders.
  if (selectionKind === "original" && !gallery.allowsOriginalSelection) {
    return errorResponse("originals_not_allowed", 409);
  }

  let isSelected: boolean;
  let selectedAtIso: string | null;
  let pickedBy: { id: string; label: string } | null;
  let nextSelectionKind: (typeof assets.$inferSelect)["selectionKind"];

  if (selected !== undefined) {
    // The ordinary select/deselect toggle (task #24), unchanged in shape.
    isSelected = selected;
    const selectedAt = isSelected ? new Date() : null;
    selectedAtIso = selectedAt ? selectedAt.toISOString() : null;
    // `selectedBy` is kept in lockstep with `isSelected` right here — the
    // acting session's own user id on select, `null` again on deselect — see
    // schema.ts's comment on `assets.selectedBy` for why deselect clears it
    // rather than keeping the last actor.
    const selectedBy = isSelected ? session.user.id : null;
    // Task #206 — criterion 2: a fresh select always (re)starts `edited`,
    // even if this same request also carries a `selectionKind` (an atomic
    // "select AND mark original" from one control would still land here,
    // and is honoured); a request that carries ONLY `selected` — the
    // ordinary pick/unpick control — resets whatever kind a PREVIOUS pick of
    // this same asset left behind, so deselecting and re-selecting always
    // comes back as `edited`, never a stale `original`.
    nextSelectionKind = selectionKind ?? "edited";
    pickedBy = isSelected
      ? { id: session.user.id, label: session.user.name ?? session.user.email ?? session.user.id }
      : null;

    await db
      .update(assets)
      .set({ isSelected, selectedAt, selectedBy, selectionKind: nextSelectionKind })
      .where(eq(assets.id, asset.id));
  } else {
    // Type-only change (task #206): `bodySchema`'s own `.refine` guarantees
    // `selectionKind` is defined whenever `selected` is not.
    if (!asset.isSelected) {
      // The type has no meaning for a photo nobody picked (schema.ts's own
      // comment on `assets.selectionKind`) — refused with the same 409 shape
      // as the lock gate above, since this IS a state conflict: the caller is
      // authorized, the ASSET's current state just refuses this action.
      return errorResponse("asset_not_selected", 409);
    }
    nextSelectionKind = selectionKind!;
    isSelected = asset.isSelected;
    selectedAtIso = asset.selectedAt ? asset.selectedAt.toISOString() : null;
    // Task #206 — a type-only change can be made by ANY client attached to
    // the gallery, not only the one who originally picked the photo (the
    // shared selection lets any of them act on any asset — task #94/#95).
    // So `asset.selectedBy` here is NOT necessarily this session's own id,
    // and the acting session's own name must not be attributed to a
    // DIFFERENT picker's id — that would mislabel the original picker in
    // this response's own `pickedBy`, which the acting session's tray applies
    // to its local state immediately (see use-shared-selection.ts's
    // `setSelectionKind`). A real lookup, not a guess.
    if (asset.selectedBy === null) {
      pickedBy = null;
    } else if (asset.selectedBy === session.user.id) {
      pickedBy = {
        id: session.user.id,
        label: session.user.name ?? session.user.email ?? session.user.id,
      };
    } else {
      const [picker] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, asset.selectedBy))
        .limit(1);
      // `?? null`: `selected_by` pointing at a since-deleted user (`onDelete:
      // "set null"`) is a narrow window, not a bug — same honest "no
      // attribution" outcome `gallery-selection.ts` already gives it.
      pickedBy = picker ? { id: asset.selectedBy, label: picker.name ?? picker.email } : null;
    }

    await db
      .update(assets)
      .set({ selectionKind: nextSelectionKind })
      .where(eq(assets.id, asset.id));
  }

  // Task #114 — push the shared selection to every OTHER open session,
  // instead of making them wait for their next poll tick. Fire-and-forget on
  // purpose (never `await`ed into this response): the write above already
  // committed, and a slow or failed NOTIFY must never add latency to, or
  // fail, a write that otherwise fully succeeded. See
  // src/lib/selection-events.ts's own header comment for the full design —
  // this is one of the three call sites, not a trigger, deliberately. A
  // type-only change goes through the SAME signal as a toggle (task #206's
  // own instruction: reuse the shared-selection channel, don't invent a
  // second one) — every other open tab's tray needs to learn about a type
  // change exactly as promptly as it learns about a pick.
  void notifySelectionChanged(gallery.id).catch(() => {
    // Swallowed on purpose, same stance as the comment above: the fallback
    // poll (proof-grid.tsx, 30s) is the backstop for a signal that never
    // arrives, so a failure here degrades staleness, not correctness.
  });

  // Re-read every sibling's flag AFTER the write above, so the count this
  // response reports already reflects the write that just happened — see
  // the file header for why this is a fresh read rather than a client-trusted
  // increment.
  const siblings = await db
    .select({ isSelected: assets.isSelected, selectionKind: assets.selectionKind })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  const selectedSiblings = siblings.filter((row) => row.isSelected);
  // Task #206 — split by kind, off the SAME re-read: the included-photos
  // quota only ever applies to `edited` picks (src/lib/quota.ts's own header
  // comment), so the two counts are computed here rather than a single
  // "selected" total the way task #205 (before this slice) still did.
  const selectedOriginal = selectedSiblings.filter(
    (row) => row.selectionKind === "original",
  ).length;
  const selectedEdited = selectedSiblings.length - selectedOriginal;

  const quota = computeQuota(selectedEdited, selectedOriginal, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
  });

  // `pickedBy` (task #95) is the attribution this route already holds (JUST
  // wrote it, on a select/deselect; already on the row, for a type-only
  // change), handed straight back rather than left for the collaborative
  // tray to infer. The tray must show the client's own action the instant it
  // lands — waiting up to one poll interval for their OWN action to appear
  // would read as the app being broken — and the only honest way to do that
  // is for the server to say who it recorded, in the same response that
  // confirms the write. Same stance as `quota` above: this component never
  // derives a fact it can be handed. The label is the `name ?? email`
  // fallback every other surface in this app uses for a person;
  // `<SelectionTray>` renders the viewer's own picks as "Vos" regardless (see
  // `pickerLabelFor`), so this label is only ever actually READ by another
  // session, after the next poll re-reads it from the database anyway.
  //
  // `null` on deselect, in lockstep with `selectedBy` — schema.ts's own rule.
  return NextResponse.json({
    asset: {
      id: asset.id,
      isSelected,
      selectedAt: selectedAtIso,
      pickedBy,
      selectionKind: nextSelectionKind,
    },
    quota,
  });
});
