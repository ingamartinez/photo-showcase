// The ONE place the quota maths lives (task #24, PLAN.md §3). Every surface
// that shows a client "how many photos, how many extras, how much surcharge"
// — the live counter on the client gallery page, and the selection route's
// JSON response after each toggle — calls this SAME pure function instead of
// re-deriving the numbers inline. No arithmetic scattered through components.
//
// All three prices below are the gallery row's own FROZEN snapshot columns
// (`includedPhotosSnapshot`, `extraPhotoPriceCopSnapshot`,
// `originalPhotoPriceCopSnapshot` — see schema.ts's comment on those columns
// and src/lib/galleries.ts's header comment): never the live `packages` row.
// A gallery created under last year's price list must keep last year's
// numbers forever, even after the photographer edits today's price list.
// Nothing in this module ever touches `packages`.
//
// No side effects, no I/O — this takes plain numbers in and returns plain
// numbers out, so it is unit-testable without a database and safe to call
// from both a Server Component (initial paint) and a Route Handler (after a
// toggle), which is exactly how it's used.
// (No imports on purpose: quota.test.ts guards that this module stays free of
// them. The tier TYPE and its lookup therefore live here; the validator and
// the display helpers live in extra-price-tiers.ts, which imports from here.)

/** One step of a gallery's volume scale (task #231): from `minExtras` extras
 * upward, EVERY extra costs `priceCop` (volume pricing, not marginal). */
export type ExtraPriceTier = { minExtras: number; priceCop: number };

/** Index of the tier reached by `extras` — the greatest `minExtras <=
 * extras` — or -1 when no tier is reached yet (zero extras). Does not rely on
 * the tiers being sorted. The ONLY place the scale is looked up: the display
 * surfaces highlight "the current tier" through this, never their own scan. */
export function tierIndexForExtras(extras: number, tiers: readonly ExtraPriceTier[]): number {
  let found = -1;
  tiers.forEach((tier, i) => {
    if (tier.minExtras <= extras && (found === -1 || tier.minExtras >= tiers[found]!.minExtras)) {
      found = i;
    }
  });
  return found;
}

/** Unit price of the tier reached by `extras`; with zero extras, the first
 * tier's price (what the next photo would cost). */
export function unitPriceForExtras(extras: number, tiers: readonly ExtraPriceTier[]): number {
  return tiers[Math.max(0, tierIndexForExtras(extras, tiers))]!.priceCop;
}

export type GalleryQuotaSnapshot = {
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  /** Task #231 — frozen volume scale for extras. `null` = flat price (every
   * gallery created before the scale existed): the maths is then byte-for-byte
   * what it was. With a scale, THIS is the source of truth and
   * `extraPhotoPriceCopSnapshot` only mirrors the first tier. Optional ONLY
   * so a flat-price caller (and the many flat-price fixtures) can omit it;
   * every production caller that reads a gallery row passes it explicitly. */
  extraPhotoPriceTiersSnapshot?: ExtraPriceTier[] | null;
  originalPhotoPriceCopSnapshot: number;
};

