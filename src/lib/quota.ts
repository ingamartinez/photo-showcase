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
export type GalleryQuotaSnapshot = {
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
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
  /** `extras * extraPhotoPriceCopSnapshot + originals * originalPhotoPriceCopSnapshot`
   * — DISPLAYED to the client, never charged: this app has no payment
   * gateway (PLAN.md §3). With zero originals this is byte-identical to the
   * pre-#205 formula (`extras * extraPhotoPriceCopSnapshot`) — see
   * quota.test.ts's own "zero originals" cases, which pin exactly that. */
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
  const surchargeCop =
    extras * snapshot.extraPhotoPriceCopSnapshot +
    originals * snapshot.originalPhotoPriceCopSnapshot;

  return {
    selected: selectedEdited + selectedOriginal,
    selectedEdited,
    selectedOriginal,
    includedPhotosSnapshot: snapshot.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: snapshot.extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot: snapshot.originalPhotoPriceCopSnapshot,
    extras,
    originals,
    surchargeCop,
  };
}
