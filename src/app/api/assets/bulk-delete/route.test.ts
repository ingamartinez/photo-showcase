import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Real R2 is never touched here — same boundary-mocking philosophy as
// ../[assetId]/route.test.ts, which this suite otherwise mirrors closely: the
// two guarantees under test (DB-row-before-R2-delete, and the status gate
// checked before any mutation) are the SAME two guarantees, just exercised
// per id in a loop instead of once.
const deleteObjectMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
  storedKey: (key: string) => key,
}));

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
          deleteCallOrder.push(`db_delete:${String(value)}`);
          const remaining = assetRows.filter((r) => r[column] !== value);
          assetRows.length = 0;
          assetRows.push(...remaining);
        },
      }),
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
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_2_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET_3_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NONEXISTENT_ASSET_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

function assetRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    galleryId: GALLERY_A_ID,
    originalFilename: `${id}.JPG`,
    proofKey: `galleries/${GALLERY_A_ID}/proofs/${id}.webp`,
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

function requestFor(assetIds: string[]): NextRequest {
  return new NextRequest("http://localhost:3300/api/assets/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetIds }),
  });
}

function rawRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3300/api/assets/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({}) };

beforeEach(async () => {
  authMock.mockReset();
  deleteObjectMock.mockReset();
  const db = await seededDb();
  // The default implementation pushes onto the SAME `__deleteCallOrder`
  // array `db.delete().where()` already pushes `db_delete:<id>` onto — see
  // that mock's own line above. This is what lets the ordering tests below
  // assert the real interleaving from the TEST BODY, where a failed
  // `expect()` actually fails the test, instead of from inside this mock's
  // own implementation: the route wraps every `deleteObject()` call in its
  // own `.catch(() => {})` (route.ts's documented best-effort R2 delete),
  // which silently swallows an exception thrown from in here — including
  // one thrown by a failing `expect()`. Code review (2026-07-31) found the
  // previous shape of this exact test asserted from inside this mock and
  // could not fail even when the route's real order was reversed.
  deleteObjectMock.mockImplementation(async (key: string) => {
    db.__deleteCallOrder.push(`r2_delete:${key}`);
  });
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__deleteCallOrder.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow(ASSET_1_ID), assetRow(ASSET_2_ID), assetRow(ASSET_3_ID));
});

describe("POST /api/assets/bulk-delete — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID]), context);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in CLIENT with a 403, even the gallery's own owning client", async () => {
    authMock.mockResolvedValue(clientASession());
    const { POST } = await import("./route");

    await expect(POST(requestFor([ASSET_1_ID]), context)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });

    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/assets/bulk-delete — body validation", () => {
  it("rejects a malformed JSON body with 400", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(rawRequest("not json"), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("rejects an empty assetIds array with 400, before querying the database", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor([]), context);

    expect(response.status).toBe(400);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid entry with 400", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(["not-a-uuid"]), context);

    expect(response.status).toBe(400);
  });
});

describe("POST /api/assets/bulk-delete — happy path", () => {
  it("deletes every requested asset's row and R2 object(s), reporting them all as deleted", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID, ASSET_2_ID, ASSET_3_ID]), context);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: string[]; failed: unknown[] };
    expect(body.deleted.sort()).toEqual([ASSET_1_ID, ASSET_2_ID, ASSET_3_ID].sort());
    expect(body.failed).toEqual([]);
    expect(db.__rows.assets).toHaveLength(0);
    expect(deleteObjectMock).toHaveBeenCalledTimes(3);
  });

  it("dedupes a repeated id, deleting it (and calling deleteObject for it) only once", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID, ASSET_1_ID]), context);

    const body = (await response.json()) as { deleted: string[]; failed: unknown[] };
    expect(body.deleted).toEqual([ASSET_1_ID]);
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/assets/bulk-delete — the per-asset status gate", () => {
  it("skips a locked gallery's asset (reporting it as failed) without deleting it, while still deleting the rest", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    // A second gallery, already `selected`, owning the second asset — proves
    // the gate is evaluated PER ASSET's own gallery, not once for the batch.
    const GALLERY_B_ID = "22222222-2222-4222-8222-222222222222";
    db.__rows.galleries.push(galleryRow({ id: GALLERY_B_ID, status: "selected" }));
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow(ASSET_1_ID), assetRow(ASSET_2_ID, { galleryId: GALLERY_B_ID }));
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID, ASSET_2_ID]), context);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deleted: string[];
      failed: { id: string; error: string }[];
    };
    expect(body.deleted).toEqual([ASSET_1_ID]);
    expect(body.failed).toEqual([{ id: ASSET_2_ID, error: "gallery_locked" }]);
    // The locked asset's row must survive untouched.
    expect(db.__rows.assets.some((r) => r.id === ASSET_2_ID)).toBe(true);
    expect(db.__rows.assets.some((r) => r.id === ASSET_1_ID)).toBe(false);
  });
});

