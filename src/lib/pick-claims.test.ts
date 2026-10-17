import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle.
vi.mock("server-only", () => ({}));

import { assetPicks, assets } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import type { DbTransaction } from "@/lib/gallery-client-locks";
import { createFakeDb } from "@/test-support/fake-db";
import { claimCart } from "@/lib/pick-claims";
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
