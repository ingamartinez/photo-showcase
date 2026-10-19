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
import {
  buildGallerySelection,
  getDashboardSelection,
  getGallerySelection,
  partitionByPerson,
  type DashboardSelectionGallery,
} from "@/lib/gallery-selection";
import { unitsOf, type AssetRow, type PickRow } from "@/lib/pick-plans";
import { computeQuota, type GalleryQuotaSnapshot } from "@/lib/quota";
import { attributeQuota, type AttributionShare } from "@/lib/quota-attribution";
import type { SelectionKind, SelectionPickState } from "@/lib/selection-snapshot";
import type { PickStatus } from "@/lib/pick-resolution";

const fake = db as unknown as FakeDb;
const assetRows = () => fake.__tables.get(assets)!;
const pickRows = () => fake.__tables.get(assetPicks)!;
const userRows = () => fake.__tables.get(users)!;
const memberRows = () => fake.__tables.get(galleryClients)!;

const GALLERY = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY = "22222222-2222-4222-8222-222222222222";

const PROJECTION_NOW = new Date("2026-10-18T12:00:00.000Z");

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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
        allowsOriginal: true,
        now: PROJECTION_NOW,
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
          allowsOriginal: true,
          now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
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
      allowsOriginal: true,
      now: PROJECTION_NOW,
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("proofKey");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain(GALLERY);
  });
});

/** The Σ invariant at the WIRE layer (task #264), mirroring
 * quota-attribution.test.ts's own helper one level up: what the browser
 * receives must add up to the gallery totals it also receives, exactly, for
 * every field. Shared by the dedicated money tests and the 300-state property
 * test below. */
function expectWireMoneySumsToQuota(view: ReturnType<typeof buildGallerySelection>) {
  const total = (field: keyof AttributionShare) =>
    view.counter.people.reduce((sum, person) => sum + person.share[field], 0) +
    view.counter.unattributedShare[field];

  expect(total("included")).toBe(view.quota.selectedEdited - view.quota.extras);
  expect(total("extras")).toBe(view.quota.extras);
  expect(total("originals")).toBe(view.quota.originals);
  expect(total("extrasSurchargeCop")).toBe(view.quota.extrasSurchargeCop);
  expect(total("originalsSurchargeCop")).toBe(view.quota.originalsSurchargeCop);
  expect(total("surchargeCop")).toBe(view.quota.surchargeCop);
}

