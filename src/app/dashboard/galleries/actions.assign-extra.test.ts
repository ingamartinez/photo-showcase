import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Task #223 — `assignExtraToPerson`: which person a photographer-gifted EXTRA
// belongs to (`assets.delivered_for`).
//
// Same mock scaffolding as every sibling actions.*.test.ts in this directory
// (see actions.selection-tray-mode.test.ts's own comments for why each of
// these is needed); the DB double below is the same shape, widened to the
// three tables this action actually reads: `assets`, `gallery_clients` and
// `galleries`.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: vi.fn().mockResolvedValue(undefined),
}));

type Row = Record<string, unknown>;
type LeafCondition = { dbColumnName: string; value: unknown };

/** Flattens an `eq()` leaf, or an `and(...)` of them, into plain comparisons.
 * `and()` support is what this suite needs beyond the sibling harness: the
 * gallery-membership check is a three-way `and(galleryId, userId,
 * isNull(removedAt))`. */
function leavesOf(node: unknown): LeafCondition[] {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return [];

  const nested = chunks.filter(
    (chunk) => chunk && typeof chunk === "object" && "queryChunks" in chunk,
  );
  if (nested.length > 0) return nested.flatMap(leavesOf);

  let dbColumnName: string | undefined;
  let value: unknown;
  let hasValue = false;
  let isNullCheck = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) dbColumnName = (chunk as { name: string }).name;
      // `isNull()` renders as a StringChunk whose `.value` is the ARRAY
      // `[" is null"]` — NOT a raw string. An earlier version of this helper
      // tested `typeof chunk === "string"`, never matched, and silently
      // dropped the `removedAt` leg from every condition it parsed: the
      // "refuses a removed client" test below then passed the action a
      // membership row it should never have found, and reported the action
      // as broken when the harness was. Verified against the real drizzle
      // condition tree, not assumed.
      if ("value" in chunk && !("encoder" in chunk)) {
        const rendered = (chunk as { value: unknown }).value;
        const text = Array.isArray(rendered) ? rendered.join("") : String(rendered);
        if (text.includes("is null")) isNullCheck = true;
      }
      if ("value" in chunk && "encoder" in chunk) {
        value = (chunk as { value: unknown }).value;
        hasValue = true;
      }
    }
  }
  if (!dbColumnName) return [];
  if (isNullCheck && !hasValue) return [{ dbColumnName, value: null }];
  if (!hasValue) return [];
  return [{ dbColumnName, value }];
}

function jsKeyFor(table: Record<string, unknown>, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`jsKeyFor: no column named ${dbColumnName} on this table`);
  return found[0];
}

function matchesRow(row: Row, table: Record<string, unknown>, condition: unknown): boolean {
  const leaves = leavesOf(condition);
  if (leaves.length === 0) throw new Error("matchesRow: could not parse condition");
  return leaves.every((leaf) => {
    const jsKey = jsKeyFor(table, leaf.dbColumnName);
    return (row[jsKey] ?? null) === leaf.value;
  });
}

function project(row: Row, columns: Record<string, unknown> | undefined): Row {
  if (!columns) return { ...row };
  const projected: Row = {};
  for (const key of Object.keys(columns)) projected[key] = row[key];
  return projected;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries, galleryClients } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryClientRows: Row[] = [];
  const galleryRows: Row[] = [];

  const tables = new Map<unknown, { rows: Row[]; table: Record<string, unknown> }>([
    [assets, { rows: assetRows, table: assets as unknown as Record<string, unknown> }],
    [
      galleryClients,
      { rows: galleryClientRows, table: galleryClients as unknown as Record<string, unknown> },
    ],
    [galleries, { rows: galleryRows, table: galleries as unknown as Record<string, unknown> }],
  ]);

  function resolve(table: unknown) {
    const entry = tables.get(table);
    if (!entry) throw new Error("fake db: unsupported table");
    return entry;
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const { rows, table: schemaTable } = resolve(table);
            const matched = rows
              .filter((row) => matchesRow(row, schemaTable, condition))
              .map((row) => project(row, columns));
            const resultPromise = Promise.resolve(matched);
            return {
              limit: async (n: number) => matched.slice(0, n),
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
            };
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            const { rows, table: schemaTable } = resolve(table);
            const matched = rows.filter((row) => matchesRow(row, schemaTable, condition));
            for (const row of matched) Object.assign(row, patch);
            return Promise.resolve(matched.map((row) => ({ ...row })));
          },
        }),
      }),
      __rows: { assets: assetRows, galleryClients: galleryClientRows, galleries: galleryRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { assets: Row[]; galleryClients: Row[]; galleries: Row[] };
    };
  };
  return db;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const STRANGER_ID = "55555555-5555-4555-8555-555555555555";

function formDataFor(assetId: string, deliveredFor: string): FormData {
  const formData = new FormData();
  formData.set("assetId", assetId);
  formData.set("deliveredFor", deliveredFor);
  return formData;
}

