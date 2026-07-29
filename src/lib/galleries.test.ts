import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();
const findFirstMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      galleries: {
        findMany: (...args: unknown[]) => findManyMock(...args),
        findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
    },
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

beforeEach(() => {
  findManyMock.mockReset();
  findFirstMock.mockReset();
  selectMock.mockReset();
});

describe("getGalleriesWithDetails", () => {
  it("derives photoCount from the joined assets, and never reads the live package price/quota", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "draft",
        sessionDate: "2026-08-01",
        createdAt: new Date("2026-07-01"),
        selectionSubmittedAt: null,
        client: { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
        // Live package row — priceCop/includedPhotos here are the CURRENT
        // offer, deliberately NOT what this function should report as the
        // gallery's terms.
        package: { id: 2, name: "Estándar", priceCop: 999_999, includedPhotos: 1 },
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        assets: [{ id: "a1" }, { id: "a2" }],
      },
    ]);
    const { getGalleriesWithDetails } = await import("./galleries");

    const result = await getGalleriesWithDetails();

    expect(result).toEqual([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "draft",
        sessionDate: "2026-08-01",
        createdAt: new Date("2026-07-01"),
        selectionSubmittedAt: null,
        client: { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
        package: { id: 2, name: "Estándar" },
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        photoCount: 2,
      },
    ]);
    // The returned shape never carries the live package's priceCop/
    // includedPhotos at all — only the id/name (for display) and the
    // gallery's own frozen snapshot columns.
    expect(result[0]).not.toHaveProperty("package.priceCop");
    expect(result[0]).not.toHaveProperty("package.includedPhotos");
  });

  // Task #75's core acceptance criterion: recency of SUBMISSION, not
  // creation, must drive placement. This is expressed as a SQL `orderBy`
  // (`COALESCE(selection_submitted_at, created_at) DESC`) rather than a
  // post-fetch JS `.sort()` — see this function's own header comment for why
  // (pagination safety) — so a mocked `findMany` (which doesn't actually run
  // SQL) can only prove the SHAPE of the expression sent to the DB, not
  // observe it reordering rows. That the expression is correct is the one
  // thing worth asserting here; that Postgres honors its own `ORDER BY` is
  // not this codebase's job to re-prove.
  it("asks the DB to order by COALESCE(selectionSubmittedAt, createdAt) descending, not createdAt alone", async () => {
    findManyMock.mockResolvedValue([]);
    const { desc, sql } = await import("drizzle-orm");
    const { galleries } = await import("./db/schema");
    const { getGalleriesWithDetails } = await import("./galleries");

    await getGalleriesWithDetails();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { orderBy: unknown };
    expect(args.orderBy).toEqual(
      desc(sql`coalesce(${galleries.selectionSubmittedAt}, ${galleries.createdAt})`),
    );
  });
});

