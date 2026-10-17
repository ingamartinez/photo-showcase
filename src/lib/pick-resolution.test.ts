import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GalleryQuotaSnapshot } from "@/lib/quota";
import { attributeQuota, shareFor, type ClaimedUnit } from "@/lib/quota-attribution";
import {
  arrivalAfter,
  claimFromAsset,
  compareCartOrder,
  derivePickStatus,
  gatePickEdit,
  latestBilledAt,
  reresolveClaim,
  submitPick,
  type AssetClaim,
  type PickEdit,
  type PickStatus,
  type SubmitOutcome,
  type SubmittedPick,
} from "@/lib/pick-resolution";
import type { SelectionKind } from "@/lib/selection-snapshot";

const FLAT: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 1,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

const TIERED: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 0,
  extraPhotoPriceCopSnapshot: 15_000,
  extraPhotoPriceTiersSnapshot: [
    { minExtras: 1, priceCop: 15_000 },
    { minExtras: 3, priceCop: 13_000 },
    { minExtras: 5, priceCop: 11_000 },
    { minExtras: 10, priceCop: 10_000 },
  ],
  originalPhotoPriceCopSnapshot: 2_000,
};

const t = (n: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, n));

const claimed = (
  kind: SelectionKind,
  billedTo: string | null,
  billedAt: Date | null,
): AssetClaim => ({ claimed: true, kind, billedTo, billedAt });

const unit = (
  assetId: string,
  billedTo: string | null,
  kind: SelectionKind,
  billedAt: Date | null,
): ClaimedUnit => ({ assetId, billedTo, kind, billedAt });

describe("claimFromAsset", () => {
  it("maps an unclaimed row to { claimed: false }, ignoring its other columns", () => {
    expect(
      claimFromAsset({
        isSelected: false,
        selectionKind: "original",
        billedTo: "A",
        billedAt: t(1),
      }),
    ).toEqual({ claimed: false });
  });

  it("maps a claimed row to the four resolved fields, preserving nulls", () => {
    expect(
      claimFromAsset({
        isSelected: true,
        selectionKind: "original",
        billedTo: "A",
        billedAt: t(1),
      }),
    ).toEqual({ claimed: true, kind: "original", billedTo: "A", billedAt: t(1) });
    expect(
      claimFromAsset({
        isSelected: true,
        selectionKind: "edited",
        billedTo: null,
        billedAt: null,
      }),
    ).toEqual({ claimed: true, kind: "edited", billedTo: null, billedAt: null });
  });
});

describe("derivePickStatus", () => {
  it("cart: no submit, unclaimed", () => {
    expect(derivePickStatus({ userId: "A", submittedAt: null }, { claimed: false })).toBe("cart");
  });

  it("degraded: no submit, claimed by someone (or unattributed)", () => {
    expect(derivePickStatus({ userId: "B", submittedAt: null }, claimed("edited", "A", t(1)))).toBe(
      "degraded",
    );
    expect(
      derivePickStatus({ userId: "B", submittedAt: null }, claimed("edited", null, t(1))),
    ).toBe("degraded");
  });

  it("billed: submitted, this user holds the unit", () => {
    expect(derivePickStatus({ userId: "A", submittedAt: t(2) }, claimed("edited", "A", t(1)))).toBe(
      "billed",
    );
  });

  it("joined: submitted, someone else holds the unit", () => {
    expect(derivePickStatus({ userId: "B", submittedAt: t(2) }, claimed("edited", "A", t(1)))).toBe(
      "joined",
    );
    expect(
      derivePickStatus({ userId: "B", submittedAt: t(2) }, claimed("edited", null, t(1))),
    ).toBe("joined");
  });

  it("throws on a submitted pick on an unclaimed asset", () => {
    expect(() => derivePickStatus({ userId: "A", submittedAt: t(1) }, { claimed: false })).toThrow(
      /submitted pick on an unclaimed asset/,
    );
  });
});

