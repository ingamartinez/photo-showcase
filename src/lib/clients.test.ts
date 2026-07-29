import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: { users: { findMany: (...args: unknown[]) => findManyMock(...args) } },
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

// Extracts { column, value } from a drizzle `eq(column, value)` SQL object by
// duck-typing its query chunks (a PgColumn-like chunk has `.name` + `.table`,
// a Param-like chunk has `.value` + `.encoder`) — proven against the real
// shape with a throwaway script before writing this test. Used so the
// assertion on `where` below fails for a REAL reason (wrong column, wrong
// value, or no filter at all) instead of trusting a mock that was simply
// told what to return.
function eqColumnAndValue(condition: unknown): { column?: string; value?: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  let column: string | undefined;
  let value: unknown;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) column = (chunk as { name: string }).name;
      if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
    }
  }
  return { column, value };
}

beforeEach(() => {
  findManyMock.mockReset();
  selectMock.mockReset();
});

describe("getClientsWithGalleryCount", () => {
  it("queries only role = client, not admins", async () => {
    findManyMock.mockResolvedValue([]);
    const { getClientsWithGalleryCount } = await import("./clients");

    await getClientsWithGalleryCount();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { where: unknown };
    expect(args.where).toBeDefined();
    expect(eqColumnAndValue(args.where)).toEqual({ column: "role", value: "client" });
  });

  it("derives galleryCount from the joined galleryClients membership rows, never a stored count", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "u1",
        name: "Ana Pérez",
        email: "ana@example.com",
        phone: null,
        createdAt: new Date("2026-01-01"),
        // Task #94: one row per gallery this client is attached to, via the
        // new `gallery_clients` join table — see this file's own updated
        // comment on `getClientsWithGalleryCount`'s query.
        galleryClients: [{ galleryId: "g1" }, { galleryId: "g2" }, { galleryId: "g3" }],
      },
      {
        id: "u2",
        name: "Beto Ruiz",
        email: "beto@example.com",
        phone: "+57 300 000 0000",
        createdAt: new Date("2026-02-01"),
        galleryClients: [],
      },
    ]);
    const { getClientsWithGalleryCount } = await import("./clients");

    const result = await getClientsWithGalleryCount();

    expect(result).toEqual([
      {
        id: "u1",
        name: "Ana Pérez",
        email: "ana@example.com",
        phone: null,
        createdAt: new Date("2026-01-01"),
        galleryCount: 3,
      },
      {
        id: "u2",
        name: "Beto Ruiz",
        email: "beto@example.com",
        phone: "+57 300 000 0000",
        createdAt: new Date("2026-02-01"),
        galleryCount: 0,
      },
    ]);
  });
});

describe("getClientsForPicker", () => {
  it("queries only role = client, not admins", async () => {
    findManyMock.mockResolvedValue([]);
    const { getClientsForPicker } = await import("./clients");

    await getClientsForPicker();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { where: unknown };
    expect(eqColumnAndValue(args.where)).toEqual({ column: "role", value: "client" });
  });

  it("sorts alphabetically by name, falling back to email when a client has no name", async () => {
    findManyMock.mockResolvedValue([
      { id: "u1", name: "Zoe", email: "zoe@example.com" },
      { id: "u2", name: null, email: "ana@example.com" },
      { id: "u3", name: "Beto", email: "beto@example.com" },
    ]);
    const { getClientsForPicker } = await import("./clients");

    const result = await getClientsForPicker();

    expect(result.map((c) => c.id)).toEqual(["u2", "u3", "u1"]);
  });
});

describe("formatGalleryCount", () => {
  it.each([
    [0, "Sin galerías todavía"],
    [1, "1 galería"],
    [2, "2 galerías"],
    [13, "13 galerías"],
  ])("formats %i as %s", async (count, expected) => {
    const { formatGalleryCount } = await import("./clients");
    expect(formatGalleryCount(count)).toBe(expected);
  });
});

describe("getClientCount", () => {
  it("counts users via a dedicated count() query scoped to role = client, not the full list query", async () => {
    const whereMock = vi.fn().mockResolvedValue([{ value: 2 }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    selectMock.mockReturnValue({ from: fromMock });
    const { eq } = await import("drizzle-orm");
    const { users } = await import("./db/schema");
    const { getClientCount } = await import("./clients");

    const result = await getClientCount();

    expect(result).toBe(2);
    expect(fromMock).toHaveBeenCalledWith(users);
    // Same reason as galleries.test.ts's getPendingSelectionCount test: the
    // predicate itself, not just that SOME predicate was passed — an admin
    // row must never be counted as a client.
    expect(whereMock).toHaveBeenCalledWith(eq(users.role, "client"));
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns 0 when no row comes back", async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
    const { getClientCount } = await import("./clients");

    await expect(getClientCount()).resolves.toBe(0);
  });
});

describe("formatClientCount", () => {
  it.each([
    [1, "1 cliente"],
    [2, "2 clientes"],
    [13, "13 clientes"],
  ])("formats %i as %s", async (clientCount, expected) => {
    const { formatClientCount } = await import("./clients");
    expect(formatClientCount(clientCount)).toBe(expected);
  });
});
