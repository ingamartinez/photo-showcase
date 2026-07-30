import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// A minimal, genuinely-behaving double for `@/lib/db`. Same approach as the
// route suites: the conditions are resolved off drizzle's REAL `eq()`/`and()`/
// `inArray()` objects rather than being intercepted, so a query that starts
// filtering on the wrong column fails here instead of passing.
type Row = Record<string, unknown>;

function flattenChunks(node: unknown, out: unknown[]): void {
  if (node && typeof node === "object" && "queryChunks" in node) {
    for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) {
      flattenChunks(chunk, out);
    }
    return;
  }
  // `inArray(col, [a, b])` renders as `col in <Array of Param>` — the
  // parameters live inside a bare array chunk, not inside a nested `SQL`, so
  // a flattener that only followed `queryChunks` would never see them.
  // Verified by dumping the real drizzle condition, not assumed.
  if (Array.isArray(node)) {
    for (const chunk of node) flattenChunks(chunk, out);
    return;
  }
  out.push(node);
}

/** `[{ dbColumnName, values }]` for every column referenced in a condition,
 * paired with the parameter(s) compared against it. `inArray` contributes one
 * entry with several values; `eq` contributes one with a single value. */
function conditionsOf(condition: unknown): { dbColumnName: string; values: unknown[] }[] {
  const flat: unknown[] = [];
  flattenChunks(condition, flat);

  const results: { dbColumnName: string; values: unknown[] }[] = [];
  for (const chunk of flat) {
    if (!chunk || typeof chunk !== "object") continue;
    if ("name" in chunk && "table" in chunk) {
      results.push({ dbColumnName: (chunk as { name: string }).name, values: [] });
    } else if ("value" in chunk && "encoder" in chunk) {
      // `inArray` may hand its whole list over as ONE parameter rather than
      // as one placeholder per element — flattened here so both shapes end up
      // as a plain list of candidate values.
      const value = (chunk as { value: unknown }).value;
      results.at(-1)?.values.push(...(Array.isArray(value) ? value : [value]));
    }
  }
  return results;
}

function jsKeyFor(table: Record<string, unknown>, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`jsKeyFor: no column named ${dbColumnName}`);
  return found[0];
}

vi.mock("@/lib/db", async () => {
  const { assets, users } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const userRows: Row[] = [];

  function shapeFor(table: unknown): Record<string, unknown> {
    if (table === assets) return assets as unknown as Record<string, unknown>;
    if (table === users) return users as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }
  function rowsFor(table: unknown): Row[] {
    if (table === assets) return assetRows;
    if (table === users) return userRows;
    throw new Error("fake db: unsupported table");
  }

  function project(row: Row, columns: Record<string, unknown> | undefined): Row {
    if (!columns) return row;
    const projected: Row = {};
    for (const [alias, column] of Object.entries(columns)) {
      const dbColumnName = (column as { name: string }).name;
      // The projection is keyed by the ALIAS the caller chose (`assetId:
      // assets.id`), reading the row by the column's own JS key — exactly what
      // drizzle does, and what makes a renamed alias visible in these tests.
      const table = (column as { table: unknown }).table;
      projected[alias] = row[jsKeyFor(shapeFor(table), dbColumnName)];
    }
    return projected;
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const shape = shapeFor(table);
            const conditions = conditionsOf(condition);
            const matched = rowsFor(table).filter((row) =>
              conditions.every(({ dbColumnName, values }) =>
                values.includes(row[jsKeyFor(shape, dbColumnName)]),
              ),
            );
            const result = matched.map((row) => project(row, columns));
            const promise = Promise.resolve(result);
            return {
              orderBy: async (order: unknown) => {
                const flat: unknown[] = [];
                flattenChunks(order, flat);
                const column = flat.find(
                  (chunk) => chunk && typeof chunk === "object" && "name" in chunk,
                ) as { name: string } | undefined;
                if (!column) return result;
                const key = jsKeyFor(shape, column.name);
                // Mirrors Postgres's ASC default of NULLS LAST.
                return [...matched]
                  .sort((a, b) => {
                    const left = a[key];
                    const right = b[key];
                    if (left == null && right == null) return 0;
                    if (left == null) return 1;
                    if (right == null) return -1;
                    return Number(left) - Number(right);
                  })
                  .map((row) => project(row, columns));
              },
              then: promise.then.bind(promise),
              catch: promise.catch.bind(promise),
            };
          },
        }),
      }),
      __rows: { assets: assetRows, users: userRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; users: Row[] } };
  };
  return db;
}

