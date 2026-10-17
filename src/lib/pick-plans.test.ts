// Epic #250, task #260 (S5) — the PURE planners, and the parity that makes
// plan-then-apply trustworthy: for any state the planner accepts, executing it
// through `claimCart` writes exactly what the plan said it would.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assetPicks, assets, type Gallery } from "@/lib/db/schema";
import { createFakeDb } from "@/test-support/fake-db";
import type { DbTransaction } from "@/lib/gallery-client-locks";
import type { GalleryQuotaSnapshot } from "@/lib/quota";
import { claimCart } from "@/lib/pick-claims";
import {
  applyPlanToRows,
  attributionDelta,
  attributionDeltaBetween,
  planCartClaim,
  planOriginalsOff,
  planRemovePicks,
  planReresolve,
  type AssetRow,
  type PickRow,
} from "@/lib/pick-plans";

const G = "11111111-1111-4111-8111-111111111111";
const A = "client-a";
const B = "client-b";
const C = "client-c";

const t = (n: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, n));

const FLAT: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 1,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

/** Deterministic PRNG (mulberry32): the parity test must be reproducible, so a
 * failure names the same seed every time. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function assetRow(id: string, overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id,
    isSelected: false,
    selectionKind: "edited",
    billedTo: null,
    billedAt: null,
    finalKey: null,
    selectedAt: null,
    requestedAt: null,
    ...overrides,
  };
}

function pickRow(assetId: string, userId: string, overrides: Partial<PickRow> = {}): PickRow {
  return {
    assetId,
    userId,
    kind: "edited",
    pickedAt: t(0),
    submittedAt: null,
    ...overrides,
  };
}

function randomState(seed: number) {
  const random = rng(seed);
  const rows: AssetRow[] = [];
  const picks: PickRow[] = [];
  const allowsOriginal = random() < 0.5;

  for (let i = 0; i < 6; i += 1) {
    const id = `asset-${i}`;
    const claimed = random() < 0.55;
    if (!claimed) {
      rows.push(assetRow(id));
      continue;
    }
    const holder = random() < 0.15 ? null : random() < 0.5 ? A : B;
    const kind = random() < 0.5 ? "edited" : "original";
    const billedAt = random() < 0.2 ? null : t(1 + Math.floor(random() * 5));
    rows.push(
      assetRow(id, {
        isSelected: true,
        selectionKind: kind,
        billedTo: holder,
        billedAt,
        selectedAt: billedAt,
        requestedAt: billedAt,
        finalKey: random() < 0.15 ? `final/${id}.jpg` : null,
      }),
    );
    // The holder always has a submitted pick; the resolved kind agrees with
    // the picks unless a final froze it (decision 15).
    if (holder) {
      picks.push(pickRow(id, holder, { kind, submittedAt: t(2) }));
    }
    const other = holder === A ? B : A;
    if (random() < 0.5) {
      picks.push(
        pickRow(id, other, { kind: random() < 0.5 ? "edited" : "original", submittedAt: t(3) }),
      );
    }
  }

  for (let i = 0; i < 6; i += 1) {
    const id = `asset-${i}`;
    for (const user of [A, B]) {
      const already = picks.some((pick) => pick.assetId === id && pick.userId === user);
      if (!already && random() < 0.25) {
        picks.push(
          pickRow(id, user, {
            kind: random() < 0.5 ? "edited" : "original",
            pickedAt: t(Math.floor(random() * 4)),
            submittedAt: null,
          }),
        );
      }
    }
  }

  return { rows, picks, allowsOriginal };
}

describe("planCartClaim — parity with the executed claimCart (preview == write)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("agrees with claimCart on every one of 200 seeded random states", async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const { rows, picks, allowsOriginal } = randomState(seed);
      const cart = picks.filter((pick) => pick.userId === C && pick.submittedAt === null);
      const now = t(7);
      const plan = planCartClaim(rows, cart, C, now, { allowsOriginal });

      const fake = createFakeDb([assets, assetPicks]);
      fake.__tables.get(assets)!.push(...rows.map((row) => ({ ...row })));
      fake.__tables.get(assetPicks)!.push(...picks.map((row) => ({ ...row })));
      const gallery = { id: G, allowsOriginalSelection: allowsOriginal } as Gallery;
      const result = await claimCart(fake as unknown as DbTransaction, gallery, C, now);

      const expected = applyPlanToRows(rows, plan.assetChanges);
      const stored = fake.__tables.get(assets)! as unknown as AssetRow[];
      for (const row of expected) {
        const actual = stored.find((candidate) => candidate.id === row.id)!;
        expect({ seed, ...pickFields(actual) }).toEqual({ seed, ...pickFields(row) });
      }
      expect(result.counts).toEqual(plan.counts);
      expect(result.stamped).toBe(cart.length);
      expect(result.newUnits).toBe(plan.counts.claimed + plan.counts.escalated);

      const storedPicks = fake.__tables.get(assetPicks)! as unknown as PickRow[];
      for (const pick of storedPicks) {
        const planFixed = plan.pickKindFixes.includes(pick.assetId) && pick.userId === C;
        expect({ seed, kind: pick.kind }).toEqual({
          seed,
          kind: planFixed
            ? "edited"
            : picks.find((p) => p.assetId === pick.assetId && p.userId === pick.userId)!.kind,
        });
      }
    }
  });
});

function pickFields(row: AssetRow) {
  return {
    id: row.id,
    isSelected: row.isSelected,
    selectionKind: row.selectionKind,
    billedTo: row.billedTo,
    billedAt: row.billedAt ? row.billedAt.toISOString() : null,
    selectedAt: row.selectedAt ? row.selectedAt.toISOString() : null,
    requestedAt: row.requestedAt ? row.requestedAt.toISOString() : null,
  };
}

describe("planRemovePicks", () => {
  const rows = [assetRow("x", { isSelected: true, billedTo: A, billedAt: t(2) })];
  const picks = [
    pickRow("x", A, { submittedAt: t(2) }),
    pickRow("x", B, { submittedAt: t(3) }),
    pickRow("y", A, { submittedAt: null }),
  ];

  it("deletes every pick of that person and re-resolves only the assets that lost a SUBMITTED one", () => {
    const plan = planRemovePicks(rows, picks, A, t(9));

    expect(plan.deletedPicks.map((pick) => pick.assetId).sort()).toEqual(["x", "y"]);
    expect(plan.assetChanges).toHaveLength(1);
    expect(plan.assetChanges[0]!.after).toMatchObject({ billedTo: B });
  });

  it("unclaims when the removed person was the only submitted picker, clearing nothing itself", () => {
    const plan = planRemovePicks(rows, [pickRow("x", A, { submittedAt: t(2) })], A, t(9));

    expect(plan.assetChanges[0]!.after).toEqual({ claimed: false });
    expect(plan.assetChanges[0]!.op).toBe("unclaim");
  });
});

describe("planOriginalsOff", () => {
  it("rewrites every original pick and escalates claimed originals without a final, holder unchanged", () => {
    const rows = [
      assetRow("x", { isSelected: true, selectionKind: "original", billedTo: A, billedAt: t(1) }),
      assetRow("y", {
        isSelected: true,
        selectionKind: "original",
        billedTo: B,
        billedAt: t(2),
        finalKey: "final/y.jpg",
      }),
      assetRow("z", { isSelected: true, selectionKind: "edited", billedTo: A, billedAt: t(3) }),
    ];
    const picks = [
      pickRow("w", A, { kind: "original", submittedAt: null }),
      pickRow("x", A, { kind: "original", submittedAt: t(1) }),
    ];

    const plan = planOriginalsOff(rows, picks, t(9));

    expect(plan.pickRewrites.map((pick) => pick.assetId)).toEqual(["w", "x"]);
    expect(plan.assetChanges).toHaveLength(1);
    expect(plan.assetChanges[0]).toMatchObject({
      assetId: "x",
      op: "rekind",
      after: { claimed: true, kind: "edited", billedTo: A, billedAt: t(9) },
    });
    // A final freezes the kind (decision 15).
    expect(plan.assetChanges.find((change) => change.assetId === "y")).toBeUndefined();
  });

  it("leaves a legacy unit (no billedTo) untouched", () => {
    const rows = [assetRow("x", { isSelected: true, selectionKind: "original", billedTo: null })];

    const plan = planOriginalsOff(rows, [], t(9));

    expect(plan.assetChanges).toEqual([]);
  });
});

describe("planReresolve", () => {
  it("skips an asset nobody submitted on and returns no arrival when nothing changes", () => {
    const plan = planReresolve([assetRow("x")], [], ["x"], t(9));

    expect(plan.assetChanges).toEqual([]);
    expect(plan.arrival).toBeNull();
  });
});

describe("attributionDelta", () => {
  const rows = [
    assetRow("x", { isSelected: true, billedTo: A, billedAt: t(1) }),
    assetRow("y", { isSelected: true, billedTo: B, billedAt: t(2) }),
    assetRow("z", { isSelected: true, billedTo: null, billedAt: null }),
  ];
  it("keeps the Σ invariant before and after (people + unattributed = gallery total)", async () => {
    const { attributeQuota, unitsOf } = await import("@/lib/quota-attribution").then(
      async (attribution) => ({
        attributeQuota: attribution.attributeQuota,
        unitsOf: (state: readonly AssetRow[]) =>
          state
            .filter((row) => row.isSelected)
            .map((row) => ({
              assetId: row.id,
              billedTo: row.billedTo,
              kind: row.selectionKind,
              billedAt: row.billedAt,
            })),
      }),
    );
    const plan = planRemovePicks(
      rows,
      [
        pickRow("x", A, { submittedAt: t(1) }),
        pickRow("x", B, { submittedAt: t(3) }),
        pickRow("y", B, { submittedAt: t(2) }),
      ],
      A,
      t(9),
    );
    const before = attributeQuota(unitsOf(rows), FLAT);
    const after = attributeQuota(unitsOf(applyPlanToRows(rows, plan.assetChanges)), FLAT);
    const sum = (attribution: typeof before) =>
      attribution.people.reduce((total, person) => total + person.surchargeCop, 0) +
      attribution.unattributed.surchargeCop;

    expect(sum(before)).toBe(before.quota.surchargeCop);
    expect(sum(after)).toBe(after.quota.surchargeCop);

    const delta = attributionDelta(rows, plan, FLAT);
    expect(delta.gallery.before).toEqual(before.quota);
    expect(delta.gallery.after).toEqual(after.quota);
  });

  it("omits people whose share does not move and lists the assets that do", () => {
    const withThird = [...rows, assetRow("w", { isSelected: true, billedTo: C, billedAt: t(4) })];
    const plan = planRemovePicks(
      withThird,
      [pickRow("x", A, { submittedAt: t(1) }), pickRow("x", B, { submittedAt: t(3) })],
      A,
      t(9),
    );

    const delta = attributionDelta(withThird, plan, FLAT, { [A]: "Ana", [B]: "Beto" });

    expect(delta.assets).toEqual([{ assetId: "x", op: "transfer" }]);
    // C's unit did not move, so C is not listed — only the two people whose
    // shares changed.
    expect(delta.people.map((person) => person.userId).sort()).toEqual([A, B]);
  });

  it("labels a person who loses every unit, using name ?? email when supplied", () => {
    const plan = planRemovePicks(rows, [pickRow("x", A, { submittedAt: t(1) })], A, t(9));
    const delta = attributionDelta(rows, plan, FLAT, { [A]: "Ana" });

    const person = delta.people.find((candidate) => candidate.userId === A)!;
    expect(person.label).toBe("Ana");
    expect(person.before.extras).toBe(1);
    expect(person.after.extras).toBe(0);
  });

  it("never moves the unattributed bucket under these plans — legacy units are protected", () => {
    const legacy = [assetRow("l", { isSelected: true, selectionKind: "original", billedTo: null })];
    const plan = planOriginalsOff(legacy, [], t(9));

    expect(attributionDelta(legacy, plan, FLAT).unattributed).toBeUndefined();
  });

  it("reports the unattributed bucket when two row states really differ there", () => {
    const legacy = [assetRow("l", { isSelected: true, billedTo: null, billedAt: null })];
    const claimed = [assetRow("l", { isSelected: true, billedTo: A, billedAt: t(1) })];

    const delta = attributionDeltaBetween(legacy, claimed, FLAT);

    expect(delta.unattributed?.before.included).toBe(1);
    expect(delta.unattributed?.after.included).toBe(0);
  });
});