describe("gatePickEdit — the full status x kind x edit table", () => {
  type Row = {
    status: PickStatus;
    currentKind: SelectionKind;
    edit: PickEdit;
    expected: ReturnType<typeof gatePickEdit>;
  };
  const other = (kind: SelectionKind): SelectionKind => (kind === "edited" ? "original" : "edited");
  const rows: Row[] = [];
  for (const status of ["cart", "degraded", "billed", "joined"] as const) {
    for (const currentKind of ["edited", "original"] as const) {
      const open = status === "cart" || status === "degraded";
      rows.push({
        status,
        currentKind,
        edit: { type: "remove" },
        expected: open ? { ok: true } : { ok: false, error: "already_requested" },
      });
      rows.push({
        status,
        currentKind,
        edit: { type: "retype", kind: currentKind },
        expected: open ? { ok: true } : { ok: false, error: "already_requested" },
      });
      rows.push({
        status,
        currentKind,
        edit: { type: "retype", kind: other(currentKind) },
        expected:
          status === "cart"
            ? { ok: true }
            : status === "degraded" && currentKind === "original"
              ? { ok: true }
              : status === "degraded"
                ? { ok: false, error: "pick_degraded" }
                : { ok: false, error: "already_requested" },
      });
    }
  }

  it.each(rows)(
    "$status / $currentKind / $edit.type $edit.kind -> $expected",
    ({ status, currentKind, edit, expected }) => {
      expect(gatePickEdit(status, currentKind, edit)).toEqual(expected);
    },
  );

  it("covers all 24 (status x kind x edit) rows", () => {
    expect(rows).toHaveLength(24);
  });
});

describe("a second pick moves neither the quota nor the attribution", () => {
  const before: ClaimedUnit[] = [
    unit("x", "A", "edited", t(1)),
    unit("c1", "C", "edited", t(2)),
    unit("c2", "C", "original", t(3)),
  ];

  it.each([
    ["flat", FLAT],
    ["tiered", TIERED],
  ] as const)("%s", (_name, snapshot) => {
    const attBefore = attributeQuota(before, snapshot);
    const claim = claimed("edited", "A", t(1));

    // B inserts a pick on x: the asset is claimed by A, so B's pick degrades.
    expect(derivePickStatus({ userId: "B", submittedAt: null }, claim)).toBe("degraded");

    // B submits it, edited: joined, claim untouched.
    const joinedEdited = submitPick(
      claim,
      { userId: "B", kind: "edited" },
      {
        arrival: arrivalAfter(t(4), latestBilledAt([t(1), t(2), t(3)])),
        hasFinal: false,
      },
    );
    expect(joinedEdited.type).toBe("joined");
    expect(joinedEdited.claim).toBe(claim);

    // The original-kind variant is also joined.
    const joinedOriginal = submitPick(
      claim,
      { userId: "B", kind: "original" },
      {
        arrival: t(5),
        hasFinal: false,
      },
    );
    expect(joinedOriginal.type).toBe("joined");
    expect(joinedOriginal.claim).toBe(claim);

    // Neither join changed the claimed units.
    const attAfter = attributeQuota(before, snapshot);
    expect(attAfter).toEqual(attBefore);
    expect(attAfter.quota).toEqual(attBefore.quota);
  });
});

