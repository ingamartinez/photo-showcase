// Epic #250, task #258 (S3) — the property test the epic's decision 7 demands:
// random sequences of client actions never raise another person's
// `surchargeCop`.
//
// There is no fast-check dependency, so the generator is an inline seeded
// mulberry32. The seed is pinned (SEED = 258) so a failure is reproducible
// from the message alone. It lives inline because there is one consumer.
//
// The property holds only under two preconditions this generator builds in:
// (a) unit prices that do not increase (D12), and (b) strictly increasing
// arrivals across submits (`arrivalAfter`). The two mutation proofs in the
// task remove one apiece and watch this file go red.
import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRA_PRICE_TIERS, validateExtraPriceTiers } from "@/lib/extra-price-tiers";
import type { GalleryQuotaSnapshot } from "@/lib/quota";
import {
  attributeQuota,
  shareFor,
  type ClaimedUnit,
  type QuotaAttribution,
} from "@/lib/quota-attribution";
import {
  arrivalAfter,
  compareCartOrder,
  derivePickStatus,
  gatePickEdit,
  latestBilledAt,
  submitPick,
  type AssetClaim,
} from "@/lib/pick-resolution";
import type { SelectionKind } from "@/lib/selection-snapshot";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 258;
const RUNS = 200;
const STEPS = 60;
const ASSETS = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
const PEOPLE = ["ana", "beto", "caro"];

type Rng = () => number;

type PickRow = {
  userId: string;
  assetId: string;
  kind: SelectionKind;
  pickedAt: Date;
  submittedAt: Date | null;
};

type Counters = {
  claimed: number;
  escalated: number;
  joined: number;
  escalationBlocked: number;
  escalatedFromNull: number;
  arrivalAdjusted: number;
};

const claimKey = (userId: string, assetId: string) => `${userId}:${assetId}`;

function pickSnapshot(rng: Rng): GalleryQuotaSnapshot {
  const roll = rng();
  if (roll < 1 / 3) {
    return {
      includedPhotosSnapshot: Math.floor(rng() * 5),
      extraPhotoPriceCopSnapshot: 5_000,
      extraPhotoPriceTiersSnapshot: null,
      originalPhotoPriceCopSnapshot: 2_000,
    };
  }
  if (roll < 2 / 3) {
    return {
      includedPhotosSnapshot: Math.floor(rng() * 4),
      extraPhotoPriceCopSnapshot: DEFAULT_EXTRA_PRICE_TIERS[0]!.priceCop,
      extraPhotoPriceTiersSnapshot: [...DEFAULT_EXTRA_PRICE_TIERS],
      originalPhotoPriceCopSnapshot: 2_000,
    };
  }
  const count = 1 + Math.floor(rng() * 4);
  const tiers: { minExtras: number; priceCop: number }[] = [];
  let minExtras = 1;
  let priceCop = 20_000;
  for (let i = 0; i < count; i++) {
    tiers.push({ minExtras, priceCop });
    minExtras += 1 + Math.floor(rng() * 3);
    priceCop = Math.max(0, priceCop - Math.floor(rng() * 3_001));
  }
  const validated = validateExtraPriceTiers(tiers);
  if (!validated.ok) {
    return {
      includedPhotosSnapshot: Math.floor(rng() * 4),
      extraPhotoPriceCopSnapshot: DEFAULT_EXTRA_PRICE_TIERS[0]!.priceCop,
      extraPhotoPriceTiersSnapshot: [...DEFAULT_EXTRA_PRICE_TIERS],
      originalPhotoPriceCopSnapshot: 2_000,
    };
  }
  return {
    includedPhotosSnapshot: Math.floor(rng() * 4),
    extraPhotoPriceCopSnapshot: tiers[0]!.priceCop,
    extraPhotoPriceTiersSnapshot: tiers,
    originalPhotoPriceCopSnapshot: 2_000,
  };
}