export type QuotaResult = {
  /** `selectedEdited + selectedOriginal` — DERIVED by the caller, never
   * stored; this function only ever receives the already-counted numbers. */
  selected: number;
  /** `count(assets where is_selected AND selection_kind = 'edited')` — the
   * ONLY count the included-photos quota applies to (task #205's owner
   * decision below). */
  selectedEdited: number;
  /** `count(assets where is_selected AND selection_kind = 'original')` —
   * ALWAYS charged, never covered by the quota; see `originals` below. */
  selectedOriginal: number;
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  /** Echo of the frozen scale (task #231), `null` for a flat-price gallery. */
  extraPhotoPriceTiersSnapshot: ExtraPriceTier[] | null;
  /** Unit price EVERY extra pays right now (task #231): the tier reached by
   * `extras` (volume pricing, not marginal); with zero extras the first
   * tier's price, i.e. what the next photo would cost. Flat galleries: equal
   * to `extraPhotoPriceCopSnapshot`. Display surfaces read THIS, never the
   * snapshot, and never compute a tier themselves. */
  extraUnitPriceCop: number;
  originalPhotoPriceCopSnapshot: number;
  /** `max(0, selectedEdited - includedPhotosSnapshot)` — going over the
   * quota is upsell, never an error, so this is clamped at 0 rather than
   * allowed to go negative when `selectedEdited` is under the included
   * count. The included-photos quota covers EDITED picks only (task #205,
   * owner decision 2026-08-01): an original is always charged, whether the
   * gallery is over or under its included count, so it never reduces or
   * grows this number. */
  extras: number;
  /** `max(0, selectedOriginal)` — every original pick, charged in full. The
   * quota never absorbs any of these: the owner explicitly rejected "the
   * quota covers whichever picks" because that forces an arbitrary rule for
   * WHICH picks count as the free ones (oldest, cheapest, most expensive),
   * and each rule gives a different total for the same selection. "Originals
   * always pay, edits get the quota" has no such ambiguity. */
  originals: number;
  /** `extras * extraUnitPriceCop` — the edited-only slice of
   * `surchargeCop` below. Task #206's own addition, for the two-tariff
   * breakdown `selection-counter.tsx`/`submit-selection-panel.tsx` show once
   * a gallery has any originals: those components are not allowed to
   * multiply anything themselves (their own header comments say so), so this
   * is the pre-multiplied number they read instead of re-deriving it. With
   * zero originals this is byte-identical to `surchargeCop` — the same
   * "identical to the pre-#205 formula" guarantee below, just also exposed
   * under its own name. */
  extrasSurchargeCop: number;
  /** `originals * originalPhotoPriceCopSnapshot` — the originals-only slice
   * of `surchargeCop` below, for the exact same reason `extrasSurchargeCop`
   * exists: a display surface that needs "how much of the total is
   * originals" must read it here, never compute `quota.originals *
   * quota.originalPhotoPriceCopSnapshot` itself. Zero when there are no
   * originals. */
  originalsSurchargeCop: number;
  /** `extrasSurchargeCop + originalsSurchargeCop` — DISPLAYED to the client,
   * never charged: this app has no payment gateway (PLAN.md §3). With zero
   * originals this is byte-identical to the pre-#205 formula (`extras *
   * extraPhotoPriceCopSnapshot`) — see quota.test.ts's own "zero originals"
   * cases, which pin exactly that. */
  surchargeCop: number;
};

/** The quota maths (PLAN.md §3 / task #24, extended by task #205):
 * `selected`, `extras`, `surchargeCop` — now split between EDITED picks
 * (which the included-photos quota applies to) and ORIGINAL picks (which are
 * always charged, in or out of the quota). See this module's header comment
 * for the owner's reasoning on why the quota never covers originals. */
export function computeQuota(
  selectedEdited: number,
  selectedOriginal: number,
  snapshot: GalleryQuotaSnapshot,
): QuotaResult {
  const extras = Math.max(0, selectedEdited - snapshot.includedPhotosSnapshot);
  const originals = Math.max(0, selectedOriginal);
  const tiers = snapshot.extraPhotoPriceTiersSnapshot;
  const extraUnitPriceCop =
    tiers && tiers.length > 0
      ? unitPriceForExtras(extras, tiers)
      : snapshot.extraPhotoPriceCopSnapshot;
  const extrasSurchargeCop = extras * extraUnitPriceCop;
  const originalsSurchargeCop = originals * snapshot.originalPhotoPriceCopSnapshot;
  const surchargeCop = extrasSurchargeCop + originalsSurchargeCop;

  return {
    selected: selectedEdited + selectedOriginal,
    selectedEdited,
    selectedOriginal,
    includedPhotosSnapshot: snapshot.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: snapshot.extraPhotoPriceCopSnapshot,
    extraPhotoPriceTiersSnapshot: tiers ?? null,
    extraUnitPriceCop,
    originalPhotoPriceCopSnapshot: snapshot.originalPhotoPriceCopSnapshot,
    extras,
    originals,
    extrasSurchargeCop,
    originalsSurchargeCop,
    surchargeCop,
  };
}
