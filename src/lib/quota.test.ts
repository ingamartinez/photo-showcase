import { describe, expect, it } from "vitest";
import { computeQuota } from "./quota";

// Estándar package terms (PLAN.md §3), used across every case below so the
// only thing that varies per test is `selected`.
const SNAPSHOT = { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 };

describe("computeQuota", () => {
  it("zero selected: no extras, no surcharge", () => {
    expect(computeQuota(0, SNAPSHOT)).toEqual({
      selected: 0,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      extras: 0,
      surchargeCop: 0,
    });
  });

  it("exactly the included count: still no extras, no surcharge", () => {
    expect(computeQuota(13, SNAPSHOT)).toEqual({
      selected: 13,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      extras: 0,
      surchargeCop: 0,
    });
  });

  it("one over the included count: exactly one extra, one extra's worth of surcharge", () => {
    expect(computeQuota(14, SNAPSHOT)).toEqual({
      selected: 14,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      extras: 1,
      surchargeCop: 5_000,
    });
  });

  it("far over the included count: extras and surcharge scale linearly, never blocked", () => {
    expect(computeQuota(30, SNAPSHOT)).toEqual({
      selected: 30,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      extras: 17,
      surchargeCop: 85_000,
    });
  });

  // Defensive: `selected` should never be lower than 0 selected assets in
  // practice, but extras must never go negative even if it somehow were —
  // "going over the quota is upsell", not "going under produces a credit".
  it("never reports negative extras when selected is under the included count", () => {
    const result = computeQuota(-1, SNAPSHOT);
    expect(result.extras).toBe(0);
    expect(result.surchargeCop).toBe(0);
  });
});