// Task #264 — the money the COUNTER carries, per person. The server splits it
// (attributeQuota), this is about the WIRE: every share the client renders
// must be the server's own bucket, so a client can print rows and a total that
// agree without doing arithmetic of its own.
describe("buildGallerySelection — the per-person money wire (task #264)", () => {
  it("splits the gallery's money by ARRIVAL: the first claimer keeps the included slots", () => {
    // Included 4, extra at 5.000. Ana claims three edited units, then Beto
    // three. Ana keeps all three included slots she took; Beto gets the fourth
    // included one and pays for two extras. If the split ran on any other
    // order — tray order, label order, "who has more" — Beto would pay
    // nothing and Ana 10.000, which is exactly what these two `toEqual`s
    // reject.
    const terms = {
      includedPhotosSnapshot: 4,
      extraPhotoPriceCopSnapshot: 5_000,
      extraPhotoPriceTiersSnapshot: null,
      originalPhotoPriceCopSnapshot: 2_000,
    };
    const claims = [
      { id: "a1", who: "ana", minute: 0 },
      { id: "a2", who: "ana", minute: 1 },
      { id: "a3", who: "ana", minute: 2 },
      { id: "a4", who: "beto", minute: 3 },
      { id: "a5", who: "beto", minute: 4 },
      { id: "a6", who: "beto", minute: 5 },
    ] as const;
    for (const { id, who, minute } of claims) {
      const at = new Date(Date.UTC(2026, 9, 1, 12, minute));
      assetRows().push(
        asset({ id, isSelected: true, billedTo: who, billedAt: at, selectedAt: at }),
      );
      pickRows().push(pick({ assetId: id, userId: who }));
    }

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms,
      subjectId: "ana",
      allowsOriginal: true,
      now: PROJECTION_NOW,
    });

    expect(view.quota.extras).toBe(2);
    expect(view.counter.people.find((person) => person.userId === "ana")?.share).toEqual({
      included: 3,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
    });
    expect(view.counter.people.find((person) => person.userId === "beto")?.share).toEqual({
      included: 1,
      extras: 2,
      originals: 0,
      extrasSurchargeCop: 10_000,
      originalsSurchargeCop: 0,
      surchargeCop: 10_000,
    });
    expectWireMoneySumsToQuota(view);
  });

  it("adds up to the gallery's own totals — flat tiers, a volume scale, and a legacy unit", () => {
    seedTwoPeople();
    const settle = (terms: GalleryQuotaSnapshot) =>
      buildGallerySelection({
        rows: assetRows() as AssetRow[],
        picks: pickRows() as PickRow[],
        labels: labelsOf(userRows() as never),
        terms,
        subjectId: "ana",
        allowsOriginal: true,
        now: PROJECTION_NOW,
      });

    const flat = settle(TERMS);
    expectWireMoneySumsToQuota(flat);
    // The fixture's a6 is a legacy claim (billedTo null, billedAt null) and
    // arrives FIRST, so its share is a real one, not a zero placeholder.
    expect(flat.counter.unattributedShare.included).toBe(1);
    expect(flat.counter.unattributed).toBe(1);

    const tiered = settle({
      includedPhotosSnapshot: 0,
      extraPhotoPriceCopSnapshot: 15_000,
      extraPhotoPriceTiersSnapshot: [
        { minExtras: 1, priceCop: 15_000 },
        { minExtras: 3, priceCop: 13_000 },
        { minExtras: 5, priceCop: 11_000 },
      ],
      originalPhotoPriceCopSnapshot: 2_000,
    });
    expect(tiered.quota.extraUnitPriceCop).not.toBe(tiered.quota.extraPhotoPriceCopSnapshot);
    expectWireMoneySumsToQuota(tiered);
  });

  it("gives each row a share whose units are the server's own count, and the subject `yours`", () => {
    seedTwoPeople();

    for (const subject of ["ana", "beto"] as const) {
      const view = buildGallerySelection({
        rows: assetRows() as AssetRow[],
        picks: pickRows() as PickRow[],
        labels: labelsOf(userRows() as never),
        terms: TERMS,
        subjectId: subject,
        allowsOriginal: true,
        now: PROJECTION_NOW,
      });

      // Every row: the money's unit count IS the row's count — the client
      // renders `units` for "N fotos", so the two can never drift.
      for (const person of view.counter.people) {
        expect(person.share.included + person.share.extras + person.share.originals).toBe(
          person.units,
        );
      }
      // And for the subject, the same number the four-number counter calls
      // "tuyas": the row must never say something the counter contradicts.
      const own = view.counter.people.find((person) => person.userId === subject);
      expect(own?.units).toBe(view.counter.viewer?.yours);
    }
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
          allowsOriginal: true,
          now: PROJECTION_NOW,
        });
        // Task #264 — the money the browser receives still adds up to the
        // money it also receives as the gallery total, on every state.
        expectWireMoneySumsToQuota(view);
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