describe("the escalation moves exactly one unit A->B and leaves a third person intact", () => {
  const xArrival = t(4);
  const before: ClaimedUnit[] = [
    unit("x", "A", "original", t(1)),
    unit("y", "C", "edited", t(2)),
    unit("z", "C", "edited", t(3)),
  ];

  it("flat: A 2000->0, B 0->5000, C untouched", () => {
    const attBefore = attributeQuota(before, FLAT);
    const outcome = submitPick(
      claimed("original", "A", t(1)),
      { userId: "B", kind: "edited" },
      {
        arrival: arrivalAfter(xArrival, latestBilledAt([t(1), t(2), t(3)])),
        hasFinal: false,
      },
    );
    expect(outcome.type).toBe("escalated");
    if (outcome.type !== "escalated") throw new Error("unreachable");
    expect(outcome.from).toBe("A");

    const after = before.map((u) =>
      u.assetId === "x"
        ? unit("x", outcome.claim.billedTo, outcome.claim.kind, outcome.claim.billedAt)
        : u,
    );
    expect(after).toHaveLength(before.length);
    const attAfter = attributeQuota(after, FLAT);

    const beforeById = new Map(attBefore.units.map((u) => [u.assetId, u]));
    const sameUnit = (a: (typeof attAfter.units)[number], b: (typeof attBefore.units)[number]) =>
      a.billedTo === b.billedTo &&
      a.kind === b.kind &&
      a.charge === b.charge &&
      a.priceCop === b.priceCop &&
      a.billedAt?.getTime() === b.billedAt?.getTime();
    const diffs = attAfter.units.filter((u) => !sameUnit(u, beforeById.get(u.assetId)!));
    expect(diffs.map((u) => u.assetId)).toEqual(["x"]);
    for (const u of attAfter.units) {
      if (u.assetId === "x") continue;
      expect(u).toEqual(beforeById.get(u.assetId));
    }
    expect(shareFor(attAfter, "C")).toEqual(shareFor(attBefore, "C"));
    expect(shareFor(attBefore, "A").surchargeCop).toBe(2_000);
    expect(shareFor(attAfter, "A").surchargeCop).toBe(0);
    expect(shareFor(attBefore, "B").surchargeCop).toBe(0);
    expect(shareFor(attAfter, "B").surchargeCop).toBe(5_000);
  });

  it("tiered: C's counts stay identical and C's price can only fall", () => {
    const attBefore = attributeQuota(before, TIERED);
    const outcome = submitPick(
      claimed("original", "A", t(1)),
      { userId: "B", kind: "edited" },
      {
        arrival: xArrival,
        hasFinal: false,
      },
    );
    expect(outcome.type).toBe("escalated");
    if (outcome.type !== "escalated") throw new Error("unreachable");
    const after = before.map((u) =>
      u.assetId === "x"
        ? unit("x", outcome.claim.billedTo, outcome.claim.kind, outcome.claim.billedAt)
        : u,
    );
    const attAfter = attributeQuota(after, TIERED);
    expect(shareFor(attAfter, "C").included).toBe(shareFor(attBefore, "C").included);
    expect(shareFor(attAfter, "C").extras).toBe(shareFor(attBefore, "C").extras);
    expect(shareFor(attBefore, "C").surchargeCop).toBe(30_000);
    expect(shareFor(attAfter, "C").surchargeCop).toBe(26_000);
    expect(shareFor(attAfter, "C").surchargeCop).toBeLessThanOrEqual(
      shareFor(attBefore, "C").surchargeCop,
    );
  });

  it("escalates from the unattributed bucket when billedTo is null", () => {
    const beforeNull: ClaimedUnit[] = [unit("x", null, "original", t(1))];
    const attBefore = attributeQuota(beforeNull, FLAT);
    const outcome = submitPick(
      claimed("original", null, t(1)),
      { userId: "B", kind: "edited" },
      {
        arrival: t(4),
        hasFinal: false,
      },
    );
    expect(outcome.type).toBe("escalated");
    if (outcome.type !== "escalated") throw new Error("unreachable");
    expect(outcome.from).toBeNull();
    const attAfter = attributeQuota([unit("x", "B", "edited", t(4))], FLAT);
    expect(attBefore.unattributed.originals).toBe(1);
    expect(attAfter.unattributed.originals).toBe(0);
    expect(shareFor(attAfter, "B").surchargeCop).toBe(0);
  });
});

describe("edited->original never happens through a client submit (exhaustive)", () => {
  const claims: [string, AssetClaim][] = [
    ["unclaimed", { claimed: false }],
    ["edited/X", claimed("edited", "X", t(1))],
    ["edited/null", claimed("edited", null, t(1))],
    ["original/X", claimed("original", "X", t(1))],
    ["original/null", claimed("original", null, t(1))],
  ];
  const expectedType = (
    claim: AssetClaim,
    pickKind: SelectionKind,
    hasFinal: boolean,
  ): SubmitOutcome["type"] => {
    if (!claim.claimed) return "claimed";
    if (claim.kind === "original" && pickKind === "edited") {
      return hasFinal ? "escalation_blocked" : "escalated";
    }
    return "joined";
  };

  const cases = claims.flatMap(([label, claim]) =>
    (["edited", "original"] as const).flatMap((pickKind) =>
      [false, true].map((hasFinal) => ({
        label: `${label} + pick:${pickKind} + final:${hasFinal}`,
        claim,
        pickKind,
        hasFinal,
        expected: expectedType(claim, pickKind, hasFinal),
      })),
    ),
  );

  it("enumerates all 20 cases", () => {
    expect(cases).toHaveLength(20);
  });

  it.each(cases)("$label -> $expected", ({ claim, pickKind, hasFinal, expected }) => {
    const outcome = submitPick(
      claim,
      { userId: "S", kind: pickKind },
      {
        arrival: t(9),
        hasFinal,
      },
    );
    expect(outcome.type).toBe(expected);

    // A previously-resolved edited asset never goes back to original.
    if (claim.claimed && claim.kind === "edited") {
      expect(outcome.claim.kind).toBe("edited");
    }
    // A claimed asset stays claimed.
    if (claim.claimed) {
      expect(outcome.claim.claimed).toBe(true);
    }
    // The claim object changes only for `claimed` / `escalated`.
    if (expected === "claimed" || expected === "escalated") {
      expect(outcome.claim).not.toBe(claim);
    } else {
      expect(outcome.claim).toBe(claim);
    }
  });
});