describe("POST /api/assets/bulk-delete — per-id lookup, not per-request", () => {
  // The proof that authorization runs for EVERY id, not merely the first: a
  // batch mixing one asset that doesn't exist among two that do must refuse
  // only the missing one, not the whole request.
  it("reports a nonexistent id as failed without blocking the valid ids around it", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(
      requestFor([ASSET_1_ID, NONEXISTENT_ASSET_ID, ASSET_2_ID]),
      context,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deleted: string[];
      failed: { id: string; error: string }[];
    };
    expect(body.deleted.sort()).toEqual([ASSET_1_ID, ASSET_2_ID].sort());
    expect(body.failed).toEqual([{ id: NONEXISTENT_ASSET_ID, error: "asset_not_found" }]);
  });
});

describe("POST /api/assets/bulk-delete — orphan avoidance ordering", () => {
  // The order itself, asserted from THIS test's own body against
  // `__deleteCallOrder` — not from an `expect()` planted inside
  // `deleteObjectMock`'s implementation, which the route's own
  // `.catch(() => {})` around every `deleteObject()` call (see the file
  // header) would silently swallow, making that shape of assertion
  // unable to fail regardless of the real order. Mutation-proven: swapping
  // route.ts's own two calls (R2 delete before `db.delete()`) turns this
  // red — see this slice's own commit message / PR description for the
  // observed failure.
  it("deletes each asset's DB row BEFORE attempting its own R2 delete", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID]), context);

    expect(response.status).toBe(200);
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(db.__deleteCallOrder).toEqual([
      `db_delete:${ASSET_1_ID}`,
      `r2_delete:galleries/${GALLERY_A_ID}/proofs/${ASSET_1_ID}.webp`,
    ]);
  });

  // The per-ASSET half of the same guarantee: each asset's own DB delete
  // commits before ITS OWN R2 delete is even attempted, interleaved across
  // the batch — not "every DB delete, then every R2 delete" (the shape a
  // well-intentioned `Promise.all` refactor of the sequential loop could
  // silently produce, and still pass the single-asset test above).
  it("interleaves DB-then-R2 per asset across a multi-asset batch, not batched by phase", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID, ASSET_2_ID]), context);

    expect(response.status).toBe(200);
    expect(db.__deleteCallOrder).toEqual([
      `db_delete:${ASSET_1_ID}`,
      `r2_delete:galleries/${GALLERY_A_ID}/proofs/${ASSET_1_ID}.webp`,
      `db_delete:${ASSET_2_ID}`,
      `r2_delete:galleries/${GALLERY_A_ID}/proofs/${ASSET_2_ID}.webp`,
    ]);
  });

  it("still reports an asset as deleted when its compensating R2 delete fails", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    deleteObjectMock.mockRejectedValue(new Error("R2 unreachable"));
    const { POST } = await import("./route");

    const response = await POST(requestFor([ASSET_1_ID]), context);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: string[] };
    expect(body.deleted).toEqual([ASSET_1_ID]);
    expect(db.__rows.assets.some((r) => r.id === ASSET_1_ID)).toBe(false);
  });
});
