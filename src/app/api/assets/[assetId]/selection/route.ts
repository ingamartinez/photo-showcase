// PATCH /api/assets/[assetId]/selection — a CLIENT acts only on their OWN pick
// of one asset (insert it, remove it, or set its type); an ADMIN acts on ONE
// client's pick, named by `actingClientId` in the body (decision 12, task
// #260). A client PATCH NEVER writes `assets`: it carries the RESOLVED,
// single-unit truth of money and delivery, owned by submit/admin paths, while
// `asset_picks` carries "who wants what". That separation is what makes
// decision 7 structural for a client — their PATCH cannot move a billed unit,
// so it cannot raise anyone's surcharge. The ADMIN path is the deliberate
// exception: it re-resolves the asset, and the response carries the
// before/after (`delta`) so the money it moved is visible.
//
// THE OPERATION, per the request body (task #206's union is unchanged):
//   - `selected: true`  — insert the caller's pick (`kind: selectionKind ??
//     "edited"`), or, when the caller already has one, a no-op when the kind
//     matches or a retype when it differs. A fresh insert always starts
//     `edited` (criterion 2: deselect + reselect comes back `edited`), and a
//     pick on a photo someone else already claimed is legal: it degrades
//     (decision 8).
//   - `selected: false` — remove the caller's pick. "Your pick" is the
//     `(asset_id, user_id)` PK, so this can never touch anybody else's row —
//     the production incident this epic exists to make impossible.
//   - `selectionKind` only — retype an EXISTING pick; refused with
//     `asset_not_selected` when the caller has none.
//
// The edit gate itself lives in `pick-resolution.ts` (`gatePickEdit`), not
// here: `cart` allows everything, `degraded` allows remove / same-kind /
// original->edited (decision 16, `pick_degraded` otherwise), and
// `billed`/`joined` answer `already_requested` — the epic's new meaning:
// "YOUR OWN pick is already submitted". A delete or retype is guarded by
// `submitted_at IS NULL` in the WHERE clause, so a submit landing after the
// read makes it match nothing and answers `already_requested` too (the CAS).
//
// GATES, all before any write, in order:
//   1. session (401)                 6. `SELECTION_LOCKED_STATUSES` (409)
//   2. UUID (400)                    7. admin without `actingClientId` ->
//   3. body (400)                       `admin_cannot_pick` (409); a CLIENT
//   4. ownership (403/404)              sending `actingClientId` -> 400
//   5. client visibility (404)        8. caller's per-client lock (409, client)
//                                     9. `originals_not_allowed` (409)
//                                    10. the pick gate (`already_requested` /
//                                        `pick_degraded` / `asset_not_selected`)
//
// The ADMIN branch then runs `actOnBehalf` (pick-claims.ts) in one transaction
// under the gallery row lock: it refuses a non-`proofing` gallery
// (`gallery_not_submittable`), a removed/unknown member
// (`acting_client_not_member`) and a type-only body with no pick
// (`asset_not_selected`), claims or re-resolves exactly ONE asset, and settles
// the gallery. `gatePickEdit` is deliberately NOT applied — decision 12 exempts
// the admin from decision 7, and this is the per-photo correction tool that
// makes an admin removal survivable.
//
// `pick_locked` and `pick_not_yours` (task #249) are DELETED. Both protected
// somebody else's row in `assets`; once a request can only address its own
// `asset_picks` row there is nothing left for them to guard.
//
// The response is a legacy read-only `asset` block describing the asset's
// CLAIM (what `assets` stores, unchanged by this route), plus the caller's own
// `pick` and the gallery-wide `quota`. The client cart/season tray is S6/S7's
// contract; between S4 and S7 the app's UI tabs do not render carts, which is
// stated on the task rather than papered over.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { assetPicks, assets, users } from "@/lib/db/schema";
import type { AssetPick } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { ASSET_MUTATION_BLOCKED_STATUSES, loadOwnedAsset } from "@/lib/asset-access";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { getClientLock } from "@/lib/gallery-client-locks";
import { computeQuota } from "@/lib/quota";
import { claimFromAsset, derivePickStatus, gatePickEdit } from "@/lib/pick-resolution";
import { actOnBehalf } from "@/lib/pick-claims";
import type { PickStatus } from "@/lib/pick-resolution";
import { notifySelectionChanged } from "@/lib/selection-events";

export const runtime = "nodejs";

