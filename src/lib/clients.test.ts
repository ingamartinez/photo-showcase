import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findMany: (...args: unknown[]) => findManyMock(...args) } } },
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

  it("derives galleryCount from the joined galleries, never a stored count", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "u1",
        name: "Ana Pérez",
        email: "ana@example.com",
        phone: null,
        createdAt: new Date("2026-01-01"),
        galleries: [{ id: "g1" }, { id: "g2" }, { id: "g3" }],
      },
      {
        id: "u2",
        name: "Beto Ruiz",
        email: "beto@example.com",
        phone: "+57 300 000 0000",
        createdAt: new Date("2026-02-01"),
        galleries: [],
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
