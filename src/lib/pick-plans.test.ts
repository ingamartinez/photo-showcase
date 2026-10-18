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
  previewClientActions,
  unitsOf,
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

function assetRow(id: string, overrides: Partial<AssetRow> = {}): AssetRow & { galleryId: string } {
  return {
    id,
    // The planners only ever read the claim columns; `gallery_id` is here
    // because `claimCart` stamps and re-reads THROUGH it. Without it the stamp
    // matches nothing and the parity test compares an untouched table with
    // itself — the vacuity review C1 found on #260.
    galleryId: G,
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

function pickRow(
  assetId: string,
  userId: string,
  overrides: Partial<PickRow> = {},
): PickRow & { galleryId: string } {
  return {
    assetId,
    galleryId: G,
    userId,
    kind: "edited",
    pickedAt: t(0),
    submittedAt: null,
    ...overrides,
  };
}

function randomState(seed: number) {
  const random = rng(seed);
  const rows: (AssetRow & { galleryId: string })[] = [];
  const picks: (PickRow & { galleryId: string })[] = [];
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

  // Cart (and degraded) picks for A and B — noise the claim must NOT read —
  // plus the CART BEING CLAIMED. `C` is deliberately never a holder above, so
  // its picks are either cart (unclaimed asset) or DEGRADED (on a claimed
  // one), which is exactly the mix `claimCart` is called with in production.
  // Leaving C out of this loop made the parity test below compare an untouched
  // table with itself for all 200 seeds (review of #260, C1).
  for (let i = 0; i < 6; i += 1) {
    const id = `asset-${i}`;
    for (const user of [A, B, C]) {
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

  // Every seed must exercise a REAL cart claim (review of #260, C1) — the
  // loop above can leave C with nothing, which is what made this suite vacuous.
  if (!picks.some((pick) => pick.userId === C)) {
    picks.push(
      pickRow(`asset-${Math.floor(random() * 6)}`, C, {
        kind: random() < 0.5 ? "edited" : "original",
        pickedAt: t(Math.floor(random() * 4)),
        submittedAt: null,
      }),
    );
  }

  return { rows, picks, allowsOriginal };
}

describe("planCartClaim — parity with the executed claimCart (preview == write)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("agrees with claimCart on every one of 200 seeded random states", async () => {
    // Anti-vacuity counters (review of #260, C1): a parity test over states
    // whose cart is always empty compares two no-ops and catches nothing.
    // Every outcome the planner can produce must actually occur somewhere.
    let seedsWithClaim = 0;
    let seedsWithEscalation = 0;
    let seedsWithJoin = 0;
    let seedsWithBlockedEscalation = 0;
    let seedsWithKindFix = 0;
    let emptyCartSeeds = 0;

    for (let seed = 1; seed <= 200; seed += 1) {
      const { rows, picks, allowsOriginal } = randomState(seed);
      const cart = picks.filter((pick) => pick.userId === C && pick.submittedAt === null);
      if (cart.length === 0) emptyCartSeeds += 1;
      const now = t(7);
      const plan = planCartClaim(rows, cart, C, now, { allowsOriginal });
      if (plan.counts.claimed > 0) seedsWithClaim += 1;
      if (plan.counts.escalated > 0) seedsWithEscalation += 1;
      if (plan.counts.joined > 0) seedsWithJoin += 1;
      if (plan.counts.escalationBlocked > 0) seedsWithBlockedEscalation += 1;
      if (plan.pickKindFixes.length > 0) seedsWithKindFix += 1;

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

    expect(emptyCartSeeds).toBe(0);
    expect(seedsWithClaim).toBeGreaterThan(0);
    expect(seedsWithEscalation).toBeGreaterThan(0);
    expect(seedsWithJoin).toBeGreaterThan(0);
    expect(seedsWithBlockedEscalation).toBeGreaterThan(0);
    expect(seedsWithKindFix).toBeGreaterThan(0);
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

  it("never bills a DEGRADED pick (submittedAt null): removing A leaves the asset unclaimed", () => {
    // Decision 8: a cart/degraded pick carries no claim. If it were fed to the
    // resolution as if submitted (M2 of #260's review), the unit would land on
    // B — who never submitted — and B's pick would stop being a cart pick.
    const degraded = pickRow("x", B, { submittedAt: null });

    const plan = planRemovePicks(rows, [pickRow("x", A, { submittedAt: t(2) }), degraded], A, t(9));

    expect(plan.assetChanges).toHaveLength(1);
    expect(plan.assetChanges[0]!.after).toEqual({ claimed: false });
    expect(plan.assetChanges[0]!.op).toBe("unclaim");
  });

  it("picks the SUBMITTERS when one remaining picker submitted and another did not", () => {
    // Same clause, the comparator's end of it: a `submittedAt: null` reaching
    // the arrival sort is `.getTime()` on null — a 500 in production.
    const picks = [
      pickRow("x", A, { submittedAt: t(2) }),
      pickRow("x", B, { submittedAt: null }),
      pickRow("x", C, { submittedAt: t(4) }),
    ];

    const plan = planRemovePicks(rows, picks, A, t(9));

    expect(plan.assetChanges[0]!.op).toBe("transfer");
    expect(plan.assetChanges[0]!.after).toEqual({
      claimed: true,
      kind: "edited",
      billedTo: C,
      billedAt: t(2),
    });
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

// Task #263 (S8) — the admin's BEFORE/AFTER preview. `previewClientActions`
// must be the same planners the two writes execute (`claimCart` for the lock,
// `removeGalleryClientPicks` for the picks), because the whole point of this
// block existing is that the dashboard cannot show one number and write
// another. The parity against the real server actions lives in
// src/app/dashboard/galleries/actions.client-selection.test.ts; this suite
// pins the plans themselves.
describe("previewClientActions — the admin lock and remove-picks preview", () => {
  // Two people, and every ownership relation the preview has to get right:
  //  X  Ana billed, edited, arrived first. Beto JOINED on it.
  //  Y  Ana billed, edited.
  //  W  Ana billed, ORIGINAL, no final. Beto has it in his CART as edited.
  //  Z  unclaimed. Beto has it in his CART.
  // A preview that recomputes the money with different maths — or that
  // previews a cart pick as already claimed — cannot produce these numbers.
  const rows = [
    assetRow("x", { isSelected: true, billedTo: A, billedAt: t(1), selectedAt: t(1) }),
    assetRow("y", { isSelected: true, billedTo: A, billedAt: t(2), selectedAt: t(2) }),
    assetRow("w", {
      isSelected: true,
      selectionKind: "original",
      billedTo: A,
      billedAt: t(3),
      selectedAt: t(3),
    }),
    assetRow("z"),
  ];
  const picks = [
    pickRow("x", A, { submittedAt: t(1) }),
    pickRow("y", A, { submittedAt: t(2) }),
    pickRow("w", A, { kind: "original", submittedAt: t(3) }),
    pickRow("x", B, { submittedAt: t(4) }),
    pickRow("z", B, { submittedAt: null }),
    pickRow("w", B, { submittedAt: null }),
  ];
  const NOW = t(9);
  const labels = { [A]: "Ana", [B]: "Beto" };

  it("previews the lock as claiming the free cart pick AND escalating the original, with both holders' shares", () => {
    const { lock } = previewClientActions(rows, picks, B, NOW, FLAT, labels, {
      allowsOriginal: true,
    });

    // Beto's cart: Z claimed, W escalated Ana -> Beto (decision 3/15).
    expect(lock.assets).toEqual(
      expect.arrayContaining([
        { assetId: "z", op: "claim" },
        { assetId: "w", op: "escalate" },
      ]),
    );
    const ana = lock.people.find((person) => person.userId === A)!;
    const beto = lock.people.find((person) => person.userId === B)!;
    expect(ana.label).toBe("Ana");
    // Ana loses the original unit (2000) and keeps one included + one extra.
    expect(ana.before.originals).toBe(1);
    expect(ana.after.originals).toBe(0);
    expect(ana.before.surchargeCop - ana.after.surchargeCop).toBe(2_000);
    // Beto gains exactly two units.
    expect(beto.before.included + beto.before.extras + beto.before.originals).toBe(0);
    expect(beto.after.included + beto.after.extras + beto.after.originals).toBe(2);
    expect(beto.after.surchargeCop).toBe(10_000);
    // The gallery's own totals are the same maths, not a second one.
    expect(lock.gallery.before.surchargeCop).toBe(7_000);
    expect(lock.gallery.after.surchargeCop).toBe(15_000);
  });

  it("previews remove-picks as transferring X to the other submitter and unclaiming what nobody else sent", () => {
    const { removePicks } = previewClientActions(rows, picks, A, NOW, FLAT, labels, {
      allowsOriginal: true,
    });

    expect(removePicks.assets).toEqual(
      expect.arrayContaining([
        { assetId: "x", op: "transfer" },
        { assetId: "y", op: "unclaim" },
        // W's only other pick is a CART pick — it never carried a claim, so
        // removing Ana's leaves the asset unclaimed rather than billing Beto.
        { assetId: "w", op: "unclaim" },
      ]),
    );
    const beto = removePicks.people.find((person) => person.userId === B)!;
    expect(beto.before.included).toBe(0);
    expect(beto.after.included).toBe(1);
  });

  // The epic's money invariant (S3), carried into the preview: Σ people +
  // unattributed equals the gallery total, BEFORE and AFTER, and the preview's
  // own `gallery` numbers are exactly those two attributions. Recomputed here
  // from the planner's output, so a preview that summed its deltas instead of
  // its shares (unchanged people are omitted from `people` on purpose) fails.
  it("keeps Σ people + unattributed equal to the gallery surcharge, before and after", async () => {
    const { attributeQuota } = await import("@/lib/quota-attribution");
    const sumOf = (state: readonly AssetRow[]) => {
      const attribution = attributeQuota(unitsOf(state), FLAT);
      const people = attribution.people.reduce((total, person) => total + person.surchargeCop, 0);
      return { people, unattributed: attribution.unattributed.surchargeCop };
    };

    const before = sumOf(rows);
    expect(before.people + before.unattributed).toBe(7_000);

    const { lock } = previewClientActions(rows, picks, B, NOW, FLAT, labels, {
      allowsOriginal: true,
    });
    const lockPlan = planCartClaim(
      rows,
      picks.filter((pick) => pick.userId === B && pick.submittedAt === null),
      B,
      NOW,
      { allowsOriginal: true },
    );
    const afterLock = sumOf(applyPlanToRows(rows, lockPlan.assetChanges));
    expect(afterLock.people + afterLock.unattributed).toBe(lock.gallery.after.surchargeCop);
    // The preview's `gallery.after` IS the real attribution of the state the
    // plan produces — not a number the preview summed on its own.
    const realAfter = attributeQuota(unitsOf(applyPlanToRows(rows, lockPlan.assetChanges)), FLAT);
    expect(lock.gallery.after).toEqual(realAfter.quota);
    expect(lock.gallery.before).toEqual(attributeQuota(unitsOf(rows), FLAT).quota);

    const { removePicks } = previewClientActions(rows, picks, A, NOW, FLAT, labels, {
      allowsOriginal: true,
    });
    const removePlan = planRemovePicks(rows, picks, A, NOW);
    const afterRemove = sumOf(applyPlanToRows(rows, removePlan.assetChanges));
    expect(afterRemove.people).toBe(
      removePicks.people.reduce((total, person) => total + person.after.surchargeCop, 0),
    );
    expect(afterRemove.people + afterRemove.unattributed).toBe(
      removePicks.gallery.after.surchargeCop,
    );
  });
});
