import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Real R2 is never touched here — `getPresignedUrl` is the ONE thing
// `@/lib/r2` contributes to this route, and its own TTL/signing behavior is
// proven for real against R2 in src/lib/r2.test.ts and scripts/check-r2.ts.
// What THIS suite must prove is the wiring above it: which key gets handed
// to getPresignedUrl, and — the whole point of task #16 — whether the
// caller was ever allowed to reach that call at all.
const getPresignedUrlMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering by
// the column/value encoded in `eq()`, same approach as
// src/app/api/galleries/[galleryId]/proofs/route.test.ts. `@/lib/asset-access`
// is deliberately left UNMOCKED: this suite exercises the real ownership
// check (task #16's core requirement) end to end through the route, not a
// stand-in that merely asserts it was called.
type Row = Record<string, unknown>;

// Resolves EVERY `eq()` this condition is built from, however deep — a bare
// `eq()` at the top level, or several nested inside an `and(...)` (drizzle
// wraps `and(eqA, eqB)` in an EXTRA parens/`" and "` SQL node one level
// deeper than a flat `queryChunks` array — verified by reading
// node_modules/drizzle-orm/pg-core/dialect.js directly, not assumed). Task
// #94's `isGalleryOwner` (src/lib/gallery-access.ts) is the first caller in
// this suite to need the `and(eq(), eq())` shape at all — every prior
// `eq()`-only condition here still resolves to a single-element list.
function eqConditions(condition: unknown): { column?: string; value?: unknown }[] {
  const results: { column?: string; value?: unknown }[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!chunks) return;
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
    if (dbColumnName && table) {
      // `eq()`'s condition only carries the DB column name (e.g.
      // "gallery_id"), not the JS property key (e.g. "galleryId") the row
      // fixtures below are keyed by. Resolving through `table`'s own
      // entries keeps this correct for every column, including the ones
      // where the two names differ.
      const jsKey = Object.entries(table as Record<string, unknown>).find(
        ([, col]) =>
          col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
      )?.[0];
      results.push({ column: jsKey, value });
      return;
    }
    for (const chunk of chunks) walk(chunk);
  }
  walk(condition);
  return results;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries, galleryClients } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  function rowsFor(table: unknown): Row[] {
    if (table === assets) return assetRows;
    if (table === galleries) return galleryRows;
    if (table === galleryClients) return galleryClientRows;
    throw new Error("fake db: unsupported table in select().where()");
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const conditions = eqConditions(condition);
            if (conditions.length === 0 || conditions.some((c) => !c.column)) {
              throw new Error("eqConditions: not a supported eq()/and(eq(), eq()) condition");
            }
            const rows = rowsFor(table).filter((row) =>
              conditions.every(({ column, value }) => row[column!] === value),
            );
            return { limit: async (n: number) => rows.slice(0, n) };
          },
        }),
      }),
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: { assets: assetRows, galleries: galleryRows, galleryClients: galleryClientRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; galleries: Row[]; galleryClients: Row[] } };
  };
  return db;
}

const GALLERY_A_ID = "11111111-1111-4111-8111-111111111111";
const GALLERY_B_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function clientASession(): Session {
  return {
    user: { id: "client-a", role: "client", email: "a@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientBSession(): Session {
  return {
    user: { id: "client-b", role: "client", email: "b@example.com" },
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
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/proof`, { method: "GET" });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-proof-url");
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow());
  // Task #94: ownership is now a `gallery_clients` row, not a `clientId`
  // column on the gallery itself.
  db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-a" });
});

describe("GET /api/assets/[assetId]/proof — authorization", () => {
  // The #45-review carried-over acceptance criterion: proven by requesting
  // the route with no session at all, not by reading requireApiSession()'s
  // implementation.
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  // The task's headline acceptance criterion: two REAL users, calling the
  // route directly. Client A's asset belongs to a gallery owned by
  // client-a; client B is signed in as a completely different client.
  it("returns 403 when a different client requests someone else's asset", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns 200 for the asset's own owning client", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://r2.example.com/presigned-proof-url",
    });
  });

  it("lets an admin read any asset regardless of which client owns the gallery", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.assets.length = 0;
    db.__rows.galleryClients.length = 0;
    db.__rows.galleries.push(galleryRow({ id: GALLERY_B_ID }));
    db.__rows.galleryClients.push({ galleryId: GALLERY_B_ID, userId: "client-b" });
    db.__rows.assets.push(
      assetRow({
        galleryId: GALLERY_B_ID,
        proofKey: `galleries/${GALLERY_B_ID}/proofs/${ASSET_A_ID}.webp`,
      }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(getPresignedUrlMock).toHaveBeenCalledWith(
      `galleries/${GALLERY_B_ID}/proofs/${ASSET_A_ID}.webp`,
    );
  });

  it("presigns the exact proofKey stored on the asset row, not a hand-built key", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(getPresignedUrlMock).toHaveBeenCalledWith(
      `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`,
    );
  });
});

describe("GET /api/assets/[assetId]/proof — gallery status gate (task #63)", () => {
  // The task's headline acceptance criterion: a client holding a valid asset
  // id from their OWN `draft` gallery must be refused, exactly like
  // `/galleries/[publicSlug]` already 404s that same gallery for them.
  it("refuses a client reading a proof from their own draft gallery", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_visible" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  // The same client succeeds once the gallery moves to `proofing` — proves
  // the gate is on gallery status, not a blanket refusal.
  it("lets the same client read the proof once the gallery is proofing", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "proofing" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
  });

  // `selected` and `delivered` are the other two statuses
  // `isGalleryVisibleToClient()` allows — proven directly rather than only
  // through `draft`/`proofing`, so a regression that narrows the set to just
  // `proofing` would also be caught here.
  it.each(["selected", "delivered"] as const)(
    "lets the client read the proof when the gallery is %s",
    async (status) => {
      authMock.mockResolvedValue(clientASession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { GET } = await import("./route");

      const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

      expect(response.status).toBe(200);
    },
  );

  // Admins bypass the gate entirely — task #20's admin workspace previews
  // `draft` galleries constantly, by design, and must not regress.
  it("lets an admin read a proof from a draft gallery", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(getPresignedUrlMock).toHaveBeenCalled();
  });
});

describe("GET /api/assets/[assetId]/proof — validation and not-found", () => {
  it("rejects a malformed asset id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  // Knowing an asset id must not be sufficient to fetch it (task #16) — this
  // covers the "the id simply doesn't exist" half of that, distinct from
  // the "exists but isn't yours" 403 case above.
  it("returns 404 when the asset does not exist, for a signed-in client", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });
});
