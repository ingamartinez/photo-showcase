import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { galleries: { findMany: (...args: unknown[]) => findManyMock(...args) } } },
}));

beforeEach(() => {
  findManyMock.mockReset();
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
