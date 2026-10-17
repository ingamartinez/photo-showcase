// Epic #250, task #259 (S4) — the CART-TO-CLAIM write half of "choosing is
// asking, not owning". Server-only: it opens a transaction the caller already
// holds (the submit route; S5's admin per-client lock reuses it for decision
// 18) and mutates `asset_picks` plus the resolved `assets` truth.
//
// Task #260 (S5) refactored the former hand-written loop onto the PURE
// planners in `pick-plans.ts`, and added the admin half: `applyAssetChanges`,
// `readPickState`, `reresolveAssets` and `actOnBehalf`. The plan the admin
// previews and the plan this module executes are now literally the same
// function (parity-tested), so "what it says will happen" and "what happens"
// cannot drift.
//
// THE ORDER IS THE WHOLE POINT. The cart is frozen FIRST with
// `UPDATE asset_picks SET submitted_at = now() WHERE submitted_at IS NULL
// RETURNING …`, and only the returned rows are resolved into claims. The
// PATCH route takes no gallery lock, so "claim then stamp" would leave a
// window where a committed client delete removes the pick after its unit was
// already claimed — a ghost unit nobody can remove (the S2 plan §6.1 hazard).
// Stamp-first makes the `submitted_at IS NULL` predicate itself the CAS: a
// concurrent PATCH delete or retype either commits before the stamp (the row
// is not returned, not claimed) or blocks on the row lock and, after this
// transaction commits, re-checks the predicate against the new row version,
// matches nothing, and answers `already_requested`.
//
// One `arrival` serves the whole call (epic: included slots are assigned by
// arrival order, and a later submit must never steal an earlier person's
// slot). It is computed AFTER the gallery row lock, from the gallery's latest
// `billed_at`, and `now` must also have been taken after that lock.
//
// The import list below stays deliberately small; this module is the only
// new writer of `assets` in the client write path.
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import {
  getClientLock,
  lockGalleryRow,
  settleGalleryLockStatus,
  type DbExecutor,
  type DbTransaction,
  type LockTransition,
} from "@/lib/gallery-client-locks";
import { assetPicks, assets } from "@/lib/db/schema";
import type { AssetPick, Gallery } from "@/lib/db/schema";
import type { SelectionKind } from "@/lib/selection-snapshot";
import {
  attributionDeltaBetween,
  planCartClaim,
  planReresolve,
  type AssetChange,
  type AttributionDelta,
  type CartClaimCounts,
  type PickPlan,
  type PickRow,
  type AssetRow,
} from "@/lib/pick-plans";

export type { CartClaimCounts };

export type CartClaimResult = {
  /** Picks whose `submitted_at` THIS call actually set. */
  stamped: number;
  /** `claimed + escalated`: the photographer's new work, what the rolling
   * notification email's `requestedCount` reports. Joined picks add none. */
  newUnits: number;
  counts: CartClaimCounts;
  /** Null iff `stamped === 0`. */
  arrival: Date | null;
};

/** The gallery's four frozen commercial terms, the input `attributeQuota`
 * needs. Read from the gallery row the caller already holds. */
export function quotaSnapshotOf(gallery: Gallery) {
  return {
    includedPhotosSnapshot: gallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
    extraPhotoPriceTiersSnapshot: gallery.extraPhotoPriceTiersSnapshot,
    originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
  };
}

/** The asset rows and the picks of ONE gallery — two selects, `gallery_id`
 * only. Shared by the write paths (inside the transaction) and the dashboard
 * page (for previews), so both read exactly the same state. */
export async function readPickState(
  executor: DbExecutor,
  galleryId: string,
): Promise<{ rows: AssetRow[]; picks: PickRow[] }> {
  const rows = await executor
    .select({
      id: assets.id,
      isSelected: assets.isSelected,
      selectionKind: assets.selectionKind,
      billedTo: assets.billedTo,
      billedAt: assets.billedAt,
      finalKey: assets.finalKey,
      selectedAt: assets.selectedAt,
      requestedAt: assets.requestedAt,
    })
    .from(assets)
    .where(eq(assets.galleryId, galleryId));

  const picks = await executor
    .select({
      assetId: assetPicks.assetId,
      userId: assetPicks.userId,
      kind: assetPicks.kind,
      pickedAt: assetPicks.pickedAt,
      submittedAt: assetPicks.submittedAt,
    })
    .from(assetPicks)
    .where(eq(assetPicks.galleryId, galleryId));

  return { rows, picks };
}