function claimedUnits(claims: Map<string, Extract<AssetClaim, { claimed: true }>>): ClaimedUnit[] {
  return [...claims.entries()].map(([assetId, claim]) => ({
    assetId,
    billedTo: claim.billedTo,
    kind: claim.kind,
    billedAt: claim.billedAt,
  }));
}

function expectSigma(att: QuotaAttribution, message: string) {
  const included = att.people.reduce((s, p) => s + p.included, 0) + att.unattributed.included;
  const extras = att.people.reduce((s, p) => s + p.extras, 0) + att.unattributed.extras;
  const originals = att.people.reduce((s, p) => s + p.originals, 0) + att.unattributed.originals;
  const extrasSurchargeCop =
    att.people.reduce((s, p) => s + p.extrasSurchargeCop, 0) + att.unattributed.extrasSurchargeCop;
  const originalsSurchargeCop =
    att.people.reduce((s, p) => s + p.originalsSurchargeCop, 0) +
    att.unattributed.originalsSurchargeCop;
  const surchargeCop =
    att.people.reduce((s, p) => s + p.surchargeCop, 0) + att.unattributed.surchargeCop;
  expect(included, message).toBe(att.quota.selectedEdited - att.quota.extras);
  expect(extras, message).toBe(att.quota.extras);
  expect(originals, message).toBe(att.quota.originals);
  expect(extrasSurchargeCop, message).toBe(att.quota.extrasSurchargeCop);
  expect(originalsSurchargeCop, message).toBe(att.quota.originalsSurchargeCop);
  expect(surchargeCop, message).toBe(att.quota.surchargeCop);
}

