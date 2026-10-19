import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRA_PRICE_TIERS, validateExtraPriceTiers } from "@/lib/extra-price-tiers";
import { computeQuota, type GalleryQuotaSnapshot } from "@/lib/quota";
import {
  attributeQuota,
  compareArrival,
  shareFor,
  type AttributionShare,
  type ClaimedUnit,
  type QuotaAttribution,
} from "@/lib/quota-attribution";
import type { SelectionKind } from "@/lib/selection-snapshot";

const FLAT: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 2,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

const TIERED: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 0,
  extraPhotoPriceCopSnapshot: 15_000,
  extraPhotoPriceTiersSnapshot: [...DEFAULT_EXTRA_PRICE_TIERS],
  originalPhotoPriceCopSnapshot: 2_000,
};

const t = (n: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, n));

const unit = (
  assetId: string,
  billedTo: string | null,
  kind: SelectionKind,
  billedAt: Date | null,
): ClaimedUnit => ({ assetId, billedTo, kind, billedAt });

const edited = (assetId: string, billedTo: string | null, billedAt: Date | null) =>
  unit(assetId, billedTo, "edited", billedAt);
const original = (assetId: string, billedTo: string | null, billedAt: Date | null) =>
  unit(assetId, billedTo, "original", billedAt);

/** The Σ invariant, in one place. `toBe` is exact integer equality, no
 * tolerance: the whole point of volume pricing in integer COP is that there
 * is no remainder to distribute. */
function expectSigma(att: QuotaAttribution) {
  const totals = {
    included: att.people.reduce((s, p) => s + p.included, 0) + att.unattributed.included,
    extras: att.people.reduce((s, p) => s + p.extras, 0) + att.unattributed.extras,
    originals: att.people.reduce((s, p) => s + p.originals, 0) + att.unattributed.originals,
    extrasSurchargeCop:
      att.people.reduce((s, p) => s + p.extrasSurchargeCop, 0) +
      att.unattributed.extrasSurchargeCop,
    originalsSurchargeCop:
      att.people.reduce((s, p) => s + p.originalsSurchargeCop, 0) +
      att.unattributed.originalsSurchargeCop,
    surchargeCop:
      att.people.reduce((s, p) => s + p.surchargeCop, 0) + att.unattributed.surchargeCop,
  };
  expect(totals.included).toBe(att.quota.selectedEdited - att.quota.extras);
  expect(totals.extras).toBe(att.quota.extras);
  expect(totals.originals).toBe(att.quota.originals);
  expect(totals.extrasSurchargeCop).toBe(att.quota.extrasSurchargeCop);
  expect(totals.originalsSurchargeCop).toBe(att.quota.originalsSurchargeCop);
  expect(totals.surchargeCop).toBe(att.quota.surchargeCop);
  expect(att.units.reduce((s, u) => s + u.priceCop, 0)).toBe(att.quota.surchargeCop);
  const editedCount = att.units.filter((u) => u.kind === "edited").length;
  const originalCount = att.units.length - editedCount;
  expect(att.quota).toEqual(
    computeQuota(editedCount, originalCount, {
      includedPhotosSnapshot: att.quota.includedPhotosSnapshot,
      extraPhotoPriceCopSnapshot: att.quota.extraPhotoPriceCopSnapshot,
      extraPhotoPriceTiersSnapshot: att.quota.extraPhotoPriceTiersSnapshot,
      originalPhotoPriceCopSnapshot: att.quota.originalPhotoPriceCopSnapshot,
    }),
  );
}

const shareKeys = (share: AttributionShare) => ({
  included: share.included,
  extras: share.extras,
  originals: share.originals,
  extrasSurchargeCop: share.extrasSurchargeCop,
  originalsSurchargeCop: share.originalsSurchargeCop,
  surchargeCop: share.surchargeCop,
});