/**
 * Execute one plan's asset diff. One UPDATE per change, each CAS-guarded on
 * what the plan READ, so a concurrent writer makes the update match nothing
 * and the whole transaction rolls back as a 500 instead of writing a
 * resolution that no longer describes reality (the same stance `claimCart`
 * has always taken for a claim).
 *
 * Per op:
 * - `claim` writes every claim column (a fresh claim is also an order);
 * - `unclaim` clears ALL of them, `billed_at` included — hazard 4;
 * - `escalate`/`transfer`/`rekind`/`transfer_rekind` write the resolved kind,
 *   holder and `billed_at`. A kind change is additionally guarded on
 *   `final_key IS NULL` (decision 15): a final landing between the plan's read
 *   and this write must never re-label a delivered file.
 * `selectedAt`/`requestedAt` are never touched on an existing claim: the
 * claim moment does not move because an admin removed somebody else's pick.
 */
export async function applyAssetChanges(
  tx: DbTransaction,
  changes: readonly AssetChange[],
  arrival: Date,
): Promise<void> {
  for (const change of changes) {
    const { before, after } = change;
    const id = eq(assets.id, change.assetId);

    if (!after.claimed) {
      const written = await tx
        .update(assets)
        .set({
          isSelected: false,
          selectedAt: null,
          requestedAt: null,
          billedTo: null,
          billedAt: null,
          selectionKind: "edited",
        })
        .where(
          and(
            id,
            eq(assets.isSelected, true),
            before.claimed && before.billedTo !== null
              ? eq(assets.billedTo, before.billedTo)
              : isNull(assets.billedTo),
          ),
        )
        .returning({ id: assets.id });
      if (written.length !== 1) {
        throw new Error(`pick-claims: claim CAS lost on asset ${change.assetId}`);
      }
      continue;
    }

    if (!before.claimed) {
      const written = await tx
        .update(assets)
        .set({
          isSelected: true,
          selectedAt: arrival,
          requestedAt: arrival,
          selectionKind: after.kind,
          billedTo: after.billedTo,
          billedAt: after.billedAt ?? arrival,
        })
        .where(and(id, eq(assets.isSelected, false)))
        .returning({ id: assets.id });
      if (written.length !== 1) {
        throw new Error(`pick-claims: claim CAS lost on asset ${change.assetId}`);
      }
      continue;
    }

    const kindChanged = before.kind !== after.kind;
    const written = await tx
      .update(assets)
      .set({
        selectionKind: after.kind,
        billedTo: after.billedTo,
        billedAt: after.billedAt,
      })
      .where(
        and(
          id,
          eq(assets.isSelected, true),
          eq(assets.selectionKind, before.kind),
          before.billedTo === null ? isNull(assets.billedTo) : eq(assets.billedTo, before.billedTo),
          ...(kindChanged ? [isNull(assets.finalKey)] : []),
        ),
      )
      .returning({ id: assets.id });
    if (written.length !== 1) {
      throw new Error(`pick-claims: claim CAS lost on asset ${change.assetId}`);
    }
  }
}

/**
 * Precondition: `lockedGallery` is the row `lockGalleryRow(tx, …)` returned in
 * THIS transaction, and `now` was taken AFTER that lock. The type cannot prove
 * it; every call site has to hold the lock result, which makes "lock first"
 * visible where it matters.
 *
 * `opts.assetId` restricts the stamp to ONE asset — the on-behalf PATCH
 * claims only the photo the admin acted on, leaving the rest of that person's
 * cart in the cart (decision 12: one photo is reclaimed, not their whole
 * basket).
 */
