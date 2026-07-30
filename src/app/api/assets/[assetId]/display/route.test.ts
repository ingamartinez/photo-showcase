// GET /api/assets/[assetId]/display (task #89) — the browsing-sized,
// UNWATERMARKED derivative of a delivered photo.
//
// Two things this suite exists to prove, and they pull in opposite
// directions:
//   1. A client whose gallery IS delivered gets the unwatermarked bytes.
//   2. Everyone else — and every asset that is not a finished deliverable —
//      gets nothing, so the grid keeps showing the watermarked proof. That
//      second one is the leverage the whole product rests on, so it is
//      covered one flipped condition at a time rather than in aggregate.
//
// The gate itself lives in src/lib/final-access.ts and is exhaustively unit
// tested there; `@/lib/final-access` is deliberately left UNMOCKED here so
// this suite proves the ROUTE actually consults it, on the real rows
// `loadOwnedAsset` produced. `@/lib/asset-access` is left unmocked for the
// same reason (the real ownership check runs end to end), matching the
// sibling proof/final suites.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Real R2 is never touched here — same boundary as the sibling proof and
// final route suites. `displayKey` gets a deterministic fake (its real,
// environment-namespaced shape is r2.test.ts's business); `objectExists` is
// a mock because THIS suite's job includes proving the route falls back to
// a clean 404 when the derivative was never generated, which is not a state
// a real bucket would hold on demand.
const getPresignedUrlMock = vi.fn();
const objectExistsMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
  objectExists: (...args: unknown[]) => objectExistsMock(...args),
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
    status: "delivered",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: new Date("2026-07-10"),
    deliveredAt: new Date("2026-07-20"),
    ...overrides,
  };
}

const FINAL_KEY = `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.jpg`;
const DISPLAY_KEY = `galleries/${GALLERY_A_ID}/display/${ASSET_A_ID}.webp`;
const PROOF_KEY = `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`;

// The fully-unlocked deliverable: selected, edited, a final in R2, gallery
// delivered. Individual tests below flip ONE axis at a time, so each gate is
// proven to be independently enforced rather than incidentally covered.
function assetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_A_ID,
    galleryId: GALLERY_A_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`,
    finalKey: FINAL_KEY,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: true,
    selectedAt: new Date("2026-07-11"),
    isEdited: true,
    sortOrder: 0,
    createdAt: new Date("2026-07-02"),
    ...overrides,
  };
}

function requestFor(assetId: string): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/display`, { method: "GET" });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-display-url");
  objectExistsMock.mockReset();
  objectExistsMock.mockResolvedValue(true);
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

describe("GET /api/assets/[assetId]/display — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
    expect(objectExistsMock).not.toHaveBeenCalled();
  });

  // The one that matters most for a route that hands out UNWATERMARKED
  // bytes: a signed-in client who is not one of this gallery's own clients
  // gets a real 403 and never reaches the presign.
  it("returns 403 when a different client requests someone else's asset", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an asset that does not exist", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(
      requestFor("99999999-9999-4999-8999-999999999999"),
      paramsFor("99999999-9999-4999-8999-999999999999"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });

  it("returns 400 for a non-uuid asset id, before touching the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/assets/[assetId]/display — the happy path", () => {
  it("presigns the DISPLAY key for the owning client of a delivered gallery", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://r2.example.com/presigned-display-url",
    });
    expect(getPresignedUrlMock).toHaveBeenCalledWith(DISPLAY_KEY);
  });

  // Serving `finalKey` here is the wrong implementation task #89 spells out:
  // ~4000x2667 multi-MB JPEGs in a grid, ~100 MB for twenty photos, on a
  // phone. Asserted on the key actually signed, so the mistake cannot be
  // made silently.
  it("never signs the full-resolution final key, and never the watermarked proof key either", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    const signed = getPresignedUrlMock.mock.calls.map((call) => call[0]);
    expect(signed).toEqual([DISPLAY_KEY]);
    expect(signed).not.toContain(FINAL_KEY);
    expect(signed).not.toContain(PROOF_KEY);
  });

  // The behavioural difference from GET .../final: that route forces
  // `Content-Disposition: attachment` so a phone SAVES the file. This URL
  // goes into an <img src> and must render INLINE, which means passing no
  // override at all — not an override set to undefined.
  it("presigns for INLINE rendering, with no content-disposition override", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(getPresignedUrlMock).toHaveBeenCalledTimes(1);
    expect(getPresignedUrlMock.mock.calls[0]).toEqual([DISPLAY_KEY]);
  });
});

// Every one of these is a state in which the client must keep seeing the
// WATERMARKED proof. Flipped one axis at a time from the fully-unlocked
// fixture — the shape task #89 asks for explicitly ("prove this by mutation
// — it is the leverage the whole product rests on").
describe("GET /api/assets/[assetId]/display — the negative cases", () => {
  it.each([
    ["draft", "draft"],
    ["proofing", "proofing"],
    ["selected", "selected"],
    ["archived", "archived"],
  ])("refuses a client while the gallery is %s", async (_label, status) => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "display_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
    expect(objectExistsMock).not.toHaveBeenCalled();
  });

  it("refuses an asset the client never selected, even in a delivered gallery", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "display_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses an asset the photographer has not marked edited", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isEdited: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses an asset with no final at all — the mixed-gallery case", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ finalKey: null, isEdited: false, isSelected: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/assets/[assetId]/display — the admin carve-out", () => {
  // Inherited verbatim from the download's gate (task #26, via #63's
  // review): the photographer can preview before flipping to `delivered`.
  // Asserted here because this route SHARES that gate — if the shared
  // predicate ever loses the carve-out, this goes red alongside the final
  // route's own equivalent test, which is the whole point of sharing it.
  it("serves an admin before delivery, so the photographer can preview their own upload", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "proofing" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(getPresignedUrlMock).toHaveBeenCalledWith(DISPLAY_KEY);
  });

  it("still refuses an admin for an asset the client never selected", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });
});

// Finals uploaded BEFORE task #89 shipped have no display object until
// `bun run backfill:display` runs. `displayKey` is deterministic, so nothing
// in the database records that — one HEAD request does, on this path only.
describe("GET /api/assets/[assetId]/display — a derivative that was never generated", () => {
  it("returns a distinct 404 instead of a presigned URL for an object that is not there", async () => {
    authMock.mockResolvedValue(clientASession());
    objectExistsMock.mockResolvedValue(false);
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    // A DIFFERENT error code from the gate's own refusal — the client falls
    // back to the proof either way, but an operator reading logs needs to
    // tell "this client was refused" apart from "the backfill has not run".
    await expect(response.json()).resolves.toEqual({ error: "display_not_generated" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("checks existence against the DISPLAY key, not the final's", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(objectExistsMock).toHaveBeenCalledTimes(1);
    expect(objectExistsMock).toHaveBeenCalledWith(DISPLAY_KEY);
  });

  // The probe costs an R2 round trip, so it must never run for a caller the
  // gate already refused — otherwise an unauthorized request would still be
  // able to make this app talk to R2 once per attempt.
  it("does not probe R2 at all for a caller the gate refuses", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(objectExistsMock).not.toHaveBeenCalled();
  });
});