describe("buildGallerySelection — the submit projection (task #268)", () => {
  // Ana holds an original with no final (X, escalable), an edited unit (Y) and
  // an original WITH a final (W, frozen by decision 15). Beto has edited carts
  // on all three plus a free asset (Z). What Beto's submit will do is: claim Z
  // and escalate X under his name (2), join Y and be blocked on W (2).
  function seedProjection() {
    const at = (minute: number) => new Date(`2026-10-01T12:0${minute}:00.000Z`);
    assetRows().push(
      asset({
        id: "x",
        isSelected: true,
        selectionKind: "original",
        billedTo: "ana",
        billedAt: at(0),
        selectedAt: at(0),
      }),
      asset({
        id: "y",
        isSelected: true,
        selectionKind: "edited",
        billedTo: "ana",
        billedAt: at(1),
        selectedAt: at(1),
      }),
      asset({
        id: "w",
        isSelected: true,
        selectionKind: "original",
        billedTo: "ana",
        billedAt: at(2),
        selectedAt: at(2),
        finalKey: "final/w.jpg",
      }),
      asset({ id: "z" }),
    );
    pickRows().push(
      pick({ assetId: "x", userId: "ana", kind: "original" }),
      pick({ assetId: "y", userId: "ana" }),
      pick({ assetId: "w", userId: "ana", kind: "original" }),
      pick({ assetId: "x", userId: "beto", submittedAt: null }),
      pick({ assetId: "y", userId: "beto", submittedAt: null }),
      pick({ assetId: "w", userId: "beto", submittedAt: null }),
      pick({ assetId: "z", userId: "beto", submittedAt: null }),
    );
  }

  it("projects the viewer's own claim/escalate/join/blocked counts, per person", () => {
    seedProjection();

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "beto",
      allowsOriginal: true,
      now: PROJECTION_NOW,
    });
    const projection = view.counter.viewer!.projection;

    expect(projection.passToYou).toBe(2);
    expect(projection.alreadyRequested).toBe(2);
    // Every cart pick resolves to exactly one of the two outcomes.
    expect(projection.passToYou + projection.alreadyRequested).toBe(view.counter.viewer!.toSend);
  });

  it("prices the viewer's AFTER share with the same attribution as the write", () => {
    seedProjection();
    const rows = assetRows() as AssetRow[];
    const picks = pickRows() as PickRow[];

    const view = buildGallerySelection({
      rows,
      picks,
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "beto",
      allowsOriginal: true,
      now: PROJECTION_NOW,
    });
    const projection = view.counter.viewer!.projection;
    // Beto after: Z included (first arrival among his units), X extra, Y
    // joined (Ana's), W blocked (Ana's). One included + one extra.
    expect(projection.after).toEqual({
      included: 1,
      extras: 1,
      originals: 0,
      extrasSurchargeCop: 5_000,
      originalsSurchargeCop: 0,
      surchargeCop: 5_000,
    });
    expect(projection.extraUnitPriceCop).toBe(5_000);
  });

  it("exposes canEscalate from the final's absence, and never for an edited unit", () => {
    seedProjection();

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "beto",
      allowsOriginal: true,
      now: PROJECTION_NOW,
    });
    const escalation = Object.fromEntries(
      view.entries.map((entry) => [entry.assetId, entry.claim?.canEscalate]),
    );

    expect(escalation).toEqual({ x: true, y: false, w: false, z: undefined });
  });

  it("projects zero counts and the CURRENT share when the viewer has no cart", () => {
    seedProjection();

    const view = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: "ana",
      allowsOriginal: true,
      now: PROJECTION_NOW,
    });
    const projection = view.counter.viewer!.projection;
    const current = view.counter.people.find((person) => person.userId === "ana")!.share;

    expect(projection.passToYou).toBe(0);
    expect(projection.alreadyRequested).toBe(0);
    expect(projection.after).toEqual(current);
  });
});