const assetIdSchema = z.uuid();
// `selectionKind` is a plain `z.enum`, not imported from `@/lib/db/schema`'s
// own `selectionKind` pgEnum — the LITERAL union has to match
// `selection-snapshot.ts`'s hand-rolled `SelectionKind` type, which a Client
// Component reads; keep the two in sync by hand, same as that file's own
// comment asks.
const bodySchema = z
  .object({
    selected: z.boolean().optional(),
    selectionKind: z.enum(["edited", "original"]).optional(),
    // Decision 12 — the admin writes ON BEHALF OF this client. Users ids are
    // text; same shape as `galleryClientSelectionSchema.clientId`.
    actingClientId: z.string().trim().min(1).optional(),
  })
  // At least one of the two — an empty `{}` body does nothing and is refused
  // rather than silently treated as a no-op 200, matching this route's own
  // `invalid_body` stance for any other malformed request.
  .refine((body) => body.selected !== undefined || body.selectionKind !== undefined, {
    message: "at_least_one_of_selected_or_selectionKind_required",
  });

// The mutation lock — task #58 unified this with the identical set the
// DELETE and reorder routes each carried as their own local copy. This alias
// keeps the route-local, task-#73-established export name so nothing
// importing `SELECTION_LOCKED_STATUSES` from THIS module needs to change —
// but there is exactly one Set behind both names. `selected`/`delivered`/
// `archived` mean "the selection is settled, refuse EVERYONE including
// admin"; `draft` is refused separately (non-admin only) by the visibility
// gate, because an admin legitimately works there. Exported for the admin
// unlock action's own test suite, which asserts against the REAL set.
export const SELECTION_LOCKED_STATUSES = ASSET_MUTATION_BLOCKED_STATUSES;

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** The label this app uses for a person, everywhere: `name ?? email`. `null`
 * means the `users` row itself is gone (the fake DB can produce this; real
 * FKs make it a narrow window) — the honest "no attribution" outcome. */
