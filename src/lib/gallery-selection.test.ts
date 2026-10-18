import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { FakeDb } from "@/test-support/fake-db";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { assets, assetPicks, users, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([assets, assetPicks, users, galleryClients]);
  return {
    db: Object.assign(fake, {
      __rows: {
        assets: fake.__tables.get(assets)!,
        assetPicks: fake.__tables.get(assetPicks)!,
        users: fake.__tables.get(users)!,
        galleryClients: fake.__tables.get(galleryClients)!,
      },
    }),
  };
});

import { db } from "@/lib/db";
import { assetPicks, assets, galleryClients, users } from "@/lib/db/schema";
import { buildGallerySelection, getGallerySelection } from "@/lib/gallery-selection";
import { unitsOf, type AssetRow, type PickRow } from "@/lib/pick-plans";
import { computeQuota } from "@/lib/quota";
import { attributeQuota } from "@/lib/quota-attribution";
import type { SelectionKind, SelectionPickState } from "@/lib/selection-snapshot";
import type { PickStatus } from "@/lib/pick-resolution";

const fake = db as unknown as FakeDb;
const assetRows = () => fake.__tables.get(assets)!;
const pickRows = () => fake.__tables.get(assetPicks)!;
const userRows = () => fake.__tables.get(users)!;
const memberRows = () => fake.__tables.get(galleryClients)!;

const GALLERY = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY = "22222222-2222-4222-8222-222222222222";

