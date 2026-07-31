import { beforeEach, describe, expect, it, vi } from "vitest";
import { eqColumnAndValue } from "@/lib/test/eq-column-and-value";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

const findManyMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { packages: { findMany: (...args: unknown[]) => findManyMock(...args) } } },
}));

// Task #119: this used to carry a local copy of `eqColumnAndValue` that read
// the DB column name straight off the condition and indexed fixture rows
// with it directly — silently wrong for any column whose JS key and DB name
// differ. Only worked here by accident, because the assertion below compares
// `active`, where the two names coincide. Now shared via
// src/lib/test/eq-column-and-value.ts — see that module's own header comment
// for the full story, including why it throws instead of returning
// `undefined` for an unresolved column.

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
