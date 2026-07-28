import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// A minimal, genuinely-behaving double for `@/lib/db` — same
// `eqColumnAndValue` (the CORRECTED version, see
// src/app/api/galleries/[galleryId]/proofs/route.test.ts's comment) plus a
// real `orderBy` (ascending only — the one thing this route actually asks
// for) and a real `update`. `@/lib/asset-access` is deliberately left
// UNMOCKED, same reasoning as the sibling DELETE route's suite.
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

  function selectFrom(columns: Record<string, unknown> | undefined, table: unknown) {
    return {
      where: (condition: unknown) => {
        const { column, value } = eqColumnAndValue(condition);
        if (!column) throw new Error("eqColumnAndValue: not an eq() condition");

        if (table === assets) {
          let rows = assetRows.filter((r) => r[column] === value);
          if (columns) {
            rows = rows.map((r) => {
              const projected: Row = {};
              for (const key of Object.keys(columns)) projected[key] = r[key];
              return projected;
            });
          }
          return {
            limit: async (n: number) => rows.slice(0, n),
            orderBy: async () =>
              [...rows].sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number)),
          };
        }
        if (table === galleries) {
          const rows = galleryRows.filter((r) => r[column] === value);
          return { limit: async (n: number) => rows.slice(0, n) };
        }
        throw new Error("fake db: unsupported table in select().where()");
      },
    };
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => selectFrom(columns, table),
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: async (condition: unknown) => {
            if (table !== assets) throw new Error("fake db: unsupported table in update()");
            const { column, value } = eqColumnAndValue(condition);
            if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
            for (const row of assetRows) {
              if (row[column] === value) Object.assign(row, patch);
            }
          },
        }),
      }),
      // Test-only escape hatch, not part of the real `db` shape.
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

const GALLERY_A_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ASSET_2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ASSET_3_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

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
    id: ASSET_1_ID,
    galleryId: GALLERY_A_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_1_ID}.webp`,
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

function requestFor(assetId: string, direction: "up" | "down"): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/reorder`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction }),
  });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(
    assetRow({ id: ASSET_1_ID, sortOrder: 0 }),
    assetRow({
      id: ASSET_2_ID,
      sortOrder: 1,
      proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_2_ID}.webp`,
    }),
    assetRow({
      id: ASSET_3_ID,
      sortOrder: 2,
      proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_3_ID}.webp`,
    }),
  );
});

describe("PATCH /api/assets/[assetId]/reorder — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_2_ID, "up"), paramsFor(ASSET_2_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("refuses a signed-in CLIENT with a 403, even the gallery's own owning client", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    await expect(PATCH(requestFor(ASSET_2_ID, "up"), paramsFor(ASSET_2_ID))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });
});

describe("PATCH /api/assets/[assetId]/reorder — validation and not-found", () => {
  it("rejects a malformed asset id with 400", async () => {
    authMock.mockResolvedValue(adminSession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor("not-a-uuid", "up"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
  });

  it("rejects a body without a valid direction", async () => {
    authMock.mockResolvedValue(adminSession());
    const { PATCH } = await import("./route");
    const badRequest = new NextRequest(`http://localhost:3300/api/assets/${ASSET_2_ID}/reorder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "sideways" }),
    });

    const response = await PATCH(badRequest, paramsFor(ASSET_2_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("returns 404 when the asset does not exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_2_ID, "up"), paramsFor(ASSET_2_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });
});

describe("PATCH /api/assets/[assetId]/reorder — happy path", () => {
  it("swaps sort_order with the previous asset when moving up", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_2_ID, "up"), paramsFor(ASSET_2_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: [
        { id: ASSET_2_ID, sortOrder: 0 },
        { id: ASSET_1_ID, sortOrder: 1 },
      ],
    });
    const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
    expect(byId[ASSET_1_ID]).toBe(1);
    expect(byId[ASSET_2_ID]).toBe(0);
    expect(byId[ASSET_3_ID]).toBe(2);
  });

  it("swaps sort_order with the next asset when moving down", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_2_ID, "down"), paramsFor(ASSET_2_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: [
        { id: ASSET_2_ID, sortOrder: 2 },
        { id: ASSET_3_ID, sortOrder: 1 },
      ],
    });
    const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
    expect(byId[ASSET_2_ID]).toBe(2);
    expect(byId[ASSET_3_ID]).toBe(1);
  });

  it("is a no-op (not an error) when moving the first asset up", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, "up"), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: [] });
    const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
    expect(byId[ASSET_1_ID]).toBe(0);
  });

  it("is a no-op (not an error) when moving the last asset down", async () => {
    authMock.mockResolvedValue(adminSession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_3_ID, "down"), paramsFor(ASSET_3_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: [] });
  });
});