// Arrival order: l1 (null), a1 (t1), a3 (t2), b1 (t2), a2 (t3), b2 (t4).
const MIXED: ClaimedUnit[] = [
  edited("l1", null, null),
  edited("a1", "A", t(1)),
  original("a3", "A", t(2)),
  edited("b1", "B", t(2)),
  edited("a2", "A", t(3)),
  original("b2", "B", t(4)),
];

describe("attributeQuota — Σ invariant with hand-computed shares", () => {
  it("flat snapshot: A=7000, B=7000, unattributed=1000, gallery total 14000", () => {
    const att = attributeQuota(MIXED, FLAT);
    expect(att.quota.extras).toBe(2);
    expect(att.quota.extraUnitPriceCop).toBe(5_000);
    expect(att.quota.surchargeCop).toBe(14_000);
    expect(shareKeys(shareFor(att, "A"))).toEqual({
      included: 1,
      extras: 1,
      originals: 1,
      extrasSurchargeCop: 5_000,
      originalsSurchargeCop: 2_000,
      surchargeCop: 7_000,
    });
    expect(shareKeys(shareFor(att, "B"))).toEqual({
      included: 0,
      extras: 1,
      originals: 1,
      extrasSurchargeCop: 5_000,
      originalsSurchargeCop: 2_000,
      surchargeCop: 7_000,
    });
    expect(shareKeys(att.unattributed)).toEqual({
      included: 1,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
    });
    expectSigma(att);
  });

  it("tiered snapshot: A=28000, B=15000, unattributed=13000, gallery total 56000", () => {
    const att = attributeQuota(MIXED, TIERED);
    expect(att.quota.extras).toBe(4);
    expect(att.quota.extraUnitPriceCop).toBe(13_000);
    expect(att.quota.surchargeCop).toBe(56_000);
    expect(shareKeys(shareFor(att, "A"))).toEqual({
      included: 0,
      extras: 2,
      originals: 1,
      extrasSurchargeCop: 26_000,
      originalsSurchargeCop: 2_000,
      surchargeCop: 28_000,
    });
    expect(shareKeys(shareFor(att, "B"))).toEqual({
      included: 0,
      extras: 1,
      originals: 1,
      extrasSurchargeCop: 13_000,
      originalsSurchargeCop: 2_000,
      surchargeCop: 15_000,
    });
    expect(shareKeys(att.unattributed)).toEqual({
      included: 0,
      extras: 1,
      originals: 0,
      extrasSurchargeCop: 13_000,
      originalsSurchargeCop: 0,
      surchargeCop: 13_000,
    });
    expectSigma(att);
  });

  it("quota is exactly computeQuota for flat, tiered, and empty", () => {
    expect(attributeQuota(MIXED, FLAT).quota).toEqual(computeQuota(4, 2, FLAT));
    expect(attributeQuota(MIXED, TIERED).quota).toEqual(computeQuota(4, 2, TIERED));
    const empty = attributeQuota([], FLAT);
    expect(empty.quota).toEqual(computeQuota(0, 0, FLAT));
    expect(empty.people).toEqual([]);
    expect(shareKeys(empty.unattributed)).toEqual({
      included: 0,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
    });
  });
});

