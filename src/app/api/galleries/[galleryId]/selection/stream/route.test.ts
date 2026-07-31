import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively) only resolves inside a real Next.js
// bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// DELIBERATELY NOT MOCKED: `@/lib/gallery-access` — same reasoning as the
// sibling polling route's own suite (`../route.test.ts`): this stream is a
// data path (task #114's own constraint) and gets proven against the REAL
// `isGalleryOwner`, not a stubbed one, including the soft-removed-client case
// (task #97).
//
// MUTATION-PROVEN. Deleting the `if (!(await isGalleryOwner(...)))` block
// from the route makes "refuses a signed-in client who is not attached" and
// "refuses a client who was removed" both fail with a 200 (run and verified
// while writing these tests).
const subscribeMock = vi.fn<(galleryId: string, onChange: () => void) => Promise<() => void>>();
const unsubscribeSpy = vi.fn();
vi.mock("@/lib/selection-events", () => ({
  subscribeToSelectionChanges: (...args: [string, () => void]) => subscribeMock(...args),
}));

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
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function requestFor(galleryId: string): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${galleryId}/selection/stream`);
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

/** Reads every chunk the stream has ALREADY enqueued (does not wait for
 * more) and decodes it back to text — enough to assert on the `ready`
 * preamble without needing to wait on the heartbeat timer. */
async function readAvailable(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  // One read is enough: `start()` enqueues `ready` synchronously (after one
  // microtask for `subscribeToSelectionChanges`'s own `await`), well before
  // any timer fires.
  const { value } = await reader.read();
  await reader.cancel();
  return value ? decoder.decode(value) : "";
}

beforeEach(async () => {
  authMock.mockReset();
  subscribeMock.mockReset();
  unsubscribeSpy.mockReset();
  subscribeMock.mockResolvedValue(unsubscribeSpy);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a", removedAt: null });
});

describe("GET /api/galleries/[galleryId]/selection/stream — the guard", () => {
  it("returns 401 JSON, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in client who is not among the gallery's clients", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("refuses a client whose membership was SOFT-removed, exercising the real isGalleryOwner", async () => {
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
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it("hides a DRAFT gallery from its own client with the same 404 the polling route uses", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });

  it("lets an admin open the stream for a draft gallery, same carve-out as every sibling route", async () => {
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
  });
});

describe("GET /api/galleries/[galleryId]/selection/stream — the stream itself", () => {
  it("serves an attached client an event-stream response that opens with `ready`", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await readAvailable(response);
    expect(body).toBe("event: ready\ndata: 1\n\n");
  });

  it("subscribes to exactly this gallery's changes, only after both gates pass", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    await readAvailable(response);

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith(GALLERY_ID, expect.any(Function));
  });

  it("pushes a `changed` event when the subscribed callback fires", async () => {
    let onChange: (() => void) | undefined;
    subscribeMock.mockImplementation(async (_galleryId, cb) => {
      onChange = cb;
      return unsubscribeSpy;
    });
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the `ready` preamble first.
    await reader.read();
    expect(onChange).toBeDefined();

    onChange!();
    const { value } = await reader.read();
    expect(value ? decoder.decode(value) : "").toBe("event: changed\ndata: 1\n\n");

    await reader.cancel();
  });

  it("unsubscribes when the client disconnects, so a closed stream never leaks a listener", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    // `cancel()` on the stream's controller is what this asserts happened —
    // the ReadableStream's own `cancel(reason)` callback runs `unsubscribe()`.
    await vi.waitFor(() => expect(unsubscribeSpy).toHaveBeenCalledTimes(1));
  });
});