export async function claimCart(
  tx: DbTransaction,
  lockedGallery: Gallery,
  userId: string,
  now: Date,
  opts: { assetId?: string } = {},
): Promise<CartClaimResult> {
  // Step 1 — freeze and collect. The predicate is the CAS (see the header).
  const stamped = await tx
    .update(assetPicks)
    .set({ submittedAt: now })
    .where(
      and(
        eq(assetPicks.galleryId, lockedGallery.id),
        eq(assetPicks.userId, userId),
        isNull(assetPicks.submittedAt),
        ...(opts.assetId ? [eq(assetPicks.assetId, opts.assetId)] : []),
      ),
    )
    .returning({
      assetId: assetPicks.assetId,
      kind: assetPicks.kind,
      pickedAt: assetPicks.pickedAt,
    });

  if (stamped.length === 0) {
    return {
      stamped: 0,
      newUnits: 0,
      counts: { claimed: 0, escalated: 0, joined: 0, escalationBlocked: 0 },
      arrival: null,
    };
  }

  // Step 2 — the resolved asset truth, read AFTER the lock and the stamp.
  const { rows } = await readPickState(tx, lockedGallery.id);

  // Step 3-4 — the plan. `planCartClaim` is the SAME function the dashboard
  // previews a lock with; the sort, the one arrival and every `submitPick`
  // call live there now.
  const plan = planCartClaim(
    rows,
    stamped.map((pick) => ({
      assetId: pick.assetId,
      userId,
      kind: pick.kind,
      pickedAt: pick.pickedAt,
      submittedAt: null,
    })),
    userId,
    now,
    // The column is `notNull().default(false)`, so a real row always carries a
    // boolean; a partial test fixture that omits it must not be read as "OFF",
    // which would silently coerce picks in suites that never modelled the flag.
    { allowsOriginal: lockedGallery.allowsOriginalSelection !== false },
  );

  // Step 5 — an `original` cart pick in a gallery that no longer allows them
  // is coerced to `edited` BEFORE it is resolved. The PATCH gate reads the
  // flag without the gallery lock, so a retype can land after an OFF commits;
  // this is where the money boundary closes that race for every claimer.
  for (const assetId of plan.pickKindFixes) {
    await tx
      .update(assetPicks)
      .set({ kind: "edited" })
      .where(
        and(
          eq(assetPicks.galleryId, lockedGallery.id),
          eq(assetPicks.userId, userId),
          eq(assetPicks.assetId, assetId),
        ),
      );
  }

  await applyAssetChanges(tx, plan.assetChanges, plan.arrival);

  return {
    stamped: stamped.length,
    newUnits: plan.counts.claimed + plan.counts.escalated,
    counts: plan.counts,
    arrival: plan.arrival,
  };
}

/** Re-resolve the given assets from the gallery's picks as they stand now.
 * The caller has already deleted or retyped the picks. */
