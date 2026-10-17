import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTRA_PRICE_TIERS,
  tierRangeLabel,
  validateExtraPriceTiers,
} from "./extra-price-tiers";

const tiers = (...pairs: [number, number][]) =>
  pairs.map(([minExtras, priceCop]) => ({ minExtras, priceCop }));

describe("validateExtraPriceTiers", () => {
  it("accepts the owner's default scale", () => {
    const result = validateExtraPriceTiers(DEFAULT_EXTRA_PRICE_TIERS);
    expect(result).toEqual({ ok: true, tiers: [...DEFAULT_EXTRA_PRICE_TIERS] });
  });

  it("accepts 15/13/11/10", () => {
    expect(
      validateExtraPriceTiers(tiers([1, 15_000], [3, 13_000], [5, 11_000], [10, 10_000])).ok,
    ).toBe(true);
  });

  // The owner's real case: with 9.000 at 10+, 9 extras cost 99.000 but 10
  // cost 90.000 — one more photo made the total LOWER.
  it("REJECTS 15/13/11/9: 10 extras (90.000) would cost less than 9 (99.000)", () => {
    const result = validateExtraPriceTiers(
      tiers([1, 15_000], [3, 13_000], [5, 11_000], [10, 9_000]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Agregar una foto no puede bajar el total");
      expect(result.message).toContain("10");
    }
  });

  it("accepts the exact boundary where the total stays equal (not lower)", () => {
    // 10 x 9.900 = 99.000 = 9 x 11.000
    expect(
      validateExtraPriceTiers(tiers([1, 15_000], [3, 13_000], [5, 11_000], [10, 9_900])).ok,
    ).toBe(true);
    // one peso less is rejected: 10 x 9.899 = 98.990 < 99.000
    expect(
      validateExtraPriceTiers(tiers([1, 15_000], [3, 13_000], [5, 11_000], [10, 9_899])).ok,
    ).toBe(false);
  });

  it("rejects an inversion in a middle tier, not only the last one", () => {
    // 3 x 8.000 = 24.000 < 2 x 15.000 = 30.000
    expect(validateExtraPriceTiers(tiers([1, 15_000], [3, 8_000])).ok).toBe(false);
  });

  // Epic #250 D12: a HIGHER unit at a HIGHER count lets a later claim raise
  // another client's price. The old monotonic-total rule accepted both of
  // these; the unit price must be non-increasing.
  it("REJECTS the epic's own 1→5000, 3→8000: unit price rises", () => {
    const result = validateExtraPriceTiers(tiers([1, 5_000], [3, 8_000]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("8000");
      expect(result.message).toContain("5000");
    }
  });

  it("rejects a unit price that rises only in a later tier", () => {
    // 5 x 14.000 = 70.000 >= 4 x 13.000 = 52.000, so the total rule accepts it.
    expect(validateExtraPriceTiers(tiers([1, 15_000], [3, 13_000], [5, 14_000])).ok).toBe(false);
  });

  it("accepts an equal unit price: non-increasing, not strictly decreasing", () => {
    expect(validateExtraPriceTiers(tiers([1, 5_000], [2, 5_000])).ok).toBe(true);
  });

  it("accepts a single flat-looking tier starting at 1", () => {
    expect(validateExtraPriceTiers(tiers([1, 5_000])).ok).toBe(true);
  });

  it.each([
    ["not an array", null],
    ["empty", []],
    ["first tier not at 1", tiers([2, 15_000])],
    ["first tier at 0", tiers([0, 15_000])],
    ["equal minExtras", tiers([1, 15_000], [1, 14_000])],
    ["decreasing minExtras", tiers([1, 15_000], [5, 14_000], [3, 14_000])],
    ["fractional price", tiers([1, 15_000.5])],
    ["fractional minExtras", tiers([1, 15_000], [2.5, 15_000])],
    ["negative price", tiers([1, -1])],
    ["NaN price (an empty cell)", tiers([1, Number.NaN])],
    ["string values", [{ minExtras: "1", priceCop: "15000" }]],
    ["null row", [null]],
  ])("rejects %s", (_name, input) => {
    expect(validateExtraPriceTiers(input).ok).toBe(false);
  });
});

describe("tierRangeLabel", () => {
  it("labels the default scale the way the client sees it", () => {
    const labels = DEFAULT_EXTRA_PRICE_TIERS.map((_, i) =>
      tierRangeLabel(DEFAULT_EXTRA_PRICE_TIERS, i),
    );
    expect(labels).toEqual(["1–2", "3–4", "5–9", "10 o más"]);
  });

  it("collapses a one-photo range to a single number", () => {
    expect(tierRangeLabel(tiers([1, 5_000], [2, 5_000]), 0)).toBe("1");
  });
});