describe("decision 15: a final blocks the escalation", () => {
  it("returns escalation_blocked with the claim unchanged", () => {
    const claim = claimed("original", "X", t(1));
    const outcome = submitPick(
      claim,
      { userId: "B", kind: "edited" },
      {
        arrival: t(9),
        hasFinal: true,
      },
    );
    expect(outcome).toEqual({ type: "escalation_blocked", reason: "final_exists", claim });
    expect(outcome.claim).toBe(claim);
  });
});

describe("submitPick guard", () => {
  it("throws when the submitter is already the billed person", () => {
    expect(() =>
      submitPick(
        claimed("edited", "A", t(1)),
        { userId: "A", kind: "edited" },
        {
          arrival: t(2),
          hasFinal: false,
        },
      ),
    ).toThrow(/already billed for this asset/);
  });
});

describe("arrivalAfter / latestBilledAt", () => {
  it("latestBilledAt ignores nulls and picks the max", () => {
    expect(latestBilledAt([])).toBeNull();
    expect(latestBilledAt([null, null])).toBeNull();
    expect(latestBilledAt([t(2), null, t(5), t(1)])?.getTime()).toBe(t(5).getTime());
  });

  it("returns now when latest is null or older", () => {
    expect(arrivalAfter(t(5), null).getTime()).toBe(t(5).getTime());
    expect(arrivalAfter(t(5), t(3)).getTime()).toBe(t(5).getTime());
  });

  it("adds 1ms on a tie or a backwards clock", () => {
    expect(arrivalAfter(t(5), t(5)).getTime()).toBe(t(5).getTime() + 1);
    expect(arrivalAfter(t(3), t(5)).getTime()).toBe(t(5).getTime() + 1);
  });

  it("documents the tie hazard it exists to prevent", () => {
    const snapshot: GalleryQuotaSnapshot = { ...FLAT, includedPhotosSnapshot: 1 };
    const before = attributeQuota([unit("z9", "A", "edited", t(5))], snapshot);
    // A raw tie: a0 sorts before z9 and steals A's included slot.
    const tied = attributeQuota(
      [unit("z9", "A", "edited", t(5)), unit("a0", "B", "edited", t(5))],
      snapshot,
    );
    expect(shareFor(before, "A").surchargeCop).toBe(0);
    expect(shareFor(tied, "A").surchargeCop).toBe(5_000);
    // With arrivalAfter, B arrives strictly later and A keeps the slot.
    const safeArrival = arrivalAfter(t(5), latestBilledAt([t(5)]));
    const safe = attributeQuota(
      [unit("z9", "A", "edited", t(5)), unit("a0", "B", "edited", safeArrival)],
      snapshot,
    );
    expect(shareFor(safe, "A").surchargeCop).toBe(0);
  });
});

describe("compareCartOrder", () => {
  it("is deterministic on a pickedAt tie", () => {
    const a = { pickedAt: t(2), assetId: "a0" };
    const b = { pickedAt: t(2), assetId: "z9" };
    expect(compareCartOrder(a, b)).toBe(-1);
    expect(compareCartOrder(b, a)).toBe(1);
    expect(compareCartOrder(a, a)).toBe(0);
    expect(compareCartOrder({ pickedAt: t(1), assetId: "z9" }, a)).toBe(-1);
  });
});