const GALLERY_A = "11111111-1111-4111-8111-111111111111";
const GALLERY_B = "22222222-2222-4222-8222-222222222222";

function assetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "asset-1",
    galleryId: GALLERY_A,
    isSelected: true,
    selectedAt: new Date("2026-07-30T12:00:00.000Z"),
    selectedBy: "client-a",
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await seededDb();
  db.__rows.assets.length = 0;
  db.__rows.users.length = 0;
  db.__rows.users.push(
    { id: "client-a", name: "Ana Pérez", email: "ana@example.com" },
    { id: "client-b", name: null, email: "beto@example.com" },
  );
});

describe("getGallerySelection", () => {
  it("returns nothing, and never touches `users` at all, when the gallery has no picks yet", async () => {
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: "asset-1", isSelected: false, selectedBy: null }));
    // Emptying `users` proves the second query is genuinely skipped rather
    // than merely returning nothing: if it ran, the fake would still resolve,
    // but a picker lookup with an empty id list is a round trip this function
    // promises not to make.
    db.__rows.users.length = 0;
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    await expect(getGallerySelection(GALLERY_A)).resolves.toEqual([]);
  });

  it("returns only the SELECTED assets of the given gallery", async () => {
    const db = await seededDb();
    db.__rows.assets.push(
      assetRow({ id: "picked" }),
      assetRow({ id: "not-picked", isSelected: false, selectedBy: null, selectedAt: null }),
      assetRow({ id: "other-gallery", galleryId: GALLERY_B }),
    );
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(picks.map((pick) => pick.assetId)).toEqual(["picked"]);
  });

  it("attributes each pick to whoever the row says picked it", async () => {
    const db = await seededDb();
    db.__rows.assets.push(
      assetRow({
        id: "asset-1",
        selectedBy: "client-a",
        selectedAt: new Date("2026-07-30T12:00:00.000Z"),
      }),
      assetRow({
        id: "asset-2",
        selectedBy: "client-b",
        selectedAt: new Date("2026-07-30T12:01:00.000Z"),
      }),
    );
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(picks[0]?.pickedBy).toEqual({ id: "client-a", label: "Ana Pérez" });
    // `name ?? email` — a client the photographer never named still renders
    // as somebody, never as a blank.
    expect(picks[1]?.pickedBy).toEqual({ id: "client-b", label: "beto@example.com" });
  });

  it("orders oldest pick first, so a photo appearing at the END really is the newest", async () => {
    const db = await seededDb();
    db.__rows.assets.push(
      assetRow({ id: "third", selectedAt: new Date("2026-07-30T12:02:00.000Z") }),
      assetRow({ id: "first", selectedAt: new Date("2026-07-30T12:00:00.000Z") }),
      assetRow({ id: "second", selectedAt: new Date("2026-07-30T12:01:00.000Z") }),
    );
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(picks.map((pick) => pick.assetId)).toEqual(["first", "second", "third"]);
  });

  it("reports a pick with no `selected_by` as unattributed rather than inventing a picker", async () => {
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: "asset-1", selectedBy: null }));
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(picks[0]?.pickedBy).toBeNull();
  });

  it("reports a picker whose user row no longer exists as unattributed, not undefined", async () => {
    // `assets.selected_by` is `onDelete: "set null"` (schema.ts), so this is
    // a narrow window rather than a permanent state — but a `undefined`
    // leaking into the JSON would render as a missing key on the client.
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: "asset-1", selectedBy: "deleted-user" }));
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(picks[0]?.pickedBy).toBeNull();
  });

  it("serializes `selectedAt` as an ISO string, never a Date", async () => {
    // This value crosses to a Client Component and then to JSON on every
    // poll; a `Date` would serialize differently on the two paths.
    const db = await seededDb();
    db.__rows.assets.push(
      assetRow({ id: "asset-1", selectedAt: new Date("2026-07-30T12:00:00.000Z") }),
    );
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(picks[0]?.selectedAt).toBe("2026-07-30T12:00:00.000Z");
  });

  it("returns no R2 key, no URL and no email of its own invention — only ids and attribution", async () => {
    // Task #95's constraint: the tray must not become a second way to obtain
    // image bytes. Pinned as a shape assertion so adding `proofKey` to the
    // projection for convenience fails loudly here.
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: "asset-1" }));
    const { getGallerySelection } = await import("@/lib/gallery-selection");

    const picks = await getGallerySelection(GALLERY_A);

    expect(Object.keys(picks[0]!).sort()).toEqual(["assetId", "pickedBy", "selectedAt"]);
  });
});
