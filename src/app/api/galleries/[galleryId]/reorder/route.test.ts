import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

type Row = Record<string, unknown>;

// Same `eq()`/`and()` interpreter as src/lib/gallery-access.test.ts — see
// that file's own comment for why `and()`'s operands live one
// `queryChunks` level deeper than a single `eq()`'s own chunks, and why a
// node `parseLeaf` can resolve is treated as a leaf and never recursed into.
type LeafCondition = { column: string; value: unknown };

function parseLeaf(node: unknown): LeafCondition | undefined {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return undefined;
  let dbColumnName: string | undefined;
  let table: unknown;
  let value: unknown;
  let hasValue = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnName = (chunk as { name: string }).name;
        table = (chunk as { table: unknown }).table;
      }
      if ("value" in chunk && "encoder" in chunk) {
        value = (chunk as { value: unknown }).value;
        hasValue = true;
      }
    }
  }
  if (!dbColumnName || !table || !hasValue) return undefined;
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  if (!jsKey) return undefined;
  return { column: jsKey, value };
}

function andConditions(condition: unknown): LeafCondition[] {
  const leaf = parseLeaf(condition);
  if (leaf) return [leaf];
  const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const results: LeafCondition[] = [];
  for (const chunk of chunks) results.push(...andConditions(chunk));
  return results;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];
  // Every WHERE clause a `tx.update(assets)` call actually ran, as its
  // parsed leaf conditions — see the "scopes every UPDATE" test below for
  // why this exists: `assets.id` alone is enough to select the right row in
  // THIS suite's fixture data (every id is globally unique across
  // galleries), so a fake db that only checks the update's OUTCOME cannot
  // tell a route that scopes its WHERE to `(id, galleryId)` apart from one
  // that scopes it to `id` alone — the two are indistinguishable by result
  // here, only by the WHERE clause itself.
  const updateConditions: LeafCondition[][] = [];

  function matches(row: Row, condition: unknown): boolean {
    return andConditions(condition).every((c) => row[c.column] === c.value);
  }

  function updateAssets(rows: Row[], condition: unknown, patch: Row) {
    let matched = false;
    for (const row of rows) {
      if (matches(row, condition)) {
        Object.assign(row, patch);
        matched = true;
      }
    }
    return matched;
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            if (table === assets) {
              let rows = assetRows.filter((r) => matches(r, condition));
              if (columns) {
                rows = rows.map((r) => {
                  const projected: Row = {};
                  for (const key of Object.keys(columns)) projected[key] = r[key];
                  return projected;
                });
              }
              return rows;
            }
            if (table === galleries) {
              const rows = galleryRows.filter((r) => matches(r, condition));
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            throw new Error("fake db: unsupported table in select().where()");
          },
        }),
      }),
      // Buffers writes into a PENDING copy of `assetRows`, exactly the same
      // "discard on throw, merge on success" shape as
      // src/app/dashboard/galleries/actions.test.ts's own fake — the
      // regression this proves is "a failure partway through the loop must
      // not leave SOME rows renumbered and others not."
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const pending = assetRows.map((row) => ({ ...row }));
        const tx = {
          update: (table: unknown) => ({
            set: (patch: Row) => ({
              where: async (condition: unknown) => {
                if (table !== assets) throw new Error("fake db: unsupported table in update()");
                updateConditions.push(andConditions(condition));
                updateAssets(pending, condition, patch);
              },
            }),
          }),
        };
        const result = await fn(tx);
        assetRows.length = 0;
        assetRows.push(...pending);
        return result;
      },
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: { assets: assetRows, galleries: galleryRows },
      __updateConditions: updateConditions,
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { assets: Row[]; galleries: Row[] };
      __updateConditions: LeafCondition[][];
    };
  };
  return db;
}

const GALLERY_A_ID = "11111111-1111-4111-8111-111111111111";
const GALLERY_B_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ASSET_2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ASSET_3_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const OUTSIDE_ASSET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

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

function requestFor(galleryId: string, assetIds: string[]): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${galleryId}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetIds }),
  });
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__updateConditions.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(
    assetRow({ id: ASSET_1_ID, sortOrder: 0 }),
    assetRow({
      id: ASSET_2_ID,
      sortOrder: 1,
      originalFilename: "IMG_0002.JPG",
      proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_2_ID}.webp`,
    }),
    assetRow({
      id: ASSET_3_ID,
      sortOrder: 2,
      originalFilename: "IMG_0003.JPG",
      proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_3_ID}.webp`,
    }),
  );
});

describe("POST /api/galleries/[galleryId]/reorder — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_A_ID, [ASSET_1_ID, ASSET_2_ID, ASSET_3_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("refuses a signed-in CLIENT with a 403, even the gallery's own owning client", async () => {
    authMock.mockResolvedValue(clientASession());
    const { POST } = await import("./route");

    await expect(
      POST(requestFor(GALLERY_A_ID, [ASSET_1_ID, ASSET_2_ID, ASSET_3_ID]), paramsFor(GALLERY_A_ID)),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
  });
});

