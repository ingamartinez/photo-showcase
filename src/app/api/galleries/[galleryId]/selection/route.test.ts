import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// DELIBERATELY NOT MOCKED: `@/lib/gallery-access`.
//
// Task #95's own constraint is that a live channel must not become the one
// door with a weaker lock, so this suite exercises the REAL `isGalleryOwner`
// against a seeded `gallery_clients` table — the same choice
// src/app/api/assets/[assetId]/selection/route.test.ts makes for its sibling
// PATCH route, and a deliberately stronger one than the mock-the-helper
// approach the submit-selection suite uses. What that buys, concretely: the
// soft-removed-client case (task #97) is proven THROUGH this route, not just
// in the helper's own suite, and a future edit that reached around the helper
// to a hand-rolled comparison here would fail these tests.
//
// MUTATION-PROVEN. Deleting the `if (!(await isGalleryOwner(...)))` block from
// the route makes "refuses a signed-in client who is not attached" and
// "refuses a client who was removed" both fail with a 200 (run and verified
// while writing these tests, not asserted on faith).
const getGallerySelectionMock =
  vi.fn<(galleryId: string) => Promise<{ assetId: string; selectedAt: string | null }[]>>();
vi.mock("@/lib/gallery-selection", () => ({
  getGallerySelection: (...args: [string]) => getGallerySelectionMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering off
// drizzle's own `eq()`/`and()` condition objects, plus `isNull()`, which
// `isGalleryOwner` needs (`removedAt IS NULL`, task #97) and which no
// existing route suite's harness models explicitly.
type Row = Record<string, unknown>;

type Condition = { dbColumnName: string; kind: "eq" | "isNull"; value?: unknown };

function flattenChunks(node: unknown, out: unknown[]): void {
  if (node && typeof node === "object" && "queryChunks" in node) {
    for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) {
      flattenChunks(chunk, out);
    }
    return;
  }
  out.push(node);
}

/** Every column referenced by a condition, tagged with whether it is being
 * compared to a parameter (`eq`) or tested for NULL (`isNull`). Reading the
 * REAL condition object rather than intercepting the call is what makes a
 * dropped `isNull(removedAt)` visible to these tests instead of silent. */
function conditionsOf(condition: unknown): Condition[] {
  const flat: unknown[] = [];
  flattenChunks(condition, flat);

  const conditions: Condition[] = [];
  for (const chunk of flat) {
    if (!chunk || typeof chunk !== "object") continue;
    if ("name" in chunk && "table" in chunk) {
      conditions.push({ dbColumnName: (chunk as { name: string }).name, kind: "eq" });
    } else if ("value" in chunk && "encoder" in chunk) {
      const last = conditions.at(-1);
      if (last) last.value = (chunk as { value: unknown }).value;
    } else if (
      "value" in chunk &&
      typeof (chunk as { value: unknown }).value === "object" &&
      Array.isArray((chunk as { value: unknown[] }).value) &&
      (chunk as { value: string[] }).value.join("").includes("is null")
    ) {
      const last = conditions.at(-1);
      if (last) last.kind = "isNull";
    }
  }
  return conditions;
}

function jsKeyFor(table: Record<string, unknown>, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`jsKeyFor: no column named ${dbColumnName}`);
  return found[0];
}

vi.mock("@/lib/db", async () => {
  const { galleries, galleryClients } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  function shapeFor(table: unknown): Record<string, unknown> {
    if (table === galleries) return galleries as unknown as Record<string, unknown>;
    if (table === galleryClients) return galleryClients as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }
  function rowsFor(table: unknown): Row[] {
    if (table === galleries) return galleryRows;
    if (table === galleryClients) return galleryClientRows;
    throw new Error("fake db: unsupported table");
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const shape = shapeFor(table);
            const matched = rowsFor(table).filter((row) =>
              conditionsOf(condition).every(({ dbColumnName, kind, value }) => {
                const cell = row[jsKeyFor(shape, dbColumnName)];
                return kind === "isNull" ? cell === null || cell === undefined : cell === value;
              }),
            );
            const projected = columns
              ? matched.map((row) => {
                  const out: Row = {};
                  for (const key of Object.keys(columns)) out[key] = row[key];
                  return out;
                })
              : matched;
            return { limit: async (n: number) => projected.slice(0, n) };
          },
        }),
      }),
      __rows: { galleries: galleryRows, galleryClients: galleryClientRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; galleryClients: Row[] } };
  };
  return db;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

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
    id: GALLERY_ID,
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "proofing",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    originalPhotoPriceCopSnapshot: 2_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function requestFor(galleryId: string): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${galleryId}/selection`);
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  getGallerySelectionMock.mockReset();
  getGallerySelectionMock.mockResolvedValue([]);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a", removedAt: null });
});

describe("GET /api/galleries/[galleryId]/selection — the guard", () => {
  it("returns 401 JSON, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("refuses a signed-in client who is not among the gallery's clients", async () => {
    // THE acceptance criterion: a live channel gets the same lock as every
    // other route. `client-b` has a perfectly valid session and the gallery's
    // id — and gets nothing.
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    // And it never even asked for the selection — the refusal happens before
    // anybody's name is read out of the database.
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  it("refuses a client whose membership was SOFT-removed, exercising the real isGalleryOwner", async () => {
    // Task #97's soft delete: the `gallery_clients` row survives removal with
    // `removedAt` set. Proven through THIS route rather than only in the
    // helper's own suite, because "the row is still there" is exactly how a
    // new data path quietly keeps letting a removed client in.
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-a",
      removedAt: new Date("2026-07-29"),
    });
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
  });

  it("serves a client who IS attached to the gallery", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(getGallerySelectionMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("serves an admin regardless of which clients the gallery has", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
  });

  it("hides a DRAFT gallery from its own client with the same 404 the page uses", async () => {
    // PLAN.md §2: a draft gallery is not yet visible to a client, so neither
    // is its selection state. Same 404, not a 403 — a client fishing for
    // gallery ids learns nothing new.
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });

  it("lets an admin read a draft gallery's selection, same carve-out as every sibling route", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
  });

  it("rejects a malformed gallery id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_gallery_id" });
  });

  it("returns 404 for a gallery that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });
});

describe("GET /api/galleries/[galleryId]/selection — the snapshot", () => {
  it("reports the picks exactly as getGallerySelection resolved them", async () => {
    getGallerySelectionMock.mockResolvedValue([
      {
        assetId: "asset-1",
        selectedAt: "2026-07-30T12:00:00.000Z",
        pickedBy: { id: "client-b", label: "Beto Ruiz" },
      },
    ] as never);
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { picks: { assetId: string }[] };

    expect(body.picks).toEqual([
      {
        assetId: "asset-1",
        selectedAt: "2026-07-30T12:00:00.000Z",
        pickedBy: { id: "client-b", label: "Beto Ruiz" },
      },
    ]);
  });

  it("recomputes the quota from the number of picks and the gallery's FROZEN terms", async () => {
    // Never the live `packages` row — a gallery created under last year's
    // price list keeps last year's numbers forever (PLAN.md §3).
    getGallerySelectionMock.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({
        assetId: `asset-${i}`,
        selectedAt: null,
        pickedBy: null,
      })) as never,
    );
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as {
      quota: { selected: number; extras: number; surchargeCop: number };
    };

    // This fixture's picks carry no `selectionKind` at all (a pre-#206-shaped
    // mock, `as never` below) — the route treats anything that isn't
    // literally `"original"` as edited (see this route's own comment), so
    // all 15 count as edited with 0 originals here.
    expect(body.quota).toEqual({
      selected: 15,
      selectedEdited: 15,
      selectedOriginal: 0,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      extras: 2,
      originals: 0,
      extrasSurchargeCop: 10_000,
      originalsSurchargeCop: 0,
      surchargeCop: 10_000,
    });
  });

  // Task #206, criterion 4 — a mixed case verified end to end through THIS
  // route, with both summands non-zero and neither a multiple of the other,
  // so an implementation that drops either term (or lets an original draw
  // from the quota) reports a different, wrong total.
  it("splits picks by selectionKind before computing the quota, with both edited-extras and originals non-zero", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 7 }));
    getGallerySelectionMock.mockResolvedValue([
      ...Array.from({ length: 9 }, (_, i) => ({
        assetId: `edited-${i}`,
        selectedAt: null,
        pickedBy: null,
        selectionKind: "edited",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        assetId: `original-${i}`,
        selectedAt: null,
        pickedBy: null,
        selectionKind: "original",
      })),
    ] as never);
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as {
      quota: {
        selectedEdited: number;
        selectedOriginal: number;
        extras: number;
        originals: number;
        surchargeCop: number;
      };
    };

    // 9 edited -> 2 over the 7 included -> 2 * 5_000 = 10_000.
    // 3 originals -> 3 * 2_000 = 6_000 more, additive.
    // Total 16_000, reachable only by summing both terms.
    expect(body.quota.selectedEdited).toBe(9);
    expect(body.quota.selectedOriginal).toBe(3);
    expect(body.quota.extras).toBe(2);
    expect(body.quota.originals).toBe(3);
    expect(body.quota.surchargeCop).toBe(16_000);
  });

  it("reports the gallery's own status and submission timestamp — this is the live submit lock", async () => {
    // The field every OTHER open session reads to go read-only the moment one
    // client submits.
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(
      galleryRow({
        status: "selected",
        selectionSubmittedAt: new Date("2026-07-30T13:00:00.000Z"),
      }),
    );
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { status: string; submittedAt: string | null };

    expect(body.status).toBe("selected");
    expect(body.submittedAt).toBe("2026-07-30T13:00:00.000Z");
  });

  it("reports a null submission timestamp for a gallery still being picked", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { status: string; submittedAt: string | null };

    expect(body.status).toBe("proofing");
    expect(body.submittedAt).toBeNull();
  });

  it("returns no R2 key, no presigned URL and no slug — only what the tray needs", async () => {
    // Task #95's constraint: the tray reuses the grid's presigned URLs and
    // must never become a second way to obtain image bytes. Pinned as a shape
    // assertion so a convenience field added later fails loudly here.
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["picks", "quota", "status", "submittedAt"]);
  });
});
