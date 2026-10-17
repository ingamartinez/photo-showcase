// Epic #250, task #258 (S3) — the pure ATTRIBUTION layer over `computeQuota`.
//
// `computeQuota` (quota.ts) answers the GALLERY question: how many extras, at
// what unit price, for how much surcharge. It does not know or care WHO picked
// what. This module splits that same gallery-wide result among the people who
// claimed the units, without re-deriving any of it.
//
// THE TRAP, in capitals because it is the whole point: never call
// `computeQuota` per person. Doing so would (a) apply `includedPhotosSnapshot`
// once per person when decision 6 says the pool is GLOBAL, and (b) price each
// person's extras at the tier reached by THEIR OWN count instead of the
// gallery's. Either one breaks the Σ invariant the tests pin. There is exactly
// ONE `computeQuota` call here, over the whole gallery, and `includedSlots` is
// derived from ITS output.
//
// The total is unambiguous (quota.ts:79-87 records the owner's rejection of
// "an arbitrary rule for WHICH picks are free"); arrival order only splits an
// identical total among people. It never changes the `QuotaResult`.
//
// Pure: no I/O, no side effects, safe to import from a client component. The
// test suite guards that the import list below stays exactly two lines.
import { computeQuota, type GalleryQuotaSnapshot, type QuotaResult } from "@/lib/quota";
import type { SelectionKind } from "@/lib/selection-snapshot";

/** One CLAIMED unit of an asset: the resolved truth of `assets`, not a pick.
 * Several people may hold a pick for the same asset (decision 1), but exactly
 * one of them owns the asset's billed unit (decision 4). */
export type ClaimedUnit = {
  assetId: string;
  /** `assets.billedTo` (the DB column `selected_by`; the TS field was renamed
   * in S4, #259). `null` = a legacy unit; it lands in the "Sin registro" bucket. */
  billedTo: string | null;
  /** `assets.selection_kind`, the RESOLVED kind. */
  kind: SelectionKind;
  /** `assets.billed_at`. Nullable in the schema; legacy rows are the only
   * source. See `compareArrival`. */
  billedAt: Date | null;
};

export type UnitCharge = "included" | "extra" | "original";

export type AttributedUnit = ClaimedUnit & {
  charge: UnitCharge;
  /** 0 for included, `quota.extraUnitPriceCop` for extra,
   * `quota.originalPhotoPriceCopSnapshot` for original. */
  priceCop: number;
};

export type AttributionShare = {
  included: number;
  extras: number;
  originals: number;
  /** `extras * quota.extraUnitPriceCop`. */
  extrasSurchargeCop: number;
  /** `originals * quota.originalPhotoPriceCopSnapshot`. */
  originalsSurchargeCop: number;
  /** `extrasSurchargeCop + originalsSurchargeCop`. */
  surchargeCop: number;
};

export type PersonShare = AttributionShare & { userId: string };

export type QuotaAttribution = {
  /** EXACTLY `computeQuota(editedCount, originalCount, snapshot)`. */
  quota: QuotaResult;
  /** Every input unit, sorted by `compareArrival`, annotated. */
  units: AttributedUnit[];
  /** One entry per distinct non-null `billedTo` with >= 1 unit, sorted by
   * `userId` code-unit. */
  people: PersonShare[];
  /** The "Sin registro" bucket: units with `billedTo === null`. ALWAYS
   * present, all zeros when empty. */
  unattributed: AttributionShare;
};

/**
 * Arrival order, the ONE definition of "who gets an included slot":
 * `billedAt === null` FIRST, then ascending `billedAt.getTime()`, then
 * `assetId` in UTF-16 code-unit order (`<` / `>`, never `localeCompare`,
 * which depends on the locale and is not deterministic). Returns -1/0/1 and 0
 * only for the same asset.
 *
 * NULLS FIRST, not Postgres' default NULLS LAST: a null `billedAt` can only
 * be legacy (the backfill wrote `coalesce(requested_at, selected_at)`; every
 * new write sets a Date). With nulls last, the next dated claim would sort
 * BEFORE a legacy unit and could take its included slot, raising the legacy
 * holder's surcharge and violating decision 7. Nulls first means a new
 * arrival is always appended.
 *
 * Ids are lowercase-hex UUIDs, and for those code-unit order equals Postgres
 * `uuid` byte order, so a future SQL `ORDER BY billed_at, asset_id` agrees
 * with this function apart from the null placement, which the JS sort owns.
 */
