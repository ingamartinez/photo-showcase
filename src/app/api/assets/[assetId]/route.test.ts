import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Real R2 is never touched here — same boundary-mocking philosophy as
// src/app/api/galleries/[galleryId]/proofs/route.test.ts. What THIS suite
// must prove is the ORDERING (DB row gone before the R2 delete is even
// attempted) and that a failing R2 delete never surfaces as a thrown error.
const deleteObjectMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering by
// the column/value encoded in `eq()`, the CORRECTED `eqColumnAndValue` that
// resolves the JS property key through the table object (see
// src/app/api/galleries/[galleryId]/proofs/route.test.ts's comment on why —
// NOT the older buggy copy in src/app/dashboard/galleries/actions.test.ts).
// `@/lib/asset-access` is deliberately left UNMOCKED: this suite exercises
// the real ownership check through the route, same as
// src/app/api/assets/[assetId]/proof/route.test.ts.
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

vi.mock("@/lib/db", async () => {
  const { assets, galleries } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];
  const deleteCallOrder: string[] = [];

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
      delete: (table: unknown) => ({
        where: async (condition: unknown) => {
          if (table !== assets) throw new Error("fake db: unsupported table in delete()");
          const { column, value } = eqColumnAndValue(condition);
          if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
          deleteCallOrder.push("db_delete");
          const remaining = assetRows.filter((r) => r[column] !== value);
          assetRows.length = 0;
          assetRows.push(...remaining);
        },
      }),
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { assets: assetRows, galleries: galleryRows },
      __deleteCallOrder: deleteCallOrder,
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; galleries: Row[] }; __deleteCallOrder: string[] };
  };
  return db;
}

const GALLERY_A_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function clientASession(): Session {
  return {
    user: { id: "client-a", role: "client", email: "a@example.com" },
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
    id: GALLERY_A_ID,
    clientId: "client-a",
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
    id: ASSET_A_ID,
    galleryId: GALLERY_A_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`,
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

function requestFor(assetId: string): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}`, { method: "DELETE" });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__deleteCallOrder.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow());
});

describe("DELETE /api/assets/[assetId] — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  // Unlike the read routes (task #16), deleting is admin-only — a client
  // must never be able to delete an asset from a gallery they own.
  it("refuses a signed-in CLIENT with a 403, even the gallery's own owning client", async () => {
    authMock.mockResolvedValue(clientASession());
    const { DELETE } = await import("./route");

    await expect(DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });

    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/assets/[assetId] — validation and not-found", () => {
  it("rejects a malformed asset id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(adminSession());
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the asset does not exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });
});

describe("DELETE /api/assets/[assetId] — happy path and orphan avoidance", () => {
  it("removes the assets row and deletes the proof object in R2", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(db.__rows.assets).toHaveLength(0);
    expect(deleteObjectMock).toHaveBeenCalledWith(
      `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`,
    );
  });

  it("also deletes the final object when one exists on the asset", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(
      assetRow({ finalKey: `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.jpg` }),
    );
    const { DELETE } = await import("./route");

    await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(deleteObjectMock).toHaveBeenCalledWith(
      `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`,
    );
    expect(deleteObjectMock).toHaveBeenCalledWith(
      `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.jpg`,
    );
  });

  it("never calls deleteObject for a final that doesn't exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const { DELETE } = await import("./route");

    await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  // The chosen ordering, proven directly: the DB row is gone (delete has
  // already run) at the moment deleteObject is invoked — not the other way
  // around. See the route's file header for why this order was chosen and
  // which side leaks if the R2 delete below fails.
  it("deletes the DB row BEFORE attempting the R2 delete", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    deleteObjectMock.mockImplementation(async () => {
      // At the instant deleteObject runs, the row must already be gone.
      expect(db.__rows.assets).toHaveLength(0);
    });
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });

  // The documented leak (see the route's file header): if the R2 delete
  // fails AFTER the DB row is already gone, this must still answer 200, not
  // throw an unhandled rejection. The object is now orphaned in R2 — that is
  // the accepted trade-off, proven here as "does not crash the request".
  it("still returns 200 when the compensating R2 delete itself fails", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    deleteObjectMock.mockRejectedValue(new Error("R2 unreachable"));
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assets).toHaveLength(0);
  });

  it("lets an admin delete any asset regardless of which client owns the gallery", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.assets.length = 0;
    const GALLERY_B_ID = "22222222-2222-4222-8222-222222222222";
    db.__rows.galleries.push(galleryRow({ id: GALLERY_B_ID, clientId: "client-b" }));
    db.__rows.assets.push(
      assetRow({
        galleryId: GALLERY_B_ID,
        proofKey: `galleries/${GALLERY_B_ID}/proofs/${ASSET_A_ID}.webp`,
      }),
    );
    const { DELETE } = await import("./route");

    const response = await DELETE(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
  });
});