function runAll(): Counters {
  const counters: Counters = {
    claimed: 0,
    escalated: 0,
    joined: 0,
    escalationBlocked: 0,
    escalatedFromNull: 0,
    arrivalAdjusted: 0,
  };

  for (let run = 0; run < RUNS; run++) {
    const rng = mulberry32(SEED + run);
    const snapshot = pickSnapshot(rng);
    const hasFinal = new Map(ASSETS.map((asset) => [asset, rng() < 0.2]));
    const claims = new Map<string, Extract<AssetClaim, { claimed: true }>>();
    const picks = new Map<string, PickRow>();

    if (rng() < 0.5) {
      claims.set("a7", {
        claimed: true,
        kind: rng() < 0.5 ? "edited" : "original",
        billedTo: null,
        billedAt: null,
      });
    }

    let clock = new Date(Date.UTC(2026, 9, 17));
    const drift = [0, 0, 1, 7, -3];

    for (let step = 0; step < STEPS; step++) {
      clock = new Date(clock.getTime() + drift[Math.floor(rng() * drift.length)]!);
      const before = attributeQuota(claimedUnits(claims), snapshot);
      const beforeClaims = new Map(claims);

      let actor: string;
      let action: string;
      const roll = rng();
      if (roll < 0.4) {
        const user = PEOPLE[Math.floor(rng() * PEOPLE.length)]!;
        const asset = ASSETS[Math.floor(rng() * ASSETS.length)]!;
        const kind: SelectionKind = rng() < 0.5 ? "edited" : "original";
        actor = user;
        action = JSON.stringify({ type: "pick", user, asset, kind });
        if (!picks.has(claimKey(user, asset))) {
          picks.set(claimKey(user, asset), {
            userId: user,
            assetId: asset,
            kind,
            pickedAt: clock,
            submittedAt: null,
          });
        }
      } else if (roll < 0.55) {
        const user = PEOPLE[Math.floor(rng() * PEOPLE.length)]!;
        const asset = ASSETS[Math.floor(rng() * ASSETS.length)]!;
        actor = user;
        action = JSON.stringify({ type: "unpick", user, asset });
        const pick = picks.get(claimKey(user, asset));
        if (pick) {
          const status = derivePickStatus(pick, claims.get(asset) ?? { claimed: false });
          if (gatePickEdit(status, pick.kind, { type: "remove" }).ok) {
            picks.delete(claimKey(user, asset));
          }
        }
      } else if (roll < 0.7) {
        const user = PEOPLE[Math.floor(rng() * PEOPLE.length)]!;
        const asset = ASSETS[Math.floor(rng() * ASSETS.length)]!;
        const kind: SelectionKind = rng() < 0.5 ? "edited" : "original";
        actor = user;
        action = JSON.stringify({ type: "retype", user, asset, kind });
        const pick = picks.get(claimKey(user, asset));
        if (pick) {
          const status = derivePickStatus(pick, claims.get(asset) ?? { claimed: false });
          if (gatePickEdit(status, pick.kind, { type: "retype", kind }).ok) {
            pick.kind = kind;
          }
        }
      } else {
        const user = PEOPLE[Math.floor(rng() * PEOPLE.length)]!;
        actor = user;
        const cart = [...picks.values()]
          .filter((p) => p.userId === user && p.submittedAt === null)
          .sort(compareCartOrder);
        action = JSON.stringify({ type: "submit", user, cart: cart.map((p) => p.assetId) });
        if (cart.length > 0) {
          const latest = latestBilledAt([...claims.values()].map((c) => c.billedAt));
          const arrival = arrivalAfter(clock, latest);
          if (arrival.getTime() !== clock.getTime()) counters.arrivalAdjusted += 1;
          for (const pick of cart) {
            const claim: AssetClaim = claims.get(pick.assetId) ?? { claimed: false };
            const outcome = submitPick(
              claim,
              { userId: user, kind: pick.kind },
              { arrival, hasFinal: hasFinal.get(pick.assetId)! },
            );
            if (outcome.type === "claimed") {
              counters.claimed += 1;
              claims.set(pick.assetId, outcome.claim);
            } else if (outcome.type === "escalated") {
              counters.escalated += 1;
              if (outcome.from === null) counters.escalatedFromNull += 1;
              claims.set(pick.assetId, outcome.claim);
            } else if (outcome.type === "joined") {
              counters.joined += 1;
            } else {
              counters.escalationBlocked += 1;
            }
          }
          for (const pick of cart) pick.submittedAt = clock;
        }
      }

      const message = `seed=${SEED + run} step=${step} action=${action}`;
      const after = attributeQuota(claimedUnits(claims), snapshot);
      expectSigma(after, message);

      for (const person of [...PEOPLE, null]) {
        if (person === actor) continue;
        expect(shareFor(after, person).surchargeCop, message).toBeLessThanOrEqual(
          shareFor(before, person).surchargeCop,
        );
      }

      for (const [asset, prior] of beforeClaims) {
        const current = claims.get(asset);
        expect(current?.claimed, message).toBe(true);
        if (prior.kind === "edited") {
          expect(current?.kind, message).toBe("edited");
        }
      }

      for (const pick of picks.values()) {
        try {
          derivePickStatus(pick, claims.get(pick.assetId) ?? { claimed: false });
        } catch (error) {
          throw new Error(`${message} derivePickStatus threw: ${String(error)}`);
        }
      }
    }
  }

  return counters;
}

describe("client action property — no client action raises another person's surcharge", () => {
  it(`holds for ${RUNS} runs x ${STEPS} steps from SEED ${SEED}`, () => {
    runAll();
  });
});

describe("anti-vacuity — the generator reaches every outcome", () => {
  it("exercises claimed, escalated, joined, escalation_blocked and an adjusted arrival", () => {
    const counters = runAll();
    // The observed counts are the report's evidence that the property is not
    // passing on an empty exercise.
    const reachedEveryOutcome =
      counters.claimed >= 1 &&
      counters.escalated >= 1 &&
      counters.joined >= 1 &&
      counters.escalationBlocked >= 1;
    expect(reachedEveryOutcome, JSON.stringify(counters)).toBe(true);
    expect(counters.escalatedFromNull, JSON.stringify(counters)).toBeGreaterThanOrEqual(1);
    expect(counters.arrivalAdjusted, JSON.stringify(counters)).toBeGreaterThanOrEqual(1);
  });
});
