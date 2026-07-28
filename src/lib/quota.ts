// The ONE place the quota maths lives (task #24, PLAN.md §3). Every surface
// that shows a client "how many photos, how many extras, how much surcharge"
// — the live counter on the client gallery page, and the selection route's
// JSON response after each toggle — calls this SAME pure function instead of
// re-deriving the numbers inline. No arithmetic scattered through components.
//
// Both inputs below are the gallery row's own FROZEN snapshot columns
// (`includedPhotosSnapshot`, `extraPhotoPriceCopSnapshot` — see schema.ts's
// comment on those columns and src/lib/galleries.ts's header comment): never
// the live `packages` row. A gallery created under last year's price list
// must keep last year's numbers forever, even after the photographer edits
// today's price list. Nothing in this module ever touches `packages`.
//
// No side effects, no I/O — this takes plain numbers in and returns plain
// numbers out, so it is unit-testable without a database and safe to call
// from both a Server Component (initial paint) and a Route Handler (after a
// toggle), which is exactly how it's used.
export type GalleryQuotaSnapshot = {
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
};

export type QuotaResult = {
  /** `count(assets where is_selected)` — DERIVED by the caller, never stored;
   * this function only ever receives the already-counted number. */
  selected: number;
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  /** `max(0, selected - includedPhotosSnapshot)` — going over the quota is
   * upsell, never an error, so this is clamped at 0 rather than allowed to
   * go negative when `selected` is under the included count. */
  extras: number;
  /** `extras * extraPhotoPriceCopSnapshot` — DISPLAYED to the client, never
   * charged: this app has no payment gateway (PLAN.md §3). */
  surchargeCop: number;
};

/** The quota maths, exactly (PLAN.md §3 / task #24): `selected`, `extras`,
 * `surchargeCop`. */
export function computeQuota(selected: number, snapshot: GalleryQuotaSnapshot): QuotaResult {
  const extras = Math.max(0, selected - snapshot.includedPhotosSnapshot);
  const surchargeCop = extras * snapshot.extraPhotoPriceCopSnapshot;

  return {
    selected,
    includedPhotosSnapshot: snapshot.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: snapshot.extraPhotoPriceCopSnapshot,
    extras,
    surchargeCop,
  };
}