export function compareArrival(
  a: { billedAt: Date | null; assetId: string },
  b: { billedAt: Date | null; assetId: string },
): number {
  if (a.billedAt === null && b.billedAt !== null) return -1;
  if (a.billedAt !== null && b.billedAt === null) return 1;
  if (a.billedAt !== null && b.billedAt !== null) {
    const diff = a.billedAt.getTime() - b.billedAt.getTime();
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.assetId === b.assetId) return 0;
  return a.assetId < b.assetId ? -1 : 1;
}

const emptyShare = (): AttributionShare => ({
  included: 0,
  extras: 0,
  originals: 0,
  extrasSurchargeCop: 0,
  originalsSurchargeCop: 0,
  surchargeCop: 0,
});

function addUnit(share: AttributionShare, unit: AttributedUnit, quota: QuotaResult): void {
  if (unit.charge === "included") {
    share.included += 1;
    return;
  }
  if (unit.charge === "extra") {
    share.extras += 1;
    share.extrasSurchargeCop += quota.extraUnitPriceCop;
    share.surchargeCop += quota.extraUnitPriceCop;
    return;
  }
  share.originals += 1;
  share.originalsSurchargeCop += quota.originalPhotoPriceCopSnapshot;
  share.surchargeCop += quota.originalPhotoPriceCopSnapshot;
}

/**
 * The attribution algorithm, in order:
 * 1. A duplicate `assetId` throws: one asset carries one unit (decision 4),
 *    so a duplicate is a caller bug that would double-count.
 * 2. Sort by `compareArrival`.
 * 3. Count edited/original from the sorted list and call `computeQuota` ONCE,
 *    gallery-wide.
 * 4. `includedSlots` is derived from `computeQuota`'s own output, so the pool
 *    is never re-implemented: if `computeQuota` changed, this would follow.
 * 5. Edited units take the included slots in arrival order, then extras;
 *    originals are always charged.
 * 6. Bucket by `billedTo`, each share priced at the gallery's unit prices.
 */
export function attributeQuota(
  units: readonly ClaimedUnit[],
  snapshot: GalleryQuotaSnapshot,
): QuotaAttribution {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.assetId)) {
      throw new Error(`quota-attribution: duplicate unit for asset ${unit.assetId}`);
    }
    seen.add(unit.assetId);
  }

  const sorted = [...units].sort(compareArrival);
  const editedCount = sorted.filter((u) => u.kind === "edited").length;
  const originalCount = sorted.length - editedCount;
  const quota = computeQuota(editedCount, originalCount, snapshot);
  const includedSlots = quota.selectedEdited - quota.extras;

  const attributed: AttributedUnit[] = [];
  const byPerson = new Map<string, PersonShare>();
  const unattributed = emptyShare();
  let editedSeen = 0;

  for (const unit of sorted) {
    let charge: UnitCharge;
    let priceCop: number;
    if (unit.kind === "original") {
      charge = "original";
      priceCop = quota.originalPhotoPriceCopSnapshot;
    } else if (editedSeen < includedSlots) {
      charge = "included";
      priceCop = 0;
      editedSeen += 1;
    } else {
      charge = "extra";
      priceCop = quota.extraUnitPriceCop;
    }
    const attributedUnit: AttributedUnit = { ...unit, charge, priceCop };
    attributed.push(attributedUnit);

    if (unit.billedTo === null) {
      addUnit(unattributed, attributedUnit, quota);
    } else {
      let share = byPerson.get(unit.billedTo);
      if (!share) {
        share = { userId: unit.billedTo, ...emptyShare() };
        byPerson.set(unit.billedTo, share);
      }
      addUnit(share, attributedUnit, quota);
    }
  }

  const people = [...byPerson.values()].sort((a, b) =>
    a.userId === b.userId ? 0 : a.userId < b.userId ? -1 : 1,
  );

  return { quota, units: attributed, people, unattributed };
}

/** The share for one person, or the all-zero share when they have no unit.
 * `null` returns the "Sin registro" bucket. Never throws, so members with
 * zero units need no special case at the call sites. */
export function shareFor(attribution: QuotaAttribution, userId: string | null): AttributionShare {
  if (userId === null) return attribution.unattributed;
  const person = attribution.people.find((p) => p.userId === userId);
  if (!person) return emptyShare();
  const { userId: _ignored, ...share } = person;
  return share;
}
