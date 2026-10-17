import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle.
vi.mock("server-only", () => ({}));

import { assetPicks, assets } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import type { DbTransaction } from "@/lib/gallery-client-locks";
import { createFakeDb } from "@/test-support/fake-db";
import { applyAssetChanges, claimCart, reresolveAssets } from "@/lib/pick-claims";
import { type ClaimedUnit } from "@/lib/quota-attribution";
import type { GalleryQuotaSnapshot } from "@/lib/quota";

type Row = Record<string, unknown>;

const G = "11111111-1111-4111-8111-111111111111";
const A = "client-a";
const B = "client-b";

const t = (n: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, n));

const FLAT: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 1,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

function assetRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    galleryId: G,
    isSelected: false,
    selectionKind: "edited",
    billedTo: null,
    billedAt: null,
    finalKey: null,
    ...overrides,
  };
}

function pickRow(assetId: string, userId: string, overrides: Row = {}): Row {
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

function claim(overrides: Row = {}): Row {
  return { isSelected: true, selectionKind: "edited", billedTo: A, billedAt: t(1), ...overrides };
}

function setup(assetRows: Row[], pickRows: Row[]) {
  const fake = createFakeDb([assets, assetPicks]);
  const assetStore = fake.__tables.get(assets)!;
  const pickStore = fake.__tables.get(assetPicks)!;
  assetStore.push(...assetRows);
  pickStore.push(...pickRows);
  const gallery = { id: G } as Gallery;
  const tx = fake as unknown as DbTransaction;
  return { fake, assetStore, pickStore, gallery, tx };
}

function unitsFrom(assetStore: Row[]): ClaimedUnit[] {
  return assetStore
    .filter((row) => row.isSelected)
    .map((row) => ({
      assetId: row.id as string,
      billedTo: row.billedTo as string | null,
      kind: row.selectionKind as "edited" | "original",
      billedAt: row.billedAt as Date | null,
    }));
}

describe("claimCart", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("C1 — a free asset is claimed: every column, counts.claimed, newUnits, stamped and arrival", async () => {
    const ctx = setup([assetRow("x")], [pickRow("x", A)]);

    const result = await claimCart(ctx.tx, ctx.gallery, A, t(5));

    expect(result).toEqual({
      stamped: 1,
      newUnits: 1,
      counts: { claimed: 1, escalated: 0, joined: 0, escalationBlocked: 0 },
      arrival: t(5),
    });
    expect(ctx.assetStore[0]).toMatchObject({
      isSelected: true,
      selectedAt: t(5),
      requestedAt: t(5),
      selectionKind: "edited",
      billedTo: A,
      billedAt: t(5),
    });
    expect(ctx.pickStore[0]).toMatchObject({ submittedAt: t(5) });
  });

  it("C2 — B's edited pick on A's edited claim joins, and A's row is byte-identical", async () => {
    const ctx = setup([assetRow("x", claim())], [pickRow("x", B)]);
    const before = structuredClone(ctx.assetStore[0]);

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts).toEqual({ claimed: 0, escalated: 0, joined: 1, escalationBlocked: 0 });
    expect(result.newUnits).toBe(0);
    expect(ctx.assetStore[0]).toEqual(before);
  });

  it("C3 — B's edited pick on A's original claim escalates: billedTo moves, kind edited, billedAt = arrival, A's claim moments unchanged", async () => {
    const ctx = setup(
      [assetRow("x", claim({ selectionKind: "original", billedAt: t(1) }))],
      [pickRow("x", B)],
    );

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts.escalated).toBe(1);
    expect(result.newUnits).toBe(1);
    expect(ctx.assetStore[0]).toMatchObject({
      selectionKind: "edited",
      billedTo: B,
      billedAt: t(5),
    });
  });

  it("C4 — decision 15: a final blocks the escalation, the claim stays byte-identical and B's pick is still submitted", async () => {
    const ctx = setup(
      [assetRow("x", claim({ selectionKind: "original", finalKey: "final/x.jpg" }))],
      [pickRow("x", B)],
    );
    const before = structuredClone(ctx.assetStore[0]);

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts).toEqual({ claimed: 0, escalated: 0, joined: 0, escalationBlocked: 1 });
    expect(result.newUnits).toBe(0);
    expect(ctx.assetStore[0]).toEqual(before);
    expect(ctx.pickStore[0]!.submittedAt).toEqual(t(5));
  });

  it("C5 — an original pick on an edited claim joins, kind stays edited (no edited->original)", async () => {
    const ctx = setup([assetRow("x", claim())], [pickRow("x", B, { kind: "original" })]);
    const before = structuredClone(ctx.assetStore[0]);

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts.joined).toBe(1);
    expect(ctx.assetStore[0]).toEqual(before);
    expect(ctx.assetStore[0]!.selectionKind).toBe("edited");
  });

  it("C6 — an original pick on an original claim joins", async () => {
    const ctx = setup(
      [assetRow("x", claim({ selectionKind: "original" }))],
      [pickRow("x", B, { kind: "original" })],
    );
    const before = structuredClone(ctx.assetStore[0]);

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts.joined).toBe(1);
    expect(ctx.assetStore[0]).toEqual(before);
  });

  it("C7 — escalates from a legacy billedTo: null claim", async () => {
    const ctx = setup(
      [assetRow("x", claim({ selectionKind: "original", billedTo: null }))],
      [pickRow("x", B)],
    );

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts.escalated).toBe(1);
    expect(ctx.assetStore[0]).toMatchObject({ billedTo: B, selectionKind: "edited" });
  });

  it("C9 — one arrival per call: three claims share the same billedAt", async () => {
    const ctx = setup(
      [assetRow("x"), assetRow("y"), assetRow("z")],
      [pickRow("x", A), pickRow("y", A), pickRow("z", A)],
    );

    await claimCart(ctx.tx, ctx.gallery, A, t(5));

    const at = ctx.assetStore.map((row) => (row.billedAt as Date).getTime());
    expect(new Set(at)).toEqual(new Set([t(5).getTime()]));
  });

  it("C10 — a stale billedAt on an UNCLAIMED row is ignored by latestBilledAt", async () => {
    const ctx = setup(
      // Claimed at T, plus an unclaimed row carrying a much later stale stamp.
      [assetRow("claimed", claim({ billedAt: t(1) })), assetRow("free", { billedAt: t(9) })],
      [pickRow("free", A)],
    );

    await claimCart(ctx.tx, ctx.gallery, A, t(4));

    // The only CLAIMED billedAt is t(1), so now=t(4) wins unchanged. A
    // filterless latestBilledAt would have used the stale t(9) and pushed
    // the arrival to t(9)+1.
    expect((ctx.assetStore.find((row) => row.id === "free")!.billedAt as Date).getTime()).toBe(
      t(4).getTime(),
    );
  });

  it("C11 — a CAS loss on the claim throws", async () => {
    const ctx = setup([assetRow("x")], [pickRow("x", A)]);
    const row = ctx.assetStore[0]!;
    // Read as unclaimed, then mutated to claimed between the read and the
    // write: the UPDATE's `is_selected = false` predicate matches nothing.
    let reads = 0;
    Object.defineProperty(row, "isSelected", {
      configurable: true,
      get: () => reads++ > 0,
      set: () => {},
    });

    await expect(claimCart(ctx.tx, ctx.gallery, A, t(5))).rejects.toThrow(/claim CAS lost/);
  });

  it("C11b — a CAS loss on the ESCALATION throws: a final landing mid-claim fails closed", async () => {
    // This one is REACHABLE in production, unlike the plan's "unreachable for
    // every known writer": `final/route.ts` writes `assets.final_key` without
    // taking the gallery lock, and a rolling gallery finishes proofs while it
    // is still `proofing`. So an upload can commit between step 2's read and
    // this UPDATE. The throw rolls the whole submit back (a 500, fail-closed)
    // and the retry resolves to `escalation_blocked` instead of billing an
    // edited unit over a photo that already has a final.
    const ctx = setup([assetRow("x", claim({ selectionKind: "original" }))], [pickRow("x", B)]);
    const row = ctx.assetStore[0]!;
    // Read as "no final", then the final lands between the read and the write.
    let reads = 0;
    Object.defineProperty(row, "finalKey", {
      configurable: true,
      get: () => (reads++ === 0 ? null : "final/x.jpg"),
      set: () => {},
    });

    await expect(claimCart(ctx.tx, ctx.gallery, B, t(5))).rejects.toThrow(/claim CAS lost/);
  });

  it("C13 — the cart is STAMPED first: the first write of the call is asset_picks, before any assets claim", async () => {
    // One claim on a free asset and one escalation on A's original: TWO
    // `assets` writes, so "the stamp came first" is a claim about an order
    // with somewhere for it to hide. Claim-then-stamp — the order the task
    // body still prescribes, retracted in the plan §6.1 because PATCH takes no
    // gallery lock and a committed delete in that window leaves a claimed,
    // billed unit with no pick behind it (the S2 §6.1 ghost unit) — reverses
    // the first two entries and goes RED here.
    const ctx = setup(
      [assetRow("x"), assetRow("y", claim({ selectionKind: "original" }))],
      [pickRow("x", B), pickRow("y", B)],
    );
    const writes: string[] = [];
    const realUpdate = ctx.fake.update.bind(ctx.fake);
    ctx.fake.update = ((table: unknown) => {
      writes.push(table === assetPicks ? "picks" : table === assets ? "assets" : "other");
      return realUpdate(table);
    }) as typeof ctx.fake.update;

    const result = await claimCart(ctx.tx, ctx.gallery, B, t(5));

    expect(result.counts).toEqual({ claimed: 1, escalated: 1, joined: 0, escalationBlocked: 0 });
    expect(result.stamped).toBe(2);
    // The stamp is the FIRST write and there is exactly one of it. This is a
    // claim about WRITE ORDER only — where the claimed rows came from is
    // C15's business, not this assertion's.
    expect(writes).toEqual(["picks", "assets", "assets"]);
  });

  it("C15 — the claims come only from the rows the stamp RETURNED: a delete committed just before the stamp leaves that asset unclaimed", async () => {
    // Stamp-first is necessary but not sufficient. Taking the cart from a
    // pre-stamp SELECT and then stamping keeps C13's write order
    // (`picks, assets, assets`) and still bills a ghost unit: a client PATCH
    // delete that commits between that SELECT and the stamp is excluded from
    // the stamp and claimed anyway — the S2 §6.1 unit with no pick behind it,
    // which nobody can remove. So A's pick on "y" is spliced out of the pick
    // store just before the stamp runs: the delete that committed first.
    const ctx = setup([assetRow("x"), assetRow("y")], [pickRow("x", A), pickRow("y", A)]);
    const realUpdate = ctx.fake.update.bind(ctx.fake);
    ctx.fake.update = ((table: unknown) => {
      if (table === assetPicks) {
        const index = ctx.pickStore.findIndex((pick) => pick.assetId === "y" && pick.userId === A);
        if (index >= 0) ctx.pickStore.splice(index, 1);
      }
      return realUpdate(table);
    }) as typeof ctx.fake.update;

    const result = await claimCart(ctx.tx, ctx.gallery, A, t(5));

    expect(result.stamped).toBe(1);
    // The pick that survived the delete is still claimed: the call is not
    // vacuous, it claimed exactly the row the stamp returned.
    expect(ctx.assetStore.find((row) => row.id === "x")).toMatchObject({
      isSelected: true,
      billedTo: A,
    });
    // "y" lost its pick and must not be billed for it.
    expect(ctx.assetStore.find((row) => row.id === "y")).toMatchObject({
      isSelected: false,
      billedTo: null,
    });
  });

  it("C14 — the stamp is scoped to the locked gallery: another gallery's cart is untouched", async () => {
    // The same person can hold carts in two galleries. Without the
    // `gallery_id` filter the stamp takes the other gallery's pick too, and
    // step 2's `assets` read (which IS gallery-scoped) cannot resolve it — the
    // "unknown asset" throw, i.e. it fails closed as a 500, not silently.
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const ctx = setup(
      [assetRow("x"), assetRow("z", { galleryId: OTHER })],
      [pickRow("x", A), pickRow("z", A, { galleryId: OTHER })],
    );

    const result = await claimCart(ctx.tx, ctx.gallery, A, t(5));

    expect(result.stamped).toBe(1);
    expect(ctx.pickStore.find((pick) => pick.assetId === "x")!.submittedAt).toEqual(t(5));
    expect(ctx.pickStore.find((pick) => pick.assetId === "z")!.submittedAt).toBeNull();
    expect(ctx.assetStore.find((row) => row.id === "x")).toMatchObject({
      isSelected: true,
      billedTo: A,
    });
    expect(ctx.assetStore.find((row) => row.id === "z")).toMatchObject({
      isSelected: false,
      billedTo: null,
    });
  });

  it("C12 — an empty cart stamps nothing, returns arrival: null and writes no asset", async () => {
    const ctx = setup([assetRow("x")], [pickRow("x", A, { submittedAt: t(0) })]);
    const before = structuredClone(ctx.assetStore);

    const result = await claimCart(ctx.tx, ctx.gallery, A, t(5));

    expect(result).toEqual({
      stamped: 0,
      newUnits: 0,
      counts: { claimed: 0, escalated: 0, joined: 0, escalationBlocked: 0 },
      arrival: null,
    });
    expect(ctx.assetStore).toEqual(before);
  });

  it("C8 — arrival beats a tie and a backwards clock, so a lower-sorting newcomer cannot steal an included slot", async () => {
    // A holds "zzzz" (edited, billedAt T). B adds "aaaa". Without
    // arrivalAfter, the tie is broken by asset id and "aaaa" takes the
    // included slot, raising A's surcharge (decision 7 violation).
    const snapshot: GalleryQuotaSnapshot = { ...FLAT };
    const { attributeQuota, shareFor } = await import("@/lib/quota-attribution");

    // Tie.
    const tied = setup(
      [assetRow("zzzz", claim({ billedAt: t(1) })), assetRow("aaaa")],
      [pickRow("aaaa", B)],
    );
    await claimCart(tied.tx, tied.gallery, B, t(1));
    const afterTie = attributeQuota(unitsFrom(tied.assetStore), snapshot);
    expect(shareFor(afterTie, A).surchargeCop).toBe(0);
    expect((tied.assetStore.find((row) => row.id === "aaaa")!.billedAt as Date).getTime()).toBe(
      t(1).getTime() + 1,
    );

    // Backwards clock.
    const backwards = setup(
      [assetRow("zzzz", claim({ billedAt: t(1) })), assetRow("aaaa")],
      [pickRow("aaaa", B)],
    );
    await claimCart(backwards.tx, backwards.gallery, B, new Date(t(1).getTime() - 5));
    const afterBack = attributeQuota(unitsFrom(backwards.assetStore), snapshot);
    expect(shareFor(afterBack, A).surchargeCop).toBe(0);
    expect(
      (backwards.assetStore.find((row) => row.id === "aaaa")!.billedAt as Date).getTime(),
    ).toBe(t(1).getTime() + 1);
  });
});

