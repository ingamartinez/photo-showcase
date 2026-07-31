import { beforeEach, describe, expect, it, vi } from "vitest";
import { eqColumnAndValue } from "@/lib/test/eq-column-and-value";

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

// Task #119: this used to carry a local copy of `eqColumnAndValue` that read
// the DB column name straight off the condition and indexed fixture rows
// with it directly — silently wrong for any column whose JS key and DB name
// differ. Only worked here by accident, because both assertions below
// compare `role`, where the two names coincide. Now shared via
// src/lib/test/eq-column-and-value.ts — see that module's own header comment
// for the full story, including why it throws instead of returning
// `undefined` for an unresolved column.

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

  // Task #97: a removed membership must not inflate this count — the query
  // itself asks the relational API to filter the `galleryClients` relation
  // to `removedAt IS NULL`, not a post-fetch `.filter()` (same shape as
  // galleries.test.ts's own `orderBy` shape assertion).
  it("asks the DB to filter the joined galleryClients relation to removedAt IS NULL", async () => {
    findManyMock.mockResolvedValue([]);
    const { isNull } = await import("drizzle-orm");
    const { galleryClients } = await import("./db/schema");
    const { getClientsWithGalleryCount } = await import("./clients");

    await getClientsWithGalleryCount();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as {
      with: { galleryClients: { where: unknown } };
    };
    expect(args.with.galleryClients.where).toEqual(isNull(galleryClients.removedAt));
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

// formatGalleryCount's tests moved to src/lib/format.test.ts (task #49) — it
// is no longer exported from this module, see that file's
// `formatClientGalleryCount`.

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

// formatClientCount's tests moved to src/lib/format.test.ts (task #122) — it
// is no longer exported from this module, see that file's section comment.