const TERMS = {
  includedPhotosSnapshot: 2,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

function asset(overrides: Partial<AssetRow> & { id: string }): AssetRow & { galleryId: string } {
  return {
    galleryId: GALLERY,
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

function pick(
  overrides: Partial<PickRow> & { assetId: string; userId: string },
): PickRow & { galleryId: string } {
  return {
    galleryId: GALLERY,
    kind: "edited",
    pickedAt: new Date("2026-10-01T10:00:00.000Z"),
    submittedAt: new Date("2026-10-01T11:00:00.000Z"),
    ...overrides,
  };
}

function labelsOf(rows: { id: string; name: string | null; email: string }[]) {
  return new Map(rows.map((row) => [row.id, row.name ?? row.email]));
}

beforeEach(() => {
  assetRows().length = 0;
  pickRows().length = 0;
  userRows().length = 0;
  memberRows().length = 0;
  fake.__log.length = 0;
  userRows().push(
    { id: "ana", name: "Ana Pérez", email: "ana@example.com" },
    { id: "beto", name: null, email: "beto@example.com" },
    { id: "caro", name: "Caro Gil", email: "caro@example.com" },
  );
});

/** A two-person (plus one degraded cart) fixture used across the suites. */
function seedTwoPeople() {
  assetRows().push(
    // Ana's claim, edited, arrived first.
    asset({
      id: "a1",
      isSelected: true,
      selectionKind: "edited",
      billedTo: "ana",
      billedAt: new Date("2026-10-01T12:00:00.000Z"),
      selectedAt: new Date("2026-10-01T12:00:00.000Z"),
      requestedAt: null,
    }),
    // Beto's joined pick on Ana's unit.
    // Ana's second claim (extra).
    asset({
      id: "a2",
      isSelected: true,
      selectionKind: "edited",
      billedTo: "ana",
      billedAt: new Date("2026-10-01T12:01:00.000Z"),
      selectedAt: new Date("2026-10-01T12:01:00.000Z"),
    }),
    // A third edited unit, over the included pool.
    asset({
      id: "a3",
      isSelected: true,
      selectionKind: "edited",
      billedTo: "beto",
      billedAt: new Date("2026-10-01T12:02:00.000Z"),
      selectedAt: new Date("2026-10-01T12:02:00.000Z"),
    }),
    // An original, whatever the pool.
    asset({
      id: "a4",
      isSelected: true,
      selectionKind: "original",
      billedTo: "beto",
      billedAt: new Date("2026-10-01T12:03:00.000Z"),
      selectedAt: new Date("2026-10-01T12:03:00.000Z"),
    }),
    // Caro's pure cart on an unclaimed asset.
    asset({ id: "a5", isSelected: false }),
    // Claimed by nobody recorded: the legacy "Sin registro" unit.
    asset({
      id: "a6",
      isSelected: true,
      selectionKind: "edited",
      billedTo: null,
      billedAt: null,
      selectedAt: null,
    }),
  );
  pickRows().push(
    pick({ assetId: "a1", userId: "ana" }),
    pick({ assetId: "a2", userId: "ana" }),
    pick({ assetId: "a3", userId: "beto" }),
    pick({ assetId: "a4", userId: "beto" }),
    pick({ assetId: "a6", userId: "beto" }),
    pick({ assetId: "a5", userId: "caro", submittedAt: null }),
  );
}

describe("buildGallerySelection — rows", () => {
  it("carries an entry for every claimed asset AND for an unclaimed one somebody has in the cart", () => {
    seedTwoPeople();

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "ana",
    });

    expect(view.entries.map((entry) => entry.assetId).sort()).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
    ]);
  });

  it("represents a cart-only asset as claim null with a `cart` pick", () => {
    seedTwoPeople();
    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: null,
    });

    const cart = view.entries.find((entry) => entry.assetId === "a5")!;
    expect(cart.claim).toBeNull();
    expect(cart.picks[0]).toMatchObject({ userId: "caro", state: "cart" });
  });

  it("reads `claimedAt` from selected_at, never requested_at — a classic claim's requested_at is null", () => {
    assetRows().push(
      asset({
        id: "classic",
        isSelected: true,
        billedTo: "ana",
        selectedAt: new Date("2026-10-02T09:00:00.000Z"),
        requestedAt: null,
      }),
    );

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: [pick({ assetId: "classic", userId: "ana" })],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "ana",
    });

    expect(view.entries[0]?.claim?.claimedAt).toBe("2026-10-02T09:00:00.000Z");
  });

  it("keeps a legacy unbilled unit in the group and the unattributed bucket, never in a person's row", () => {
    assetRows().push(
      asset({
        id: "legacy",
        isSelected: true,
        billedTo: null,
        billedAt: null,
        selectedAt: null,
      }),
    );

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: [],
      labels: new Map(),
      terms: TERMS,
      subjectId: "ana",
    });

    expect(view.entries[0]?.claim?.billedTo).toBeNull();
    expect(view.counter.group).toBe(1);
    expect(view.counter.unattributed).toBe(1);
    expect(view.counter.people).toEqual([]);
  });

  it("derives each pick's state on the server: billed, joined, degraded and cart", () => {
    assetRows().push(
      asset({ id: "claimed", isSelected: true, billedTo: "ana", billedAt: new Date(1) }),
      asset({ id: "loose", isSelected: false }),
    );
    pickRows().push(
      pick({ assetId: "claimed", userId: "ana" }),
      pick({ assetId: "claimed", userId: "beto" }),
      pick({ assetId: "claimed", userId: "caro", submittedAt: null }),
      pick({ assetId: "loose", userId: "ana", submittedAt: null }),
    );

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "ana",
    });

    const states = Object.fromEntries(
      view.entries.flatMap((entry) =>
        entry.picks.map((p) => [`${entry.assetId}:${p.userId}`, p.state]),
      ),
    );
    expect(states).toEqual({
      "claimed:ana": "billed",
      "claimed:beto": "joined",
      "claimed:caro": "degraded",
      "loose:ana": "cart",
    });
  });

  it("orders claimed entries by arrival, unclaimed ones by earliest pick, and puts the holder's pick first", () => {
    assetRows().push(
      asset({
        id: "late",
        isSelected: true,
        billedTo: "ana",
        billedAt: new Date("2026-10-01T12:02:00.000Z"),
        selectedAt: new Date("2026-10-01T12:02:00.000Z"),
      }),
      asset({
        id: "early",
        isSelected: true,
        billedTo: "beto",
        billedAt: new Date("2026-10-01T12:00:00.000Z"),
        selectedAt: new Date("2026-10-01T12:00:00.000Z"),
      }),
      asset({ id: "cart-late", isSelected: false }),
      asset({ id: "cart-early", isSelected: false }),
    );
    pickRows().push(
      pick({ assetId: "early", userId: "beto" }),
      pick({ assetId: "early", userId: "ana" }),
      pick({ assetId: "late", userId: "ana" }),
      pick({ assetId: "cart-late", userId: "caro", pickedAt: new Date(20), submittedAt: null }),
      pick({ assetId: "cart-early", userId: "caro", pickedAt: new Date(10), submittedAt: null }),
    );

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: null,
    });

    expect(view.entries.map((entry) => entry.assetId)).toEqual([
      "early",
      "late",
      "cart-early",
      "cart-late",
    ]);
    // The billed holder (beto) comes first, even though ana's pick arrival
    // order in the fixture is not sorted.
    expect(view.entries[0]?.picks.map((p) => p.userId)).toEqual(["beto", "ana"]);
  });

  it("carries the charge attributeQuota computed, so the client never re-derives the included split", () => {
    seedTwoPeople();

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: null,
    });

    const charges = Object.fromEntries(
      view.entries
        .filter((entry) => entry.claim)
        .map((entry) => [entry.assetId, entry.claim!.charge]),
    );
    expect(charges).toEqual({
      a6: "included",
      a1: "included",
      a2: "extra",
      a3: "extra",
      a4: "original",
    });
  });

  it("returns the same quota computeQuota produces over the claimed rows, with a tiered snapshot", () => {
    const terms = {
      includedPhotosSnapshot: 1,
      extraPhotoPriceCopSnapshot: 15_000,
      extraPhotoPriceTiersSnapshot: [
        { minExtras: 1, priceCop: 15_000 },
        { minExtras: 3, priceCop: 13_000 },
      ],
      originalPhotoPriceCopSnapshot: 2_000,
    };
    assetRows().push(
      asset({ id: "e1", isSelected: true, billedAt: new Date(1) }),
      asset({ id: "e2", isSelected: true, billedAt: new Date(2) }),
      asset({ id: "e3", isSelected: true, billedAt: new Date(3) }),
      asset({ id: "e4", isSelected: true, billedAt: new Date(4) }),
      asset({ id: "o1", isSelected: true, selectionKind: "original", billedAt: new Date(5) }),
    );

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: [],
      labels: new Map(),
      terms,
      subjectId: null,
    });

    expect(view.quota).toEqual(computeQuota(4, 1, terms));
  });
});