// Epic #250 S5 (#260) — the additions the admin write path needs.
describe("claimCart — the on-behalf restriction and the originals coercion", () => {
  it("stamps and claims ONLY the requested asset, leaving the rest of the cart in the cart", async () => {
    const ctx = setup([assetRow("x"), assetRow("y")], [pickRow("x", A), pickRow("y", A)]);

    const result = await claimCart(ctx.tx, ctx.gallery, A, t(5), { assetId: "x" });

    expect(result.stamped).toBe(1);
    expect(ctx.assetStore.find((row) => row.id === "x")).toMatchObject({
      isSelected: true,
      billedTo: A,
    });
    expect(ctx.assetStore.find((row) => row.id === "y")).toMatchObject({
      isSelected: false,
      billedTo: null,
    });
    expect(ctx.pickStore.find((pick) => pick.assetId === "y")!.submittedAt).toBeNull();
  });

  it("coerces an original cart pick to edited when the LOCKED gallery disallows originals (hazard 6's race)", async () => {
    // The PATCH gate reads the flag without the gallery lock, so a retype to
    // `original` can land after an OFF commits. `claimCart` holds the locked
    // row, so the coercion here is the money boundary.
    const ctx = setup([assetRow("x")], [pickRow("x", A, { kind: "original" })]);
    const gallery = { id: G, allowsOriginalSelection: false } as Gallery;

    await claimCart(ctx.tx, gallery, A, t(5));

    expect(ctx.assetStore[0]).toMatchObject({ selectionKind: "edited", billedTo: A });
    expect(ctx.pickStore[0]).toMatchObject({ kind: "edited" });
  });
});

