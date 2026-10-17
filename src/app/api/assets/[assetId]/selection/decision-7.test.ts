import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import type { GalleryQuotaSnapshot } from "@/lib/quota";

// Epic #250, task #259 (S4) — decision 7 THROUGH THE REAL ROUTES.
//
// The S3 property test (`client-actions.property.test.ts`) drives the pure
// functions. This one drives the two handlers that will actually run in
// production, over ONE fake db: the client PATCH and the submit POST, with the
// REAL `loadOwnedAsset`, `isGalleryOwner`, `claimCart` and `gatePickEdit`
// (only auth, the email and the notify are mocked). It catches a route that
// bypasses the gate, forgets `arrivalAfter`, samples `now` before the lock, or
// writes `assets` from PATCH.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/admin-notification-email", () => ({
  sendSubmissionNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", async () => {
  const { galleries, assets, users, galleryClients, assetPicks } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, assets, users, galleryClients, assetPicks]);
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        assets: fake.__tables.get(assets)!,
        users: fake.__tables.get(users)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assetPicks: fake.__tables.get(assetPicks)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const PEOPLE = ["client-a", "client-b", "client-c"] as const;

// Valid UUIDs: both routes validate their path id with `z.uuid()`.
const ASSET_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
];

const FLAT: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 1,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

const TIERED: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 2,
  extraPhotoPriceCopSnapshot: 15_000,
  extraPhotoPriceTiersSnapshot: [
    { minExtras: 1, priceCop: 15_000 },
    { minExtras: 3, priceCop: 12_000 },
  ],
  originalPhotoPriceCopSnapshot: 2_000,
};

type Rows = {
  galleries: Row[];
  assets: Row[];
  users: Row[];
  galleryClients: Row[];
  assetPicks: Row[];
};

async function rowsDb(): Promise<{ db: { __rows: Rows } }> {
  return (await import("@/lib/db")) as unknown as { db: { __rows: Rows } };
}

async function reset(
  overrides: {
    snapshot?: GalleryQuotaSnapshot;
    assets?: Row[];
    picks?: Row[];
  } = {},
) {
  const { db } = await rowsDb();
  for (const list of Object.values(db.__rows)) list.length = 0;
  const snapshot = overrides.snapshot ?? FLAT;
  db.__rows.galleries.push({
    id: GALLERY_ID,
    status: "proofing",
    rollingDelivery: true,
    publicSlug: "decision-7",
    includedPhotosSnapshot: snapshot.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: snapshot.extraPhotoPriceCopSnapshot,
    extraPhotoPriceTiersSnapshot: snapshot.extraPhotoPriceTiersSnapshot,
    originalPhotoPriceCopSnapshot: snapshot.originalPhotoPriceCopSnapshot,
    allowsOriginalSelection: true,
  });
  for (const userId of PEOPLE) {
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId,
      removedAt: null,
      selectionLockedAt: null,
      selectionSubmittedAt: null,
    });
    db.__rows.users.push({ id: userId, name: userId, email: `${userId}@x.test`, role: "client" });
  }
  db.__rows.users.push({ id: "admin-1", name: "Admin", email: "admin@x.test", role: "admin" });
  db.__rows.assets.push(...(overrides.assets ?? []));
  db.__rows.assetPicks.push(...(overrides.picks ?? []));
  return db;
}