async function seedGalleryWithExtra(overrides: { isExtra?: boolean } = {}) {
  const db = await seededDb();
  db.__rows.assets.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.length = 0;

  db.__rows.assets.push({
    id: ASSET_ID,
    galleryId: GALLERY_ID,
    isExtra: overrides.isExtra ?? true,
    deliveredFor: null,
    isSelected: false,
  });
  db.__rows.galleryClients.push({
    galleryId: GALLERY_ID,
    userId: CLIENT_ID,
    removedAt: null,
  });
  db.__rows.galleries.push({ id: GALLERY_ID, publicSlug: "abc123" });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(adminSession());
});

describe("assignExtraToPerson", () => {
  it("assigns an active gallery client to an extra", async () => {
    const db = await seedGalleryWithExtra();
    const { assignExtraToPerson } = await import("./actions");

    const result = await assignExtraToPerson({ status: "idle" }, formDataFor(ASSET_ID, CLIENT_ID));

    expect(result.status).toBe("updated");
    expect(db.__rows.assets[0]?.deliveredFor).toBe(CLIENT_ID);
  });

  // THE BILLING BOUNDARY AGAIN, restated at the write site the admin drives:
  // assigning a person is an ATTRIBUTION, never a purchase. If this action
  // ever touched `isSelected`, `computeQuota` would start charging for gifts.
  it("never touches isSelected when assigning a person", async () => {
    const db = await seedGalleryWithExtra();
    const { assignExtraToPerson } = await import("./actions");

    await assignExtraToPerson({ status: "idle" }, formDataFor(ASSET_ID, CLIENT_ID));

    expect(db.__rows.assets[0]?.isSelected).toBe(false);
  });

  it("clears the attribution when 'sin asignar' is submitted", async () => {
    const db = await seedGalleryWithExtra();
    db.__rows.assets[0]!.deliveredFor = CLIENT_ID;
    const { assignExtraToPerson } = await import("./actions");

    const result = await assignExtraToPerson({ status: "idle" }, formDataFor(ASSET_ID, ""));

    expect(result.status).toBe("updated");
    expect(db.__rows.assets[0]?.deliveredFor).toBeNull();
  });

  // THE REFUSAL THAT MATTERS. Without the membership check, any `users.id`
  // the admin's browser submitted would be accepted — including a client of
  // somebody ELSE's gallery, whose name the client-facing surface would then
  // render as a group header on a gallery they have nothing to do with.
  it("refuses a person who is not a client of this gallery, and writes nothing", async () => {
    const db = await seedGalleryWithExtra();
    db.__rows.galleryClients.push({
      galleryId: OTHER_GALLERY_ID,
      userId: STRANGER_ID,
      removedAt: null,
    });
    const { assignExtraToPerson } = await import("./actions");

    const result = await assignExtraToPerson(
      { status: "idle" },
      formDataFor(ASSET_ID, STRANGER_ID),
    );

    expect(result.status).toBe("error");
    expect(db.__rows.assets[0]?.deliveredFor).toBeNull();
  });

  // A removed client is not an active one. `gallery_clients.removed_at` is
  // how this app retires an attachment without deleting history, and every
  // other reader of that table filters on it — this one has to as well, or a
  // person who was taken off the gallery could still be credited on it.
  it("refuses a client whose attachment to the gallery was removed", async () => {
    const db = await seedGalleryWithExtra();
    db.__rows.galleryClients[0]!.removedAt = new Date("2026-08-01");
    const { assignExtraToPerson } = await import("./actions");

    const result = await assignExtraToPerson({ status: "idle" }, formDataFor(ASSET_ID, CLIENT_ID));

    expect(result.status).toBe("error");
    expect(db.__rows.assets[0]?.deliveredFor).toBeNull();
  });

  // `delivered_for` is meaningless on anything that is not an extra
  // (schema.ts). Accepting it on an ordinary pick would put a value in the
  // database that no read site consults and a later reader could misread.
  it("refuses an asset that is not an extra", async () => {
    const db = await seedGalleryWithExtra({ isExtra: false });
    const { assignExtraToPerson } = await import("./actions");

    const result = await assignExtraToPerson({ status: "idle" }, formDataFor(ASSET_ID, CLIENT_ID));

    expect(result.status).toBe("error");
    expect(db.__rows.assets[0]?.deliveredFor).toBeNull();
  });

  it("refuses a malformed asset id without touching the database", async () => {
    const db = await seedGalleryWithExtra();
    const { assignExtraToPerson } = await import("./actions");

    const result = await assignExtraToPerson(
      { status: "idle" },
      formDataFor("not-a-uuid", CLIENT_ID),
    );

    expect(result.status).toBe("error");
    expect(db.__rows.assets[0]?.deliveredFor).toBeNull();
  });

  it("revalidates both the dashboard detail page and the client gallery", async () => {
    await seedGalleryWithExtra();
    const { assignExtraToPerson } = await import("./actions");

    await assignExtraToPerson({ status: "idle" }, formDataFor(ASSET_ID, CLIENT_ID));

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
  });
});
