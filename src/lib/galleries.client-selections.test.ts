import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { assets, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleryClients, assets]);
  return {
    db: Object.assign(fake, {
      __rows: {
        galleryClients: fake.__tables.get(galleryClients)!,
        assets: fake.__tables.get(assets)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;
type Rows = { galleryClients: Row[]; assets: Row[] };

const G1 = "g1";
const G2 = "g2";
const T0 = new Date("2026-07-10T10:00:00Z");

const member = (galleryId: string, userId: string, o: Row = {}): Row => ({
  galleryId,
  userId,
  removedAt: null,
  selectionLockedAt: null,
  selectionSubmittedAt: null,
  ...o,
});
const asset = (id: string, galleryId: string, selectedBy: string | null): Row => ({
  id,
  galleryId,
  isSelected: selectedBy !== null,
  selectedBy,
});

beforeEach(async () => {
  const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Rows } };
  db.__rows.galleryClients.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleryClients.push(
    member(G1, "a", { selectionLockedAt: T0, selectionSubmittedAt: T0 }),
    member(G1, "b"),
    member(G1, "gone", { removedAt: T0 }),
    member(G2, "a"),
  );
  db.__rows.assets.push(
    asset("1", G1, "a"),
    asset("2", G1, "a"),
    asset("3", G1, "b"),
    asset("4", G1, null),
    asset("5", G1, "gone"),
    asset("6", G2, "a"),
  );
});

describe("getGalleryClientSelections", () => {
  it("counts each ACTIVE client's picks within this gallery only, with their lock state", async () => {
    const { getGalleryClientSelections } = await import("./galleries");

    const result = await getGalleryClientSelections(G1);

    expect(result.clients).toEqual([
      { userId: "a", lockedAt: T0, submittedAt: T0, pickCount: 2 },
      { userId: "b", lockedAt: null, submittedAt: null, pickCount: 1 },
    ]);
    // Removed client has no row (their pick stays attributed, but is not listed).
    expect(result.clients.find((c) => c.userId === "gone")).toBeUndefined();
    expect(result.pickOwnerByAssetId).toMatchObject({ "1": "a", "2": "a", "3": "b" });
    expect(result.pickOwnerByAssetId["6"]).toBeUndefined();
  });
});