function sessionOf(userId: string): Session {
  return {
    user: { id: userId, role: "client", email: `${userId}@x.test` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function assetRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    galleryId: GALLERY_ID,
    originalFilename: `${id}.JPG`,
    proofKey: `${id}.webp`,
    proofWidth: 100,
    proofHeight: 100,
    isSelected: false,
    selectedAt: null,
    requestedAt: null,
    billedTo: null,
    billedAt: null,
    selectionKind: "edited",
    finalKey: null,
    isEdited: false,
    sortOrder: 0,
    ...overrides,
  };
}

function pickRow(assetId: string, userId: string, overrides: Row = {}): Row {
  return {
    assetId,
    galleryId: GALLERY_ID,
    userId,
    kind: "edited",
    pickedAt: new Date("2026-10-17T00:00:00.000Z"),
    submittedAt: null,
    ...overrides,
  };
}

async function patch(actor: string, assetId: string, body: Record<string, unknown>) {
  authMock.mockResolvedValue(sessionOf(actor));
  const { PATCH } = await import("@/app/api/assets/[assetId]/selection/route");
  const request = new NextRequest(`http://localhost:3300/api/assets/${assetId}/selection`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await PATCH(request, { params: Promise.resolve({ assetId }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function submit(actor: string) {
  authMock.mockResolvedValue(sessionOf(actor));
  const { POST } = await import("@/app/api/galleries/[galleryId]/submit-selection/route");
  const request = new NextRequest(
    `http://localhost:3300/api/galleries/${GALLERY_ID}/submit-selection`,
    { method: "POST" },
  );
  const response = await POST(request, { params: Promise.resolve({ galleryId: GALLERY_ID }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function units(assetRows: Row[]) {
  return assetRows
    .filter((row) => row.isSelected)
    .map((row) => ({
      assetId: row.id as string,
      billedTo: row.billedTo as string | null,
      kind: row.selectionKind as "edited" | "original",
      billedAt: row.billedAt as Date | null,
    }));
}

function expectSigma(
  att: ReturnType<typeof import("@/lib/quota-attribution").attributeQuota>,
  message: string,
) {
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

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  authMock.mockReset();
});

describe("decision 7 through the routes — scripted three-person run (D7-a)", () => {
  const [X, Y, Z, W] = ASSET_IDS as [string, string, string, string];
  const T = (n: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, n));

  it.each([
    ["FLAT", FLAT],
    ["DEFAULT", TIERED],
  ] as const)("%s", async (_name, snapshot) => {
    const { attributeQuota, shareFor } = await import("@/lib/quota-attribution");
    // 1. A holds x (original) and y (edited, included); C holds z (edited).
    const db = await reset({
      snapshot,
      assets: [
        assetRow(X, {
          isSelected: true,
          billedTo: "client-a",
          selectionKind: "original",
          billedAt: T(1),
          selectedAt: T(1),
        }),
        assetRow(Y, {
          isSelected: true,
          billedTo: "client-a",
          selectionKind: "edited",
          billedAt: T(2),
          selectedAt: T(2),
        }),
        assetRow(Z, {
          isSelected: true,
          billedTo: "client-c",
          selectionKind: "edited",
          billedAt: T(3),
          selectedAt: T(3),
        }),
        assetRow(W),
      ],
      picks: [
        pickRow(X, "client-a", { submittedAt: T(1) }),
        pickRow(Y, "client-a", { submittedAt: T(2) }),
        pickRow(Z, "client-c", { submittedAt: T(3) }),
      ],
    });

    const before = attributeQuota(units(db.__rows.assets), snapshot);
    expectSigma(before, "seed");

    // 2. B's PATCH sequence. Each is a PATCH, so `assets` must not move.
    const patchAssetsBefore = structuredClone(db.__rows.assets);
    expect(await patch("client-b", Y, { selected: true, selectionKind: "original" })).toMatchObject(
      { status: 200 },
    );
    expect(await patch("client-b", Y, { selectionKind: "edited" })).toMatchObject({ status: 200 });
    expect(await patch("client-b", Y, { selected: false })).toMatchObject({ status: 200 });
    expect(await patch("client-b", W, { selected: true })).toMatchObject({ status: 200 });
    expect(await patch("client-b", X, { selected: true })).toMatchObject({ status: 200 });
    expect(db.__rows.assets).toEqual(patchAssetsBefore);

    // 3. A tie with the latest billedAt: B's submit must still arrive strictly
    // later, so A's included slot and C's share are safe.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T(3));
    const submitted = await submit("client-b");
    vi.useRealTimers();
    expect(submitted.status).toBe(200);
    expect(submitted.body.pickOutcomes).toEqual({
      claimed: 1,
      escalated: 1,
      joined: 0,
      escalationBlocked: 0,
    });

    const afterB = attributeQuota(units(db.__rows.assets), snapshot);
    expectSigma(afterB, "after B submit");
    // A loses x's original charge; C is untouched.
    expect(shareFor(afterB, "client-a").surchargeCop).toBeLessThan(
      shareFor(before, "client-a").surchargeCop,
    );
    expect(shareFor(afterB, "client-c")).toEqual(shareFor(before, "client-c"));
    expect(shareFor(afterB, "client-a").surchargeCop).toBeLessThanOrEqual(
      shareFor(before, "client-a").surchargeCop,
    );

    // 4. C inserts w (claimed by B now) and submits: joined, A and B unchanged.
    const assetsBeforeC = structuredClone(db.__rows.assets);
    expect(await patch("client-c", W, { selected: true })).toMatchObject({ status: 200 });
    const cSubmit = await submit("client-c");
    expect(cSubmit.body.pickOutcomes).toEqual({
      claimed: 0,
      escalated: 0,
      joined: 1,
      escalationBlocked: 0,
    });
    const afterC = attributeQuota(units(db.__rows.assets), snapshot);
    expectSigma(afterC, "after C submit");
    expect(db.__rows.assets).toEqual(assetsBeforeC);
    expect(shareFor(afterC, "client-a")).toEqual(shareFor(afterB, "client-a"));
    expect(shareFor(afterC, "client-b")).toEqual(shareFor(afterB, "client-b"));

    // 5. A, already submitted, may not remove x: already_requested.
    const remove = await patch("client-a", X, { selected: false });
    expect(remove.status).toBe(409);
    expect(remove.body).toEqual({ error: "already_requested" });
    expect(db.__rows.assets).toEqual(assetsBeforeC);
  });
});

describe("decision 7 through the routes — seeded random walk (D7-b)", () => {
  const SEED = 259;
  const RUNS = 40;
  const STEPS = 25;

  it("never raises a non-actor's surcharge and exercises every outcome", async () => {
    const { attributeQuota, shareFor } = await import("@/lib/quota-attribution");
    const counters = { claimed: 0, escalated: 0, joined: 0, escalationBlocked: 0 };
    let alreadyRequested = 0;
    let pickDegraded = 0;

    for (let run = 0; run < RUNS; run += 1) {
      const rng = mulberry32(SEED + run);
      const snapshot = rng() < 0.5 ? FLAT : TIERED;

      // Seed a small claimed surface, including one legacy unattributed claim.
      const seededAssets: Row[] = [];
      const seededPicks: Row[] = [];
      for (const [index, assetId] of ASSET_IDS.entries()) {
        const claimRoll = rng();
        const finalKey = rng() < 0.2 ? `${assetId}-final.jpg` : null;
        if (index === ASSET_IDS.length - 1 && rng() < 0.5) {
          seededAssets.push(
            assetRow(assetId, {
              isSelected: true,
              billedTo: null,
              selectionKind: rng() < 0.5 ? "edited" : "original",
              billedAt: new Date(Date.UTC(2026, 9, 16, 12, 0, index)),
              finalKey,
            }),
          );
        } else if (claimRoll < 0.3) {
          const owner = PEOPLE[Math.floor(rng() * PEOPLE.length)]!;
          seededAssets.push(
            assetRow(assetId, {
              isSelected: true,
              billedTo: owner,
              selectionKind: rng() < 0.5 ? "edited" : "original",
              billedAt: new Date(Date.UTC(2026, 9, 16, 12, 0, index)),
              finalKey,
            }),
          );
          seededPicks.push(
            pickRow(assetId, owner, {
              submittedAt: new Date(Date.UTC(2026, 9, 16, 12, 0, index)),
              kind: rng() < 0.5 ? "edited" : "original",
            }),
          );
        } else {
          seededAssets.push(assetRow(assetId, { finalKey }));
        }
      }

      const db = await reset({ snapshot, assets: seededAssets, picks: seededPicks });
      let clock = new Date(Date.UTC(2026, 9, 17, 12, 0, 0));
      const drift = [0, 0, 1, 7, -3];

      for (let step = 0; step < STEPS; step += 1) {
        clock = new Date(clock.getTime() + drift[Math.floor(rng() * drift.length)]!);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(clock);

        const actor = PEOPLE[Math.floor(rng() * PEOPLE.length)]!;
        const before = attributeQuota(units(db.__rows.assets), snapshot);
        const assetsBefore = structuredClone(db.__rows.assets);
        const message = `seed=${SEED + run} step=${step}`;

        const roll = rng();
        if (roll < 0.6) {
          const assetId = ASSET_IDS[Math.floor(rng() * ASSET_IDS.length)]!;
          const shape = rng();
          let body: Record<string, unknown>;
          if (shape < 0.45) {
            body = { selected: true };
          } else if (shape < 0.7) {
            body = { selected: true, selectionKind: rng() < 0.5 ? "edited" : "original" };
          } else if (shape < 0.9) {
            body = { selected: false };
          } else {
            body = { selectionKind: rng() < 0.5 ? "edited" : "original" };
          }
          const result = await patch(actor, assetId, body);
          // Decision 7 at the route: a PATCH never moves `assets`, whatever
          // its status.
          expect(db.__rows.assets, `${message} patch ${JSON.stringify(body)}`).toEqual(
            assetsBefore,
          );
          if (result.body.error === "already_requested") alreadyRequested += 1;
          if (result.body.error === "pick_degraded") pickDegraded += 1;
        } else {
          const result = await submit(actor);
          const outcomes = result.body.pickOutcomes as
            | { claimed: number; escalated: number; joined: number; escalationBlocked: number }
            | undefined;
          if (outcomes) {
            counters.claimed += outcomes.claimed;
            counters.escalated += outcomes.escalated;
            counters.joined += outcomes.joined;
            counters.escalationBlocked += outcomes.escalationBlocked;
          }
        }

        const after = attributeQuota(units(db.__rows.assets), snapshot);
        expectSigma(after, message);
        for (const person of [...PEOPLE, null]) {
          if (person === actor) continue;
          expect(
            shareFor(after, person).surchargeCop,
            `${message} actor=${actor} person=${person}`,
          ).toBeLessThanOrEqual(shareFor(before, person).surchargeCop);
        }
        vi.useRealTimers();
      }
    }

    // Anti-vacuity: the walk genuinely visits every outcome.
    expect(counters.claimed, JSON.stringify(counters)).toBeGreaterThanOrEqual(1);
    expect(counters.escalated, JSON.stringify(counters)).toBeGreaterThanOrEqual(1);
    expect(counters.joined, JSON.stringify(counters)).toBeGreaterThanOrEqual(1);
    expect(counters.escalationBlocked, JSON.stringify(counters)).toBeGreaterThanOrEqual(1);
    expect(alreadyRequested, "already_requested seen").toBeGreaterThanOrEqual(1);
    expect(pickDegraded, "pick_degraded seen").toBeGreaterThanOrEqual(1);
  });
});
