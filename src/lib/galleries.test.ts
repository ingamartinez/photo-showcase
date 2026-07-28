import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();
const findFirstMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      galleries: {
        findMany: (...args: unknown[]) => findManyMock(...args),
        findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
    },
  },
}));

beforeEach(() => {
  findManyMock.mockReset();
  findFirstMock.mockReset();
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

  it("orders by createdAt descending", async () => {
    findManyMock.mockResolvedValue([]);
    const { getGalleriesWithDetails } = await import("./galleries");

    await getGalleriesWithDetails();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { orderBy: unknown };
    expect(args.orderBy).toBeDefined();
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

describe("formatCop", () => {
  it("formats a whole-COP amount without decimals", async () => {
    const { formatCop } = await import("./galleries");
    // Intl inserts a non-breaking space between the symbol and the digits in
    // the "es-CO" locale — normalize whitespace instead of asserting the
    // exact byte, since that's an ICU implementation detail, not part of
    // this function's contract.
    expect(formatCop(5_000).replace(/\s/g, " ")).toBe("$ 5.000");
  });

  it("never renders a decimal point for a round amount", async () => {
    const { formatCop } = await import("./galleries");
    expect(formatCop(150_000)).not.toContain(",00");
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