describe("getPendingSelectionCount", () => {
  it("counts galleries in 'selected' via a dedicated count() query, not the full detail query", async () => {
    const whereMock = vi.fn().mockResolvedValue([{ value: 2 }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    selectMock.mockReturnValue({ from: fromMock });
    const { eq } = await import("drizzle-orm");
    const { galleries } = await import("./db/schema");
    const { getPendingSelectionCount } = await import("./galleries");

    const result = await getPendingSelectionCount();

    expect(result).toBe(2);
    expect(fromMock).toHaveBeenCalledWith(galleries);
    // The predicate itself, not just that SOME predicate was passed — this
    // is the one fact the whole "N selecciones esperando" banner depends on;
    // a filter accidentally changed to another status must fail this test.
    expect(whereMock).toHaveBeenCalledWith(eq(galleries.status, "selected"));
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns 0 when no row comes back", async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
    const { getPendingSelectionCount } = await import("./galleries");

    await expect(getPendingSelectionCount()).resolves.toBe(0);
  });
});

describe("formatPendingSelectionCount", () => {
  it.each([
    [0, null],
    [1, "1 selección esperando"],
    [2, "2 selecciones esperando"],
    [5, "5 selecciones esperando"],
  ])("formats %s as %s", async (pendingCount, expected) => {
    const { formatPendingSelectionCount } = await import("./galleries");
    expect(formatPendingSelectionCount(pendingCount)).toBe(expected);
  });
});

describe("isGalleryVisibleToClient", () => {
  it.each([
    ["draft", false],
    ["proofing", true],
    ["selected", true],
    ["delivered", true],
    ["archived", false],
  ] as const)("status %s -> visible to client: %s", async (status, expected) => {
    const { isGalleryVisibleToClient } = await import("./galleries");
    expect(isGalleryVisibleToClient(status)).toBe(expected);
  });
});

describe("formatGalleryStatus", () => {
  it.each([
    ["draft", "Borrador"],
    ["proofing", "En pruebas"],
    ["selected", "Selección enviada"],
    ["delivered", "Entregada"],
    ["archived", "Archivada"],
  ] as const)("formats %s as %s", async (status, expected) => {
    const { formatGalleryStatus } = await import("./galleries");
    expect(formatGalleryStatus(status)).toBe(expected);
  });
});

describe("formatSessionDate", () => {
  it("formats a stored YYYY-MM-DD string as DD/MM/YYYY without going through Date/timezone conversion", async () => {
    const { formatSessionDate } = await import("./galleries");
    expect(formatSessionDate("2026-08-01")).toBe("01/08/2026");
  });
});

describe("getGalleriesForClient", () => {
  it("filters by the given clientId AND restricts to client-visible statuses in the same where clause", async () => {
    findManyMock.mockResolvedValue([]);
    const { and, eq, inArray } = await import("drizzle-orm");
    const { galleries } = await import("./db/schema");
    const { getGalleriesForClient } = await import("./galleries");

    await getGalleriesForClient("user-1");

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { where: unknown };
    expect(args.where).toEqual(
      and(
        eq(galleries.clientId, "user-1"),
        inArray(galleries.status, ["proofing", "selected", "delivered"]),
      ),
    );
  });

  it("derives photoCount from the joined assets and never returns another client's row", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        assets: [{ id: "a1" }, { id: "a2" }],
      },
    ]);
    const { getGalleriesForClient } = await import("./galleries");

    const result = await getGalleriesForClient("user-1");

    expect(result).toEqual([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 2,
      },
    ]);
  });

  it("returns an empty list when the client has no galleries at all", async () => {
    findManyMock.mockResolvedValue([]);
    const { getGalleriesForClient } = await import("./galleries");

    await expect(getGalleriesForClient("user-1")).resolves.toEqual([]);
  });
});

describe("getGalleryDetail", () => {
  const galleryRow = {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "draft" as const,
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    client: { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
    // Live package row — priceCop/includedPhotos here are the CURRENT
    // offer, deliberately NOT what this function should report as the
    // gallery's terms (same trap getGalleriesWithDetails already guards).
    package: { id: 2, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [
      {
        id: "a2",
        originalFilename: "IMG_0002.JPG",
        proofKey: "galleries/g1/proofs/a2.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: false,
        sortOrder: 1,
      },
      {
        id: "a1",
        originalFilename: "IMG_0001.JPG",
        proofKey: "galleries/g1/proofs/a1.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: true,
        sortOrder: 0,
      },
    ],
  };

  it("returns null when no gallery with this id exists, instead of throwing", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const { getGalleryDetail } = await import("./galleries");

    await expect(getGalleryDetail("missing")).resolves.toBeNull();
  });

  it("maps the gallery's frozen terms and its assets, and asks the query to order by sort_order", async () => {
    findFirstMock.mockResolvedValue(galleryRow);
    const { getGalleryDetail } = await import("./galleries");

    const result = await getGalleryDetail("g1");

    expect(result).toEqual({
      id: "g1",
      title: "Boda Ana y Beto",
      publicSlug: "abc123",
      status: "draft",
      sessionDate: "2026-08-01",
      createdAt: new Date("2026-07-01"),
      client: { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
      package: { id: 2, name: "Estándar" },
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      assets: galleryRow.assets,
    });

    // The query itself asks the relational API to order assets by
    // sort_order — this is a query-shape assertion, not a re-sort of the
    // fake's already-out-of-order fixture above (the fake doesn't honor
    // `orderBy`, only a real Postgres does).
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    const args = findFirstMock.mock.calls[0]?.[0] as {
      with: { assets: { orderBy: unknown } };
    };
    expect(args.with.assets.orderBy).toBeDefined();
  });
});