describe("POST /api/galleries/[galleryId]/reorder — validation and not-found", () => {
  it("rejects a malformed gallery id with 400", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor("not-a-uuid", [ASSET_1_ID]), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_gallery_id" });
  });

  it("rejects a body with an empty assetIds array", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(GALLERY_A_ID, []), paramsFor(GALLERY_A_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("rejects a body whose assetIds are not UUIDs", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(GALLERY_A_ID, ["not-a-uuid"]), paramsFor(GALLERY_A_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("returns 404 when the gallery does not exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_A_ID, [ASSET_1_ID, ASSET_2_ID, ASSET_3_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });
});

describe("POST /api/galleries/[galleryId]/reorder — exact-set validation", () => {
  it("refuses with 409 when the posted list is missing one of the gallery's own assets", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_A_ID, [ASSET_1_ID, ASSET_2_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "stale_asset_list" });
    const db = await seededDb();
    const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
    expect(byId[ASSET_1_ID]).toBe(0);
    expect(byId[ASSET_2_ID]).toBe(1);
    expect(byId[ASSET_3_ID]).toBe(2);
  });

  it("refuses with 409 when the posted list includes an asset from ANOTHER gallery", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.push(
      assetRow({ id: OUTSIDE_ASSET_ID, galleryId: GALLERY_B_ID, sortOrder: 0 }),
    );
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_A_ID, [ASSET_1_ID, ASSET_2_ID, OUTSIDE_ASSET_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "stale_asset_list" });
  });

  // Code review (2026-08-01): comparing two `Set` SIZES lets a list with a
  // repeated id through as long as its distinct-member count happens to
  // match the gallery's own asset count. `[a3, a1, a2, a3]` against this
  // suite's 3-asset gallery has 3 DISTINCT members (same size as
  // `currentIds`) but 4 entries — without this guard it would 200, write
  // `a3`'s sort_order twice (0, then 3, last write winning), and the
  // `updated` array would report BOTH positions for the same id.
  it("refuses with 409 when the posted list repeats an id, even though its distinct members match", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_A_ID, [ASSET_3_ID, ASSET_1_ID, ASSET_2_ID, ASSET_3_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "stale_asset_list" });
    const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
    expect(byId[ASSET_1_ID]).toBe(0);
    expect(byId[ASSET_2_ID]).toBe(1);
    expect(byId[ASSET_3_ID]).toBe(2);
  });
});

describe("POST /api/galleries/[galleryId]/reorder — gallery status gate", () => {
  it.each(["selected", "delivered", "archived"])(
    "refuses with 409 when the gallery status is %s, without touching sort_order",
    async (status) => {
      authMock.mockResolvedValue(adminSession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { POST } = await import("./route");

      const response = await POST(
        requestFor(GALLERY_A_ID, [ASSET_3_ID, ASSET_2_ID, ASSET_1_ID]),
        paramsFor(GALLERY_A_ID),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
      const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
      expect(byId[ASSET_1_ID]).toBe(0);
      expect(byId[ASSET_2_ID]).toBe(1);
      expect(byId[ASSET_3_ID]).toBe(2);
    },
  );

  it.each(["draft", "proofing"])(
    "still allows the reorder when the gallery status is %s",
    async (status) => {
      authMock.mockResolvedValue(adminSession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { POST } = await import("./route");

      const response = await POST(
        requestFor(GALLERY_A_ID, [ASSET_3_ID, ASSET_2_ID, ASSET_1_ID]),
        paramsFor(GALLERY_A_ID),
      );

      expect(response.status).toBe(200);
      const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
      expect(byId[ASSET_3_ID]).toBe(0);
      expect(byId[ASSET_2_ID]).toBe(1);
      expect(byId[ASSET_1_ID]).toBe(2);
    },
  );
});

describe("POST /api/galleries/[galleryId]/reorder — happy path", () => {
  it("persists an arbitrary drop position (not merely a neighbor swap) for the whole gallery in one call", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    // Asset 3 dropped to the FRONT — not adjacent to its old position,
    // exactly the case a swap-with-neighbor operation cannot express.
    const response = await POST(
      requestFor(GALLERY_A_ID, [ASSET_3_ID, ASSET_1_ID, ASSET_2_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: [
        { id: ASSET_3_ID, sortOrder: 0 },
        { id: ASSET_1_ID, sortOrder: 1 },
        { id: ASSET_2_ID, sortOrder: 2 },
      ],
    });
    const byId = Object.fromEntries(db.__rows.assets.map((r) => [r.id, r.sortOrder]));
    expect(byId[ASSET_3_ID]).toBe(0);
    expect(byId[ASSET_1_ID]).toBe(1);
    expect(byId[ASSET_2_ID]).toBe(2);
  });

  // Code review (2026-08-01): the original version of this test asserted
  // only the OUTCOME (the sibling gallery's asset keeps its own
  // sort_order), which review proved unfalsifiable by removing
  // `eq(assets.galleryId, galleryId)` from the route's own UPDATE WHERE and
  // watching all 15 tests (this one included) stay green — every id in this
  // suite's fixture data is globally unique, so `eq(assets.id, assetId)`
  // ALONE already selects the correct row regardless of whether the
  // galleryId predicate is present; the property was actually being
  // defended by the sibling 409 test above, not this one. This version
  // asserts the WHERE clause itself carries BOTH predicates, which the
  // outcome-only version could not tell apart from a route that scopes
  // updates to `id` alone.
  it("scopes every UPDATE to (id, galleryId), not id alone", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    await POST(
      requestFor(GALLERY_A_ID, [ASSET_3_ID, ASSET_2_ID, ASSET_1_ID]),
      paramsFor(GALLERY_A_ID),
    );

    expect(db.__updateConditions).toHaveLength(3);
    for (const condition of db.__updateConditions) {
      const byColumn = Object.fromEntries(condition.map((c) => [c.column, c.value]));
      expect(byColumn.galleryId).toBe(GALLERY_A_ID);
      expect([ASSET_1_ID, ASSET_2_ID, ASSET_3_ID]).toContain(byColumn.id);
    }
  });
});