describe("compareArrival / determinism", () => {
  it("breaks a same-billedAt tie by asset id, code-unit order", () => {
    const a0 = { billedAt: t(2), assetId: "a0" };
    const z9 = { billedAt: t(2), assetId: "z9" };
    expect(compareArrival(a0, z9)).toBe(-1);
    expect(compareArrival(z9, a0)).toBe(1);
    expect(compareArrival(a0, a0)).toBe(0);

    const att = attributeQuota([edited("z9", "Q", t(2)), edited("a0", "P", t(2))], {
      ...FLAT,
      includedPhotosSnapshot: 1,
    });
    expect(shareFor(att, "P").included).toBe(1);
    expect(shareFor(att, "Q").included).toBe(0);
  });

  it("is independent of input order: all 24 permutations agree", () => {
    const fixture: ClaimedUnit[] = [
      edited("e1", "P", t(1)),
      edited("e2", "Q", t(2)),
      original("o1", "P", t(3)),
      edited("e3", "Q", null),
    ];
    const perms: ClaimedUnit[][] = [];
    const permute = (rest: ClaimedUnit[], acc: ClaimedUnit[]) => {
      if (rest.length === 0) {
        perms.push(acc);
        return;
      }
      rest.forEach((item, i) =>
        permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, item]),
      );
    };
    permute(fixture, []);
    expect(perms).toHaveLength(24);
    const expected = attributeQuota(perms[0]!, FLAT);
    expectSigma(expected);
    for (const perm of perms) {
      expect(attributeQuota(perm, FLAT)).toEqual(expected);
    }
  });

  it("puts billedAt null first, so a legacy unit keeps its included slot", () => {
    const att = attributeQuota([edited("new", "A", t(0)), edited("old", "B", null)], {
      ...FLAT,
      includedPhotosSnapshot: 1,
    });
    expect(shareFor(att, "B").included).toBe(1);
    expect(shareFor(att, "A").included).toBe(0);
  });
});

describe("shareFor", () => {
  it("returns all zeros for an unknown user", () => {
    const att = attributeQuota(MIXED, FLAT);
    expect(shareFor(att, "nobody")).toEqual({
      included: 0,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
    });
  });

  it("returns the unattributed bucket for null", () => {
    const att = attributeQuota(MIXED, FLAT);
    expect(shareFor(att, null)).toBe(att.unattributed);
  });

  it("sorts people by userId and lists no zero entries", () => {
    const att = attributeQuota(MIXED, FLAT);
    expect(att.people.map((p) => p.userId)).toEqual(["A", "B"]);
    for (const person of att.people) {
      expect(person.included + person.extras + person.originals).toBeGreaterThan(0);
    }
  });
});

describe("attributeQuota — guards", () => {
  it("throws on a duplicate assetId", () => {
    expect(() => attributeQuota([edited("x", "A", t(1)), edited("x", "B", t(2))], FLAT)).toThrow(
      /duplicate unit for asset x/,
    );
  });

  it("D12 negative control: an increasing unit price lets B raise A's surcharge", () => {
    const scale = [
      { minExtras: 1, priceCop: 5_000 },
      { minExtras: 3, priceCop: 8_000 },
    ];
    const snapshot: GalleryQuotaSnapshot = {
      includedPhotosSnapshot: 0,
      extraPhotoPriceCopSnapshot: 5_000,
      extraPhotoPriceTiersSnapshot: scale,
      originalPhotoPriceCopSnapshot: 2_000,
    };
    const aOnly = attributeQuota([edited("a1", "A", t(1)), edited("a2", "A", t(2))], snapshot);
    const withB = attributeQuota(
      [edited("a1", "A", t(1)), edited("a2", "A", t(2)), edited("b1", "B", t(3))],
      snapshot,
    );
    expect(shareFor(aOnly, "A").surchargeCop).toBe(10_000);
    expect(shareFor(withB, "A").surchargeCop).toBe(16_000);
    expect(shareFor(withB, "A").surchargeCop).toBeGreaterThan(shareFor(aOnly, "A").surchargeCop);
    // This scale is exactly what D12 now rejects; without that validator the
    // property test would be false.
    expect(validateExtraPriceTiers(scale).ok).toBe(false);
  });
});

describe("quota-attribution purity", () => {
  it("imports exactly computeQuota and SelectionKind — nothing that does I/O", () => {
    const source = readFileSync(new URL("./quota-attribution.ts", import.meta.url), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b|\bimport\s*\(|\brequire\s*\(/.test(line));
    expect(importLines).toEqual([
      'import { computeQuota, type GalleryQuotaSnapshot, type QuotaResult } from "@/lib/quota";',
      'import type { SelectionKind } from "@/lib/selection-snapshot";',
    ]);
  });
});