describe("buildGallerySelection — counter invariants", () => {
  it("gives an admin without a subject counter.viewer === null", () => {
    seedTwoPeople();
    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: null,
    });

    expect(view.counter.viewer).toBeNull();
  });

  it("partitions the subject's picks by state, and agrees with the per-person units (P/S/Y)", () => {
    seedTwoPeople();

    for (const subject of ["ana", "beto", "caro"] as const) {
      const view = buildGallerySelection({
        rows: assetRows() as AssetRow[],
        picks: pickRows() as PickRow[],
        labels: labelsOf(userRows() as never),
        terms: TERMS,
        subjectId: subject,
      });
      const ownPicks = view.entries.flatMap((entry) =>
        entry.picks.filter((p) => p.userId === subject),
      );
      const viewer = view.counter.viewer!;

      // (P) partition
      expect(viewer.yours + viewer.shared + viewer.toSend).toBe(ownPicks.length);
      // (S) sum
      expect(view.counter.group).toBe(view.quota.selected);
      expect(view.counter.group).toBe(
        view.counter.people.reduce((sum, person) => sum + person.units, 0) +
          view.counter.unattributed,
      );
      // (Y) agreement, for every member who holds a unit
      for (const person of view.counter.people) {
        if (person.units === 0) continue;
        const personView = buildGallerySelection({
          rows: assetRows() as AssetRow[],
          picks: pickRows() as PickRow[],
          labels: labelsOf(userRows() as never),
          terms: TERMS,
          subjectId: person.userId,
        });
        expect(personView.counter.viewer!.yours).toBe(person.units);
      }
    }
  });

  it("labels people with name ?? email and keeps a removed member's submitted pick at their name", () => {
    assetRows().push(
      asset({ id: "a1", isSelected: true, billedTo: "beto", billedAt: new Date(1) }),
    );
    pickRows().push(pick({ assetId: "a1", userId: "beto" }));

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "beto",
    });

    expect(view.entries[0]?.claim?.billedTo).toEqual({ id: "beto", label: "beto@example.com" });
    expect(view.entries[0]?.picks[0]?.label).toBe("beto@example.com");
    expect(view.counter.people[0]).toMatchObject({ label: "beto@example.com" });
  });

  it("names a picker whose user row is gone 'Sin registro' rather than dropping the pick", () => {
    assetRows().push(asset({ id: "a1", isSelected: false }));
    pickRows().push(pick({ assetId: "a1", userId: "ghost", submittedAt: null }));

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: new Map(),
      terms: TERMS,
      subjectId: null,
    });

    expect(view.entries[0]?.picks[0]?.label).toBe("Sin registro");
  });

  it("carries no R2 key, URL, gallery id or session id", () => {
    seedTwoPeople();
    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "ana",
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("proofKey");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain(GALLERY);
  });
});

