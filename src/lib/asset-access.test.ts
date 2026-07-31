import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Same fake-db approach as the route test suites that exercise this module
// end to end (src/app/api/assets/[assetId]/{proof,final}/route.test.ts) —
// duplicated here rather than shared, matching the rest of this codebase's
// per-file test-double convention (see e.g. the two proofs/route.test.ts-
// style suites).
type Row = Record<string, unknown>;

function eqColumnAndValue(condition: unknown): { column?: string; value?: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  let dbColumnName: string | undefined;
  let table: unknown;
  let value: unknown;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnName = (chunk as { name: string }).name;
        table = (chunk as { table: unknown }).table;
      }
      if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
    }
  }
  if (!dbColumnName || !table) return { column: undefined, value };
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  return { column: jsKey, value };
}

// Task #94: ownership itself moved to src/lib/gallery-access.ts's
// `isGalleryOwner`, which has its own dedicated, mutation-tested suite
// (gallery-access.test.ts) covering the gallery_clients query shape. Mocked
// here rather than re-seeded via a second fake table, so this file tests
// exactly its own job: does `loadOwnedAsset` call `isGalleryOwner` with the
// right gallery id, and does it honor a true/false result correctly.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

vi.mock("@/lib/db", async () => {
  const { assets, galleries } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const { column, value } = eqColumnAndValue(condition);
            if (!column) throw new Error("eqColumnAndValue: not an eq() condition");

            if (table === assets) {
              const rows = assetRows.filter((r) => r[column] === value);
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            if (table === galleries) {
              const rows = galleryRows.filter((r) => r[column] === value);
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            throw new Error("fake db: unsupported table in select().where()");
          },
        }),
      }),
      __rows: { assets: assetRows, galleries: galleryRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; galleries: Row[] } };
  };
  return db;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function clientSession(userId: string): Session {
  return {
    user: { id: userId, role: "client", email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function galleryRow(overrides: Partial<Row> = {}): Row {
  return {
    id: GALLERY_ID,
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "proofing",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function assetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_ID,
    galleryId: GALLERY_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_ID}/proofs/${ASSET_ID}.webp`,
    finalKey: null,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    selectedAt: null,
    isEdited: false,
    sortOrder: 0,
    createdAt: new Date("2026-07-02"),
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  isGalleryOwnerMock.mockReset();
});

describe("loadOwnedAsset", () => {
  it("returns 404 asset_not_found when the asset id doesn't exist", async () => {
    const { loadOwnedAsset } = await import("./asset-access");

    const result = await loadOwnedAsset(ASSET_ID, clientSession("client-a"));

    expect(result).toEqual({ ok: false, status: 404, error: "asset_not_found" });
    expect(isGalleryOwnerMock).not.toHaveBeenCalled();
  });

  it("resolves the gallery FROM the asset's own galleryId, never from anything else", async () => {
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    db.__rows.assets.push(assetRow());
    isGalleryOwnerMock.mockResolvedValue(true);
    const { loadOwnedAsset } = await import("./asset-access");

    const result = await loadOwnedAsset(ASSET_ID, clientSession("client-a"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gallery.id).toBe(GALLERY_ID);
      expect(result.asset.id).toBe(ASSET_ID);
    }
    // Called with the asset's OWN galleryId, never anything the caller
    // supplied directly — see this file's own header comment.
    expect(isGalleryOwnerMock).toHaveBeenCalledWith(GALLERY_ID, clientSession("client-a"));
  });

  it("returns 403 forbidden when isGalleryOwner refuses the session", async () => {
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    db.__rows.assets.push(assetRow());
    isGalleryOwnerMock.mockResolvedValue(false);
    const { loadOwnedAsset } = await import("./asset-access");

    const result = await loadOwnedAsset(ASSET_ID, clientSession("client-b"));

    expect(result).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("allows the caller through when isGalleryOwner approves", async () => {
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    db.__rows.assets.push(assetRow());
    isGalleryOwnerMock.mockResolvedValue(true);
    const { loadOwnedAsset } = await import("./asset-access");

    const result = await loadOwnedAsset(ASSET_ID, clientSession("client-a"));

    expect(result.ok).toBe(true);
  });

  // Defensive-only branch: assets.galleryId carries a NOT NULL FK to
  // galleries, so this is unreachable in a real database. Proven here so
  // the function fails closed (404), not by throwing, if that invariant is
  // ever violated (e.g. a bad manual DB edit). `isGalleryOwner` must never
  // even be consulted here — there is no gallery row to check ownership
  // against.
  it("fails closed with 404 if the asset's gallery row is somehow missing", async () => {
    const db = await seededDb();
    db.__rows.assets.push(assetRow());
    const { loadOwnedAsset } = await import("./asset-access");

    const result = await loadOwnedAsset(ASSET_ID, adminSession());

    expect(result).toEqual({ ok: false, status: 404, error: "gallery_not_found" });
    expect(isGalleryOwnerMock).not.toHaveBeenCalled();
  });
});

// Task #58: three call sites (the DELETE route, the reorder route, and the
// client-facing selection-toggle route) used to each carry their own
// verbatim `["selected","delivered","archived"]` literal. Each route's own
// suite only ever asserted ITS OWN behaviour, so a status added or removed
// from one copy without touching the siblings would ship unnoticed — one
// mutation path gated, another left open, with every existing test suite
// still green. A test that merely re-asserted "the constant equals these
// three strings" would not have caught that: it would just be a FOURTH copy
// of the same three literals, drifting in lockstep with whichever copy it
// was written against.
//
// This test instead pins the set against the live `galleries.status` enum
// (schema.ts's `galleryStatus`, the actual source of truth for what a
// gallery's status can be), so it fails the moment someone adds a new
// status to the enum and forgets to decide whether it belongs on this list
// — the exact silent-drift failure mode task #58 exists to close.
describe("ASSET_MUTATION_BLOCKED_STATUSES — pinned against the galleries.status enum", () => {
  it("contains only real members of the enum (no stale or misspelled values)", async () => {
    const { galleryStatus } = await import("@/lib/db/schema");
    const { ASSET_MUTATION_BLOCKED_STATUSES } = await import("./asset-access");

    for (const status of ASSET_MUTATION_BLOCKED_STATUSES) {
      expect(galleryStatus.enumValues).toContain(status);
    }
  });

  it("classifies EVERY enum member as blocked or not — a status added to the enum without an explicit decision here fails this assertion instead of shipping silently", async () => {
    const { galleryStatus } = await import("@/lib/db/schema");
    const { ASSET_MUTATION_BLOCKED_STATUSES } = await import("./asset-access");

    const notBlocked = galleryStatus.enumValues.filter(
      (status) => !ASSET_MUTATION_BLOCKED_STATUSES.has(status),
    );

    // Today the only two statuses in which the asset set is still mutable
    // are `draft` and `proofing` — see the constant's own comment in
    // asset-access.ts for why. Every other member of the enum, including
    // any added in the future, is expected on the blocked side; a new
    // status lands here instead and fails the assertion until a human
    // decides which side it belongs on.
    expect([...notBlocked].sort()).toEqual(["draft", "proofing"]);
  });
});
