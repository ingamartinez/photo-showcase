import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Same boundary-mocking philosophy as ../proof/route.test.ts: R2 itself is
// proven for real elsewhere, `@/lib/asset-access` is left UNMOCKED so the
// real ownership check runs, and this suite's own job is the final-specific
// gate (selected AND delivered AND an object actually exists) plus the
// wiring above it.
const getPresignedUrlMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
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
  // Corrected version: resolves the JS property key through `table`'s own
  // entries instead of hardcoding a snake_case<->camelCase transform — see
  // src/app/api/galleries/[galleryId]/proofs/route.test.ts for the same
  // helper and its rationale. Not the older buggy copy in
  // src/app/dashboard/galleries/actions.test.ts.
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  return { column: jsKey, value };
}

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
    clientId: "client-a",
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
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/final`, { method: "GET" });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-final-url");
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  // Selected + delivered + a finalKey present — the fully-unlocked case.
  // Individual tests override one axis at a time to prove each gate is
  // independently enforced.
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow());
});

describe("GET /api/assets/[assetId]/final — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns 403 when a different client requests someone else's final", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("lets an admin read a delivered, selected final regardless of gallery ownership", async () => {
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(getPresignedUrlMock).toHaveBeenCalledWith(FINAL_KEY);
  });
});

describe("GET /api/assets/[assetId]/final — the final-specific gate", () => {
  it("serves the final for the owning client when selected + delivered + finalKey all hold", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://r2.example.com/presigned-final-url",
    });
    expect(getPresignedUrlMock).toHaveBeenCalledWith(FINAL_KEY);
  });

  it("refuses the owning client a final for an asset that was never selected", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses a selected asset's final before the gallery has been delivered", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "selected", deliveredAt: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses a selected, delivered asset when no final object was ever uploaded", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ finalKey: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  // Proofs and finals are different access rules (task #16) — this is the
  // asymmetry made explicit: the SAME asset is reachable at .../proof but
  // not yet at .../final purely because it hasn't been selected.
  it("still returns 404 for an unselected asset even for the owning client who could see its proof", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false, finalKey: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
  });
});

describe("GET /api/assets/[assetId]/final — validation and not-found", () => {
  it("rejects a malformed asset id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the asset does not exist", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });
});