describe("buildGallerySelection — seeded property test", () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("holds (P), (S) and (Y) on 300 random committed states", () => {
    const rng = mulberry32(261);
    const people = ["ana", "beto", "caro"] as const;
    const kinds: SelectionKind[] = ["edited", "original"];

    for (let run = 0; run < 300; run += 1) {
      assetRows().length = 0;
      pickRows().length = 0;
      const used = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const id = `p${i}`;
        const claimed = rng() < 0.65;
        const holder = rng() < 0.1 ? null : people[Math.floor(rng() * people.length)]!;
        const kind = kinds[Math.floor(rng() * kinds.length)]!;
        if (claimed) {
          assetRows().push(
            asset({
              id,
              isSelected: true,
              selectionKind: kind,
              billedTo: holder,
              billedAt: holder === null ? null : new Date(1_000 + i * 10),
              selectedAt: holder === null ? null : new Date(1_000 + i * 10),
            }),
          );
        } else {
          assetRows().push(asset({ id, isSelected: false }));
        }

        for (const person of people) {
          const key = `${id}:${person}`;
          if (used.has(key)) continue;
          const rolls = rng();
          if (claimed && person === holder) {
            pickRows().push(
              pick({ assetId: id, userId: person, kind, submittedAt: new Date(2_000 + i) }),
            );
            used.add(key);
          } else if (claimed && rolls < 0.3) {
            pickRows().push(
              pick({
                assetId: id,
                userId: person,
                kind: kinds[Math.floor(rng() * 2)]!,
                submittedAt: rng() < 0.5 ? new Date(2_000 + i) : null,
              }),
            );
            used.add(key);
          } else if (!claimed && rolls < 0.3) {
            pickRows().push(
              pick({
                assetId: id,
                userId: person,
                kind: kinds[Math.floor(rng() * 2)]!,
                submittedAt: null,
              }),
            );
            used.add(key);
          }
        }
      }

      for (const subject of [...people, null] as const) {
        const view = buildGallerySelection({
          rows: assetRows() as AssetRow[],
          picks: pickRows() as PickRow[],
          labels: labelsOf(userRows() as never),
          terms: TERMS,
          subjectId: subject,
        });
        // (S)
        expect(view.counter.group).toBe(view.quota.selected);
        expect(view.counter.group).toBe(
          view.counter.people.reduce((sum, person) => sum + person.units, 0) +
            view.counter.unattributed,
        );
        // (P)
        if (subject === null) {
          expect(view.counter.viewer).toBeNull();
          continue;
        }
        const own = view.entries.flatMap((entry) =>
          entry.picks.filter((p) => p.userId === subject),
        ).length;
        const viewer = view.counter.viewer!;
        expect(viewer.yours + viewer.shared + viewer.toSend).toBe(own);
        // (Y)
        for (const person of view.counter.people) {
          if (person.userId !== subject) continue;
          expect(viewer.yours).toBe(person.units);
        }
      }
    }
  });
});

describe("getGallerySelection", () => {
  it("reads in a read-only, repeatable-read transaction", async () => {
    seedTwoPeople();
    const spy = vi.spyOn(fake, "transaction");

    await getGallerySelection(GALLERY, TERMS, "ana");

    expect(spy).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("never touches users when nothing is claimed or picked", async () => {
    assetRows().push(asset({ id: "a1" }));
    userRows().length = 0;

    const view = await getGallerySelection(GALLERY, TERMS, null);

    expect(view.entries).toEqual([]);
    expect(fake.__log.filter((entry) => entry === "select").length).toBe(3);
  });

  it("never includes another gallery's assets or picks", async () => {
    assetRows().push(
      asset({ id: "mine", isSelected: true, billedTo: "ana", billedAt: new Date(1) }),
      asset({
        id: "other",
        galleryId: OTHER_GALLERY,
        isSelected: true,
        billedTo: "ana",
        billedAt: new Date(1),
      } as never),
    );
    pickRows().push(pick({ assetId: "mine", userId: "ana" }), {
      ...pick({ assetId: "other", userId: "ana" }),
      galleryId: OTHER_GALLERY,
    });

    const view = await getGallerySelection(GALLERY, TERMS, "ana");

    expect(view.entries.map((entry) => entry.assetId)).toEqual(["mine"]);
  });

  it("honours the subject in the counter and the lock", async () => {
    seedTwoPeople();
    memberRows().push(
      {
        galleryId: GALLERY,
        userId: "ana",
        removedAt: null,
        selectionLockedAt: null,
        selectionSubmittedAt: new Date(1),
        selectionLockedBy: null,
      },
      {
        galleryId: GALLERY,
        userId: "beto",
        removedAt: null,
        selectionLockedAt: new Date(2),
        selectionSubmittedAt: null,
        selectionLockedBy: "admin",
      },
    );

    const view = await getGallerySelection(GALLERY, TERMS, "ana");

    expect(view.lock.viewerLock).toBeNull();
    expect(view.lock.viewerSubmittedAt).toBe(new Date(1).toISOString());
    expect(view.lock.adminLockedPickerIds).toEqual(["beto"]);
    expect(view.counter.viewer?.yours).toBe(2);
  });
});

describe("type parity", () => {
  it("SelectionPickState is exactly PickStatus", () => {
    expectTypeOf<SelectionPickState>().toEqualTypeOf<PickStatus>();
  });
});

// `unitsOf`/`attributeQuota` are import-checked above; this pins the charge
// values against the same function the builder uses.
it("charge comes straight from attributeQuota's units", () => {
  seedTwoPeople();
  const units = attributeQuota(unitsOf(assetRows() as AssetRow[]), TERMS);
  expect(units.units.map((unit) => [unit.assetId, unit.charge])).toEqual([
    ["a6", "included"],
    ["a1", "included"],
    ["a2", "extra"],
    ["a3", "extra"],
    ["a4", "original"],
  ]);
});