describe("applyAssetChanges — CAS losses fail closed", () => {
  it("throws when an unclaim's billedTo changed underneath the plan", async () => {
    const ctx = setup([assetRow("x", claim())], []);
    // The plan read `billedTo: A`; by the time the write runs the row says
    // somebody else — a concurrent re-resolution committed first.
    ctx.assetStore[0]!.billedTo = "someone-else";

    await expect(
      applyAssetChanges(
        ctx.tx,
        [
          {
            assetId: "x",
            before: { claimed: true, kind: "edited", billedTo: A, billedAt: t(1) },
            after: { claimed: false },
            op: "unclaim",
          },
        ],
        t(9),
      ),
    ).rejects.toThrow(/claim CAS lost/);
  });

  it("throws when a final lands between the plan's read and a kind change", async () => {
    const ctx = setup([assetRow("x", claim({ selectionKind: "original" }))], []);
    // The plan read `finalKey: null`; an upload committed before the write.
    ctx.assetStore[0]!.finalKey = "final/x.jpg";

    await expect(
      applyAssetChanges(
        ctx.tx,
        [
          {
            assetId: "x",
            before: { claimed: true, kind: "original", billedTo: A, billedAt: t(1) },
            after: { claimed: true, kind: "edited", billedTo: A, billedAt: t(9) },
            op: "rekind",
          },
        ],
        t(9),
      ),
    ).rejects.toThrow(/claim CAS lost/);
  });
});

describe("reresolveAssets — end to end", () => {
  it("re-elects the remaining submitted picker after a delete, keeping the arrival", async () => {
    // A's submitted pick is already gone (the caller deleted it); B's remains.
    const ctx = setup(
      [assetRow("x", claim({ billedAt: t(2) }))],
      [pickRow("x", B, { submittedAt: t(3) })],
    );

    const plan = await reresolveAssets(ctx.tx, ctx.gallery, ["x"], t(9));

    expect(plan.assetChanges).toHaveLength(1);
    expect(plan.assetChanges[0]!.op).toBe("transfer");
    expect(ctx.assetStore[0]).toMatchObject({ billedTo: B, billedAt: t(2) });
  });

  it("unclaims an asset whose last submitted pick is gone", async () => {
    const ctx = setup([assetRow("x", claim())], []);

    await reresolveAssets(ctx.tx, ctx.gallery, ["x"], t(9));

    expect(ctx.assetStore[0]).toMatchObject({
      isSelected: false,
      billedTo: null,
      billedAt: null,
      selectedAt: null,
      requestedAt: null,
    });
  });
});