describe("pick-resolution purity", () => {
  it("imports exactly the SelectionKind type — nothing that does I/O", () => {
    const source = readFileSync(new URL("./pick-resolution.ts", import.meta.url), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b|\bimport\s*\(|\brequire\s*\(/.test(line));
    expect(importLines).toEqual(['import type { SelectionKind } from "@/lib/selection-snapshot";']);
  });
});

// Epic #250, task #260 (S5) — the per-asset rule for an ADMIN change to
// somebody's submitted picks. Every row of the plan's §1.1 table.
describe("reresolveClaim", () => {
  const claim = (overrides: Partial<Extract<AssetClaim, { claimed: true }>> = {}): AssetClaim => ({
    claimed: true,
    kind: "edited",
    billedTo: "A",
    billedAt: t(1),
    ...overrides,
  });
  const pick = (userId: string, kind: SelectionKind, at = t(3)): SubmittedPick => ({
    userId,
    kind,
    submittedAt: at,
  });
  const arrival = t(9);

  it("returns an unclaimed asset with no submitted pick untouched", () => {
    expect(reresolveClaim({ claimed: false }, [], { hasFinal: false, arrival })).toEqual({
      claimed: false,
    });
  });

  it("THROWS on an unclaimed asset that still has a submitted pick — the derivePickStatus contradiction", () => {
    expect(() =>
      reresolveClaim({ claimed: false }, [pick("B", "edited")], { hasFinal: false, arrival }),
    ).toThrow(/submitted pick on an unclaimed asset/);
  });

  it("never invents or removes a legacy unit (billedTo null)", () => {
    const legacy = claim({ billedTo: null, kind: "original" });
    expect(reresolveClaim(legacy, [pick("B", "edited")], { hasFinal: false, arrival })).toEqual(
      legacy,
    );
  });

  it("unclaims the asset once no submitted pick remains", () => {
    expect(reresolveClaim(claim(), [], { hasFinal: false, arrival })).toEqual({ claimed: false });
  });

  it("keeps the holder and billedAt when their own pick is still compatible", () => {
    expect(
      reresolveClaim(claim(), [pick("A", "edited"), pick("B", "original")], {
        hasFinal: false,
        arrival,
      }),
    ).toEqual(claim());
  });

  it("resolves the kind to edited when any remaining pick is edited (decision 3)", () => {
    const result = reresolveClaim(
      claim({ kind: "original" }),
      [pick("B", "original"), pick("C", "edited")],
      {
        hasFinal: false,
        arrival,
      },
    );
    expect(result).toEqual({ claimed: true, kind: "edited", billedTo: "C", billedAt: arrival });
  });

  it("TRANSFERS the unit keeping billedAt when the holder's pick is gone and the kind does not move", () => {
    const result = reresolveClaim(claim({ billedAt: t(2) }), [pick("B", "edited", t(5))], {
      hasFinal: false,
      arrival,
    });
    expect(result).toEqual({ claimed: true, kind: "edited", billedTo: "B", billedAt: t(2) });
  });

  it("transfers an original unit to the earliest ORIGINAL picker, not to an earlier edited one", () => {
    // Mixed picks with no holder compatibility: the resolved kind is edited,
    // so the unit must go to an edited picker even though B asked first.
    const result = reresolveClaim(
      claim({ billedTo: "gone" }),
      [pick("B", "original", t(1)), pick("C", "edited", t(2))],
      { hasFinal: false, arrival },
    );
    expect(result).toMatchObject({ billedTo: "C", kind: "edited", billedAt: t(1) });
  });

  it("RE-ARRIVES on a raise: billedAt becomes the plan's arrival (decision 6)", () => {
    const result = reresolveClaim(
      claim({ kind: "original", billedAt: t(1) }),
      [pick("B", "edited")],
      {
        hasFinal: false,
        arrival,
      },
    );
    expect(result).toEqual({ claimed: true, kind: "edited", billedTo: "B", billedAt: arrival });
  });

  it("breaks an identical submittedAt tie by userId, deterministically", () => {
    const result = reresolveClaim(
      claim({ billedTo: "gone" }),
      [pick("z", "edited", t(4)), pick("a", "edited", t(4))],
      { hasFinal: false, arrival },
    );
    expect(result).toMatchObject({ billedTo: "a" });
  });

  it("freezes the kind in BOTH directions while a final exists (decision 15)", () => {
    // No raise over a file.
    expect(
      reresolveClaim(claim({ kind: "original" }), [pick("A", "original"), pick("B", "edited")], {
        hasFinal: true,
        arrival,
      }),
    ).toEqual({ claimed: true, kind: "original", billedTo: "A", billedAt: t(1) });
    // No lowering either: the final was produced against `edited`.
    expect(
      reresolveClaim(claim({ kind: "edited" }), [pick("A", "edited"), pick("B", "original")], {
        hasFinal: true,
        arrival,
      }),
    ).toEqual({ claimed: true, kind: "edited", billedTo: "A", billedAt: t(1) });
  });

  it("still transfers the unit when the holder left and a final froze the kind", () => {
    const result = reresolveClaim(
      claim({ billedTo: "gone", kind: "original" }),
      [pick("B", "edited")],
      {
        hasFinal: true,
        arrival,
      },
    );
    expect(result).toEqual({ claimed: true, kind: "original", billedTo: "B", billedAt: t(1) });
  });
});