export async function reresolveAssets(
  tx: DbTransaction,
  lockedGallery: Gallery,
  affectedAssetIds: readonly string[],
  now: Date,
): Promise<PickPlan> {
  if (affectedAssetIds.length === 0) return { assetChanges: [], arrival: null };
  const { rows, picks } = await readPickState(tx, lockedGallery.id);
  const plan = planReresolve(rows, picks, affectedAssetIds, now);
  if (plan.assetChanges.length > 0) {
    await applyAssetChanges(tx, plan.assetChanges, plan.arrival ?? now);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Decision 12 — the admin acts on behalf of ONE client (task #260).
// ---------------------------------------------------------------------------

export type OnBehalfFailure =
  "gallery_not_submittable" | "acting_client_not_member" | "asset_not_selected";

export type OnBehalfResult =
  | { ok: false; error: OnBehalfFailure }
  | {
      ok: true;
      /** Whether anything at all was written (drives the NOTIFY). */
      wrote: boolean;
      transition: LockTransition;
      /** The acting client's pick AFTER the operation, re-read. */
      pick: AssetPick | null;
      /** `claimCart`'s counts when a cart pick was claimed, otherwise null. */
      counts: CartClaimCounts | null;
      /** What the operation did to the acting client's pick. */
      pickOutcome: "claimed" | "reresolved" | "removed" | "none";
      delta: AttributionDelta;
    };

/**
 * The whole on-behalf write, in ONE transaction under the gallery row lock.
 *
 * Every branch leaves the acting client with either no pick or a SUBMITTED
 * one — "la foto se reclama en el acto" (decision 12). A pick is only ever
 * inserted for the acting client (`user_id`), never for the admin: decision 12
 * forbids admin picks, and the membership FK has no row for one.
 *
 * The admin is exempt from decision 7, so `gatePickEdit` is NOT applied here:
 * this is the per-photo correction tool that makes an admin removal survivable
 * (hazard 2). It is still gated on `proofing`: claims only exist while picking
 * is live, and `draft` is an admin preview where `assets` is not writable.
 *
 * Claiming or deleting the client's LAST cart pick can flip their "done" state,
 * so this settles the gallery in the same transaction (decision 13).
 */
export async function actOnBehalf(
  tx: DbTransaction,
  galleryId: string,
  assetId: string,
  actingClientId: string,
  body: { selected?: boolean; selectionKind?: SelectionKind },
): Promise<OnBehalfResult> {
  const gallery = await lockGalleryRow(tx, galleryId);
  if (!gallery || gallery.status !== "proofing") {
    return { ok: false, error: "gallery_not_submittable" };
  }
  const membership = await getClientLock(tx, gallery.id, actingClientId);
  if (!membership) return { ok: false, error: "acting_client_not_member" };

  // `now` AFTER the lock — arrival order decides included slots.
  const now = new Date();
  const stateBefore = await readPickState(tx, gallery.id);

  const pickWhere = and(eq(assetPicks.assetId, assetId), eq(assetPicks.userId, actingClientId));
  const [existing] = await tx.select().from(assetPicks).where(pickWhere).limit(1);

  let wrote = false;
  let counts: CartClaimCounts | null = null;
  let pickOutcome: "claimed" | "reresolved" | "removed" | "none" = "none";

  async function claimOne(): Promise<void> {
    const claim = await claimCart(tx, gallery!, actingClientId, now, { assetId });
    counts = claim.counts;
    if (claim.stamped > 0) wrote = true;
    pickOutcome = "claimed";
  }

  async function reresolveOne(): Promise<void> {
    const plan = await reresolveAssets(tx, gallery!, [assetId], now);
    if (plan.assetChanges.length > 0) wrote = true;
    pickOutcome = "reresolved";
  }

  if (body.selected === false) {
    if (existing) {
      await tx.delete(assetPicks).where(pickWhere);
      wrote = true;
      if (existing.submittedAt !== null) await reresolveOne();
      pickOutcome = "removed";
    }
  } else if (body.selected === true) {
    const desired: SelectionKind = body.selectionKind ?? "edited";
    if (!existing) {
      await tx
        .insert(assetPicks)
        .values({
          assetId,
          galleryId: gallery.id,
          userId: actingClientId,
          kind: desired,
          pickedAt: now,
        })
        .onConflictDoNothing();
      wrote = true;
      await claimOne();
    } else {
      const kindChanged = existing.kind !== desired;
      if (kindChanged) {
        await tx.update(assetPicks).set({ kind: desired }).where(pickWhere);
        wrote = true;
      }
      if (existing.submittedAt === null) await claimOne();
      else if (kindChanged) await reresolveOne();
    }
  } else {
    // Type-only change: an explicit `selectionKind` for an existing pick.
    if (!existing) return { ok: false, error: "asset_not_selected" };
    const kindChanged = existing.kind !== body.selectionKind;
    if (kindChanged) {
      await tx.update(assetPicks).set({ kind: body.selectionKind! }).where(pickWhere);
      wrote = true;
    }
    if (existing.submittedAt === null) await claimOne();
    else if (kindChanged) await reresolveOne();
  }

  const transition = await settleGalleryLockStatus(tx, gallery.id);
  if (transition !== null) wrote = true;

  const [pick] = await tx.select().from(assetPicks).where(pickWhere).limit(1);
  const stateAfter = await readPickState(tx, gallery.id);
  const delta = attributionDeltaBetween(
    stateBefore.rows,
    stateAfter.rows,
    quotaSnapshotOf(gallery),
  );

  return { ok: true, wrote, transition, pick: pick ?? null, counts, pickOutcome, delta };
}