async function pickerLabel(userId: string): Promise<string | null> {
  const [picker] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return picker ? (picker.name ?? picker.email) : null;
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
  const lookup = await loadOwnedAsset(assetIdResult.data, session);
  if (!lookup.ok) {
    return errorResponse(lookup.error, lookup.status);
  }
  const { asset, gallery } = lookup;

  // Gate 5 — a `draft` gallery is not visible to a client via the page, so it
  // must not be writable by them via this route either. Admins bypass this.
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && !isGalleryVisibleToClient(gallery.status)) {
    return errorResponse("asset_not_found", 404);
  }

  // Gate 6 — the settled-selection lock, everyone including admin.
  if (SELECTION_LOCKED_STATUSES.has(gallery.status)) {
    return errorResponse("gallery_locked", 409);
  }

  // Gate 7 — decision 12. An admin has no pick and no membership row (so the
  // `asset_picks_membership_fk` would refuse an insert anyway); they act ON
  // BEHALF of a named client, or not at all. A CLIENT sending `actingClientId`
  // is refused loudly: ignoring it would let a buggy UI believe it acted for
  // somebody else.
  const { selected, selectionKind, actingClientId } = bodyResult.data;
  if (isAdmin && !actingClientId) {
    return errorResponse("admin_cannot_pick", 409);
  }
  if (!isAdmin && actingClientId) {
    return errorResponse("invalid_body", 400);
  }

  // Gate 8 — the caller's own per-client lock. A submitted client may not
  // touch anything.
  const ownLock = await getClientLock(db, gallery.id, session.user.id);
  if (ownLock?.lockedAt) {
    return errorResponse("client_selection_locked", 409);
  }

  // Gate 9 — task #214: refuse anything that would set `selectionKind` to
  // `"original"` unless the gallery allows it. Covers both the atomic
  // "select AND mark original" combo and the type-only branch, using the same
  // 409 shape the other state-conflict gates use.
  if (selectionKind === "original" && !gallery.allowsOriginalSelection) {
    return errorResponse("originals_not_allowed", 409);
  }

  // The on-behalf branch (decision 12) hands the whole write to
  // `actOnBehalf`: one transaction, gallery lock first, then the pick and the
  // resolution. It never touches `session.user.id` as a pick owner.
  if (isAdmin && actingClientId) {
    const onBehalf = await db.transaction((tx) =>
      actOnBehalf(tx, gallery.id, asset.id, actingClientId, { selected, selectionKind }),
    );
    if (!onBehalf.ok) return errorResponse(onBehalf.error, 409);

    if (onBehalf.wrote) {
      void notifySelectionChanged(gallery.id).catch(() => {});
    }

    const siblings = await db
      .select({
        id: assets.id,
        isSelected: assets.isSelected,
        selectedAt: assets.selectedAt,
        billedTo: assets.billedTo,
        selectionKind: assets.selectionKind,
        requestedAt: assets.requestedAt,
        billedAt: assets.billedAt,
      })
      .from(assets)
      .where(eq(assets.galleryId, gallery.id));
    const current = siblings.find((row) => row.id === asset.id);
    if (!current) return errorResponse("asset_not_found", 404);
    const selectedSiblings = siblings.filter((row) => row.isSelected);
    const selectedOriginal = selectedSiblings.filter(
      (row) => row.selectionKind === "original",
    ).length;
    const quota = computeQuota(selectedSiblings.length - selectedOriginal, selectedOriginal, {
      includedPhotosSnapshot: gallery.includedPhotosSnapshot,
      extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
      extraPhotoPriceTiersSnapshot: gallery.extraPhotoPriceTiersSnapshot,
      originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
    });
    const billedLabel = current.billedTo === null ? null : await pickerLabel(current.billedTo);
    const labels: Record<string, string> = {};
    for (const person of onBehalf.delta.people) {
      labels[person.userId] = (await pickerLabel(person.userId)) ?? person.userId;
    }

    return NextResponse.json({
      asset: {
        id: current.id,
        isSelected: current.isSelected,
        selectedAt: current.selectedAt ? current.selectedAt.toISOString() : null,
        pickedBy:
          current.billedTo !== null && billedLabel !== null
            ? { id: current.billedTo, label: billedLabel }
            : null,
        selectionKind: current.selectionKind,
        requestedAt: current.requestedAt ? current.requestedAt.toISOString() : null,
      },
      pick: onBehalf.pick
        ? {
            assetId: onBehalf.pick.assetId,
            kind: onBehalf.pick.kind,
            pickedAt: onBehalf.pick.pickedAt.toISOString(),
            submittedAt: onBehalf.pick.submittedAt ? onBehalf.pick.submittedAt.toISOString() : null,
            status: derivePickStatus(
              { userId: actingClientId, submittedAt: onBehalf.pick.submittedAt },
              claimFromAsset(current),
            ),
          }
        : null,
      quota,
      actingClientId,
      pickOutcome: onBehalf.pickOutcome,
      ...(onBehalf.counts ? { pickOutcomes: onBehalf.counts } : {}),
      delta: {
        ...onBehalf.delta,
        people: onBehalf.delta.people.map((person) => ({
          ...person,
          label: labels[person.userId] ?? person.userId,
        })),
      },
    });
  }

  // The caller's OWN pick, by the composite PK. This is the only row any
  // branch below can read or write.
  const pickWhere = and(eq(assetPicks.assetId, asset.id), eq(assetPicks.userId, session.user.id));
  const [ownPick] = await db.select().from(assetPicks).where(pickWhere).limit(1);

  const claim = claimFromAsset(asset);
  const status: PickStatus | null = ownPick ? derivePickStatus(ownPick, claim) : null;

  /** Gate + retype the caller's pick, CAS-guarded on `submitted_at IS NULL`. */
  async function retype(
    pick: AssetPick,
    kind: "edited" | "original",
  ): Promise<
    { ok: false; error: "already_requested" | "pick_degraded" } | { ok: true; pick: AssetPick }
  > {
    const gate = gatePickEdit(status!, pick.kind, { type: "retype", kind });
    if (!gate.ok) return { ok: false, error: gate.error };
    const updated = await db
      .update(assetPicks)
      .set({ kind })
      .where(and(pickWhere, isNull(assetPicks.submittedAt)))
      .returning();
    if (updated.length === 0) return { ok: false, error: "already_requested" };
    return { ok: true, pick: updated[0] };
  }

  let resultingPick: AssetPick | null;
  let wrote = false;

  if (selected === true) {
    const desiredKind = selectionKind ?? "edited";
    if (!ownPick) {
      const inserted = await db
        .insert(assetPicks)
        .values({
          assetId: asset.id,
          galleryId: gallery.id,
          userId: session.user.id,
          kind: desiredKind,
          pickedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        // A concurrent double tap won the insert. Re-read and answer exactly
        // as the "own pick exists" column does.
        const [fresh] = await db.select().from(assetPicks).where(pickWhere).limit(1);
        if (!fresh) {
          // The winner's row vanished between the insert and this read (only
          // reachable via a concurrent admin delete). Honest 409, no write.
          return errorResponse("already_requested", 409);
        }
        if (fresh.kind === desiredKind) {
          resultingPick = fresh;
        } else {
          const outcome = await retype(fresh, desiredKind);
          if (!outcome.ok) return errorResponse(outcome.error, 409);
          resultingPick = outcome.pick;
          wrote = true;
        }
      } else {
        resultingPick = inserted[0];
        wrote = true;
      }
    } else if (ownPick.kind === desiredKind) {
      // Double tap on the same kind: idempotent 200, no write, no notify.
      resultingPick = ownPick;
    } else {
      const outcome = await retype(ownPick, desiredKind);
      if (!outcome.ok) return errorResponse(outcome.error, 409);
      resultingPick = outcome.pick;
      wrote = true;
    }
  } else if (selected === false) {
    if (!ownPick) {
      resultingPick = null;
    } else {
      const gate = gatePickEdit(status!, ownPick.kind, { type: "remove" });
      if (!gate.ok) return errorResponse(gate.error, 409);
      const deleted = await db
        .delete(assetPicks)
        .where(and(pickWhere, isNull(assetPicks.submittedAt)))
        .returning();
      if (deleted.length === 0) return errorResponse("already_requested", 409);
      resultingPick = null;
      wrote = true;
    }
  } else {
    // Type-only change: `bodySchema`'s `.refine` guarantees `selectionKind` is
    // defined whenever `selected` is not.
    if (!ownPick) {
      return errorResponse("asset_not_selected", 409);
    }
    if (ownPick.kind === selectionKind!) {
      resultingPick = ownPick;
    } else {
      const outcome = await retype(ownPick, selectionKind!);
      if (!outcome.ok) return errorResponse(outcome.error, 409);
      resultingPick = outcome.pick;
      wrote = true;
    }
  }

  // Task #114 — signal only when something actually changed. A no-op pings
  // nobody, matching today's "a refusal pings nobody". Fire-and-forget: the
  // write already committed; a failed NOTIFY must never fail this response.
  if (wrote) {
    void notifySelectionChanged(gallery.id).catch(() => {
      // Swallowed on purpose; the 30s fallback poll is the backstop.
    });
  }

  // Re-read the gallery's assets AFTER the write, so the reported claim and
  // quota already reflect it — never an increment of whatever the client last
  // saw. Writes to `asset_picks` do not change `assets`, which is exactly the
  // point: the sibling rows come back byte-identical.
  const siblings = await db
    .select({
      id: assets.id,
      isSelected: assets.isSelected,
      selectedAt: assets.selectedAt,
      billedTo: assets.billedTo,
      selectionKind: assets.selectionKind,
      requestedAt: assets.requestedAt,
      billedAt: assets.billedAt,
    })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  const current = siblings.find((row) => row.id === asset.id);
  if (!current) {
    // The asset vanished between the ownership read and now (gallery deleted
    // concurrently). No honest claim to report.
    return errorResponse("asset_not_found", 404);
  }

  const selectedSiblings = siblings.filter((row) => row.isSelected);
  const selectedOriginal = selectedSiblings.filter(
    (row) => row.selectionKind === "original",
  ).length;
  const selectedEdited = selectedSiblings.length - selectedOriginal;
  const quota = computeQuota(selectedEdited, selectedOriginal, {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
    extraPhotoPriceTiersSnapshot: gallery.extraPhotoPriceTiersSnapshot,
    originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
  });

  const billedLabel = current.billedTo === null ? null : await pickerLabel(current.billedTo);

  return NextResponse.json({
    asset: {
      id: current.id,
      // The CLAIM, not the caller's pick: a cart pick leaves this false.
      isSelected: current.isSelected,
      selectedAt: current.selectedAt ? current.selectedAt.toISOString() : null,
      pickedBy:
        current.billedTo !== null && billedLabel !== null
          ? { id: current.billedTo, label: billedLabel }
          : null,
      selectionKind: current.selectionKind,
      requestedAt: current.requestedAt ? current.requestedAt.toISOString() : null,
    },
    pick: resultingPick
      ? {
          assetId: resultingPick.assetId,
          kind: resultingPick.kind,
          pickedAt: resultingPick.pickedAt.toISOString(),
          submittedAt: resultingPick.submittedAt ? resultingPick.submittedAt.toISOString() : null,
          status: derivePickStatus(
            { userId: session.user.id, submittedAt: resultingPick.submittedAt },
            claimFromAsset(current),
          ),
        }
      : null,
    quota,
  });
});
