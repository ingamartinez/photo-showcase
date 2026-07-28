import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { packages: { findMany: (...args: unknown[]) => findManyMock(...args) } } },
}));

// Same duck-typing helper as src/lib/clients.test.ts — extracts { column,
// value } out of a drizzle `eq(column, value)` condition by its query chunks,
// so the assertion below fails for a REAL reason (wrong column/value, or no
// filter at all) instead of trusting a mock told what to return.
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

describe("getActivePackages", () => {
  it("queries only active = true — retired packages must leave the picker", async () => {
    findManyMock.mockResolvedValue([]);
    const { getActivePackages } = await import("./packages");

    await getActivePackages();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { where: unknown };
    expect(eqColumnAndValue(args.where)).toEqual({ column: "active", value: true });
  });

  it("maps rows to the picker shape — dropping the live terms — in the order the query returns them", async () => {
    findManyMock.mockResolvedValue([
      {
        id: 1,
        name: "Básico",
        priceCop: 60_000,
        includedPhotos: 7,
        extraPhotoPriceCop: 5_000,
        durationLabel: "1 h",
        active: true,
        sortOrder: 0,
      },
      {
        id: 2,
        name: "Estándar",
        priceCop: 100_000,
        includedPhotos: 13,
        extraPhotoPriceCop: 5_000,
        durationLabel: "1.5–2 h",
        active: true,
        sortOrder: 1,
      },
    ]);
    const { getActivePackages } = await import("./packages");

    const result = await getActivePackages();

    // `toEqual` is exact here on purpose: the live terms present in the rows
    // above (priceCop, extraPhotoPriceCop, durationLabel) must NOT survive the
    // mapping. Those belong to `createGallery`'s own read of the package row;
    // anywhere else they are the bug the snapshot columns exist to prevent.
    expect(result).toEqual([
      { id: 1, name: "Básico", includedPhotos: 7 },
      { id: 2, name: "Estándar", includedPhotos: 13 },
    ]);
  });
});
