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
      {
        userId: "a",
        lockedAt: T0,
        submittedAt: T0,
        pickCount: 2,
        requestedCount: 0,
        editedCount: 0,
        unsentCount: 2,
      },
      {
        userId: "b",
        lockedAt: null,
        submittedAt: null,
        pickCount: 1,
        requestedCount: 0,
        editedCount: 0,
        unsentCount: 1,
      },
    ]);
    // Removed client has no row (their pick stays attributed, but is not listed).
    expect(result.clients.find((c) => c.userId === "gone")).toBeUndefined();
    expect(result.pickOwnerByAssetId).toMatchObject({ "1": "a", "2": "a", "3": "b" });
    expect(result.pickOwnerByAssetId["6"]).toBeUndefined();
  });
});

// Task #244 — pedidas / editadas / por enviar per person. The pickers OWN
// DIFFERENT assets and finals exist for only SOME of them, so a count taken
// over the whole gallery (or attributed to the wrong person) cannot pass.
describe("getGalleryClientSelections — order tally (task #244)", () => {
  it("tallies requested, edited and unsent PER PERSON off their own picks", async () => {
    const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Rows } };
    db.__rows.assets.length = 0;
    const ordered = new Date("2026-10-16T09:00:00Z");
    const pick = (id: string, by: string, o: Row = {}) => ({
      ...asset(id, G1, by),
      requestedAt: null,
      isEdited: false,
      finalKey: null,
      ...o,
    });
    db.__rows.assets.push(
      // a: 3 ordered (1 with a final), 1 unsent
      pick("a1", "a", { requestedAt: ordered, isEdited: true, finalKey: "f/a1.jpg" }),
      pick("a2", "a", { requestedAt: ordered }),
      pick("a3", "a", { requestedAt: ordered }),
      pick("a4", "a"),
      // b: 1 ordered with a final, 2 unsent
      pick("b1", "b", { requestedAt: ordered, isEdited: true, finalKey: "f/b1.jpg" }),
      pick("b2", "b"),
      pick("b3", "b"),
      // An unsent pick that already carries a final is NOT edited work: only
      // ordered picks count as editadas.
      pick("b4", "b", { isEdited: true, finalKey: "f/b4.jpg" }),
    );
    const { getGalleryClientSelections } = await import("./galleries");

    const { clients } = await getGalleryClientSelections(G1);

    const tally = (id: string) => {
      const c = clients.find((x) => x.userId === id)!;
      return [c.pickCount, c.requestedCount, c.editedCount, c.unsentCount];
    };
    expect(tally("a")).toEqual([4, 3, 1, 1]);
    expect(tally("b")).toEqual([4, 1, 1, 3]);
  });
});
