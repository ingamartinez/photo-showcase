// Epic #250, task #259 (S4) — the CART-TO-CLAIM write half of "choosing is
// asking, not owning". Server-only: it opens a transaction the caller already
// holds (the submit route; S5's admin per-client lock reuses it for decision
// 18) and mutates `asset_picks` plus the resolved `assets` truth.
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
import type { DbTransaction } from "@/lib/gallery-client-locks";
import { assetPicks, assets } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import {
  arrivalAfter,
  claimFromAsset,
  compareCartOrder,
  latestBilledAt,
  submitPick,
} from "@/lib/pick-resolution";

/** One count per `submitPick` outcome for a single `claimCart` call. */
export type CartClaimCounts = {
  claimed: number;
  escalated: number;
  joined: number;
  escalationBlocked: number;
};

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

/**
 * Precondition: `lockedGallery` is the row `lockGalleryRow(tx, …)` returned in
 * THIS transaction, and `now` was taken AFTER that lock. The type cannot prove
 * it; every call site has to hold the lock result, which makes "lock first"
 * visible where it matters.
 */
export async function claimCart(
  tx: DbTransaction,
  lockedGallery: Gallery,
  userId: string,
  now: Date,
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
  const rows = await tx
    .select({
      id: assets.id,
      isSelected: assets.isSelected,
      selectionKind: assets.selectionKind,
      billedTo: assets.billedTo,
      billedAt: assets.billedAt,
      finalKey: assets.finalKey,
    })
    .from(assets)
    .where(eq(assets.galleryId, lockedGallery.id));

  // Step 3 — one arrival for the whole call. The `isSelected` filter matters:
  // `removeGalleryClientPicks` unclaims without clearing `billed_at`, so an
  // unclaimed row can carry a stale `billedAt` until S5.
  const arrival = arrivalAfter(
    now,
    latestBilledAt(rows.filter((row) => row.isSelected).map((row) => row.billedAt)),
  );

  // Step 4 — resolve each frozen pick, in cart order. One pick per (asset,
  // user) PK, so no asset appears twice in one call.
  stamped.sort(compareCartOrder);
  const counts: CartClaimCounts = { claimed: 0, escalated: 0, joined: 0, escalationBlocked: 0 };
  let newUnits = 0;

  for (const pick of stamped) {
    const row = rows.find((candidate) => candidate.id === pick.assetId);
    if (!row) {
      throw new Error(`pick-claims: cart pick references unknown asset ${pick.assetId}`);
    }
    const outcome = submitPick(
      claimFromAsset(row),
      { userId, kind: pick.kind },
      { arrival, hasFinal: row.finalKey !== null },
    );

    if (outcome.type === "claimed") {
      const written = await tx
        .update(assets)
        .set({
          isSelected: true,
          selectedAt: arrival,
          requestedAt: arrival,
          selectionKind: pick.kind,
          billedTo: userId,
          billedAt: arrival,
        })
        .where(and(eq(assets.id, row.id), eq(assets.isSelected, false)))
        .returning({ id: assets.id });
      if (written.length !== 1) {
        throw new Error(`pick-claims: claim CAS lost on asset ${row.id}`);
      }
      counts.claimed += 1;
      newUnits += 1;
      continue;
    }

    if (outcome.type === "escalated") {
      // This CAS is the one that CAN be lost in practice, and it fails closed.
      // `final/route.ts:682` writes `assets.final_key` WITHOUT taking the
      // gallery lock, and a rolling gallery finishes proofs while it is still
      // `proofing`. So an upload can commit between step 2's read and this
      // UPDATE: the `final_key IS NULL` predicate then matches nothing, the
      // throw rolls the whole submit back as a 500, and a retry resolves to
      // `escalation_blocked` — never billing an edited unit over a photo that
      // already has a final. (The claim CAS above is a different matter: every
      // other claimer of an unclaimed asset holds the gallery lock.)
      const written = await tx
        .update(assets)
        .set({ selectionKind: "edited", billedTo: userId, billedAt: arrival })
        .where(
          and(
            eq(assets.id, row.id),
            eq(assets.isSelected, true),
            eq(assets.selectionKind, "original"),
            isNull(assets.finalKey),
          ),
        )
        .returning({ id: assets.id });
      if (written.length !== 1) {
        throw new Error(`pick-claims: claim CAS lost on asset ${row.id}`);
      }
      counts.escalated += 1;
      newUnits += 1;
      continue;
    }

    // `joined` and `escalation_blocked` (decision 15) write nothing: the pick
    // is submitted, the claim is unchanged, the kind stays as resolved.
    if (outcome.type === "joined") counts.joined += 1;
    else counts.escalationBlocked += 1;
  }

  return { stamped: stamped.length, newUnits, counts, arrival };
}