describe("getGallerySelection", () => {
  it("reads in a read-only, repeatable-read transaction", async () => {
    seedTwoPeople();
    const spy = vi.spyOn(fake, "transaction");

    await getGallerySelection(GALLERY, TERMS, "ana", { allowsOriginal: true });

    expect(spy).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("never touches users when nothing is claimed or picked", async () => {
    assetRows().push(asset({ id: "a1" }));
    userRows().length = 0;

    const view = await getGallerySelection(GALLERY, TERMS, null, { allowsOriginal: true });

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

    const view = await getGallerySelection(GALLERY, TERMS, "ana", { allowsOriginal: true });

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

    const view = await getGallerySelection(GALLERY, TERMS, "ana", { allowsOriginal: true });

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

// ---------------------------------------------------------------------------
// Epic #250, task #263 (S8) — the dashboard's per-person read.
//
// `partitionByPerson` is the ONLY place the dashboard's four numbers are
// computed, and it is computed off the same `buildGallerySelection` entries
// the client surfaces render. The first block proves it agrees with the
// client's own counter for every member; the second covers the read itself,
// carrying over the two cases that used to live in
// `galleries.client-selections.test.ts` (deleted by this task) — one tally per
// ACTIVE member, and an edited count that is per person, not per gallery.
// ---------------------------------------------------------------------------

const DASHBOARD_TERMS: DashboardSelectionGallery = {
  id: GALLERY,
  allowsOriginalSelection: true,
  ...TERMS,
};

describe("partitionByPerson — the dashboard and the client counter agree", () => {
  it("equals buildGallerySelection({subjectId: m}).counter.viewer for every member", () => {
    seedTwoPeople();

    const entries = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: null,
      allowsOriginal: true,
      now: PROJECTION_NOW,
    }).entries;
    const partition = partitionByPerson(entries, assetRows() as AssetRow[]);

    for (const subject of ["ana", "beto", "caro"] as const) {
      const viewer = buildGallerySelection({
        rows: assetRows() as AssetRow[],
        picks: pickRows() as PickRow[],
        labels: labelsOf(userRows() as never),
        terms: TERMS,
        subjectId: subject,
        allowsOriginal: true,
        now: PROJECTION_NOW,
      }).counter.viewer!;
      const person = partition.get(subject) ?? { yours: 0, shared: 0, edited: 0, toSend: 0 };

      const { projection: _projection, ...viewerCounts } = viewer;
      expect({ yours: person.yours, shared: person.shared, toSend: person.toSend }).toEqual(
        viewerCounts,
      );
    }
  });

  it("counts an EDITED unit per person, off that person's billed picks only", () => {
    // Two people, finals on only SOME of each one's units. A count taken over
    // the whole gallery, or credited to the wrong person, cannot pass.
    assetRows().push(
      asset({
        id: "ana1",
        isSelected: true,
        billedTo: "ana",
        billedAt: new Date(1),
        finalKey: "final/ana1.jpg",
      }),
      asset({ id: "ana2", isSelected: true, billedTo: "ana", billedAt: new Date(2) }),
      asset({
        id: "beto1",
        isSelected: true,
        billedTo: "beto",
        billedAt: new Date(3),
        finalKey: "final/beto1.jpg",
      }),
      asset({ id: "beto2", isSelected: true, billedTo: "beto", billedAt: new Date(4) }),
      asset({ id: "beto3", isSelected: true, billedTo: "beto", billedAt: new Date(5) }),
    );
    pickRows().push(
      pick({ assetId: "ana1", userId: "ana" }),
      pick({ assetId: "ana2", userId: "ana" }),
      pick({ assetId: "ana1", userId: "beto" }),
      pick({ assetId: "beto1", userId: "beto" }),
      pick({ assetId: "beto2", userId: "beto" }),
      pick({ assetId: "beto3", userId: "beto" }),
      // A cart pick is "por enviar", never "pedida".
      pick({ assetId: "ana2", userId: "caro", submittedAt: null }),
    );

    const entries = buildGallerySelection({
      rows: assetRows() as AssetRow[],
      picks: pickRows() as PickRow[],
      labels: labelsOf(userRows() as never),
      terms: TERMS,
      subjectId: null,
      allowsOriginal: true,
      now: PROJECTION_NOW,
    }).entries;
    const partition = partitionByPerson(entries, assetRows() as AssetRow[]);

    expect(partition.get("ana")).toEqual({ yours: 2, shared: 0, edited: 1, toSend: 0 });
    // Beto holds three units (one with a final) and is joined on Ana's first.
    expect(partition.get("beto")).toEqual({ yours: 3, shared: 1, edited: 1, toSend: 0 });
    // A degraded cart pick is still "por enviar" (decision 19).
    expect(partition.get("caro")).toEqual({ yours: 0, shared: 0, edited: 0, toSend: 1 });
  });
});

describe("getDashboardSelection", () => {
  it("reads in one read-only, repeatable-read transaction", async () => {
    seedTwoPeople();
    const spy = vi.spyOn(fake, "transaction");

    await getDashboardSelection(DASHBOARD_TERMS);

    expect(spy).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("returns one tally + preview per ACTIVE member, and never one for a removed member", async () => {
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
        removedAt: new Date(2),
        selectionLockedAt: new Date(2),
        selectionSubmittedAt: null,
        selectionLockedBy: "admin",
      },
    );

    const view = await getDashboardSelection(DASHBOARD_TERMS);

    expect(view.members.map((member) => member.userId)).toEqual(["ana"]);
    expect(Object.keys(view.previewByClient)).toEqual(["ana"]);
    // Ana is billed on a1 and a2 (one included, one extra under TERMS).
    expect(view.people.find((person) => person.userId === "ana")).toMatchObject({
      label: "Ana Pérez",
      yours: 2,
      shared: 0,
    });
  });

  it("labels a REMOVED holder instead of leaving a bare id in the before/after", async () => {
    // Decision 17: a removed member's submitted picks stay attributed to them.
    // `labelsFor` must therefore name every picker/holder, not only the active
    // ones — otherwise the delta would read "caro: …" with a uuid.
    assetRows().push(
      asset({ id: "gone1", isSelected: true, billedTo: "caro", billedAt: new Date(1) }),
    );
    pickRows().push(pick({ assetId: "gone1", userId: "caro" }));
    memberRows().push({
      galleryId: GALLERY,
      userId: "caro",
      removedAt: new Date(2),
      selectionLockedAt: null,
      selectionSubmittedAt: null,
      selectionLockedBy: null,
    });

    const view = await getDashboardSelection(DASHBOARD_TERMS);

    expect(view.labels.caro).toBe("Caro Gil");
    expect(view.people.find((person) => person.userId === "caro")?.label).toBe("Caro Gil");
    expect(view.members.map((member) => member.userId)).not.toContain("caro");
  });
});
