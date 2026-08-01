import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts,
// same stub as every sibling actions.*.test.ts in this directory.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale, same as every sibling suite: `auth()` (via
// requireAdmin()) and `signIn()` (never called by this action, but still
// imported at module scope by actions.ts for its sibling actions).
const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) at module scope, unresolvable under Vitest —
// mocked wholesale, same fix as every sibling actions.*.test.ts.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// `revalidatePath` throws outside a real Next.js request — stubbed so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// `@/lib/selection-events` is imported at module scope by actions.ts (for
// `unlockSelection`'s own notification, not this action) — mocked so
// importing the module never triggers a real Postgres NOTIFY.
vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: vi.fn().mockResolvedValue(undefined),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — this action is the
// ONLY one in this file's siblings that needs BOTH a `galleries` UPDATE and
// an `assets` UPDATE inside the SAME transaction (task #214's own "reset and
// flag flip in one transaction" requirement), so this double supports
// `and(eq(), eq())` (actions.attach.test.ts's own parser, extended) across
// TWO tables, with genuine rollback on a mid-transaction failure.
type Row = Record<string, unknown>;

type LeafCondition = { dbColumnName: string; op: "eq"; value: unknown };

function parseLeaf(node: unknown): LeafCondition | undefined {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return undefined;
  let dbColumnName: string | undefined;
  let value: unknown;
  let hasValue = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) dbColumnName = (chunk as { name: string }).name;
      if ("value" in chunk && "encoder" in chunk) {
        value = (chunk as { value: unknown }).value;
        hasValue = true;
      }
    }
  }
  if (!dbColumnName || !hasValue) return undefined;
  return { dbColumnName, op: "eq", value };
}

function walkConditions(node: unknown): LeafCondition[] {
  const leaf = parseLeaf(node);
  if (leaf) return [leaf];
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const results: LeafCondition[] = [];
  for (const chunk of chunks) results.push(...walkConditions(chunk));
  return results;
}

function conditions(condition: unknown): LeafCondition[] {
  const results = walkConditions(condition);
  if (results.length === 0) {
    throw new Error("conditions: not a supported eq()/and(eq(), eq()) condition");
  }
  return results;
}

function jsKeyFor(table: Record<string, unknown>, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`jsKeyFor: no column named ${dbColumnName} on this table`);
  return found[0];
}

function matchesRow(row: Row, table: Record<string, unknown>, condition: unknown): boolean {
  return conditions(condition).every((c) => {
    const jsKey = jsKeyFor(table, c.dbColumnName);
    return row[jsKey] === c.value;
  });
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const assetRows: Row[] = [];

  function rowsFor(table: unknown): Row[] {
    if (table === galleries) return galleryRows;
    if (table === assets) return assetRows;
    throw new Error("fake db: unsupported table");
  }

  function tableShapeFor(table: unknown): Record<string, unknown> {
    if (table === galleries) return galleries as unknown as Record<string, unknown>;
    if (table === assets) return assets as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }

  // Test-only fault injection — one fault per statement, symmetric, same
  // reasoning as actions.attach.test.ts's own `faults` object: a single
  // fault on whichever statement happens to run second would only prove
  // atomicity by accident of statement order.
  const faults = { failNextAssetsUpdate: false, failNextGalleriesUpdate: false };

  const writeOps = {
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => {
          if (table === assets && faults.failNextAssetsUpdate) {
            faults.failNextAssetsUpdate = false;
            return Promise.reject(new Error("simulated failure resetting assets"));
          }
          if (table === galleries && faults.failNextGalleriesUpdate) {
            faults.failNextGalleriesUpdate = false;
            return Promise.reject(new Error("simulated failure updating gallery"));
          }
          const matches = rowsFor(table).filter((row) =>
            matchesRow(row, tableShapeFor(table), condition),
          );
          for (const row of matches) Object.assign(row, patch);
          return Promise.resolve();
        },
      }),
    }),
  };

  return {
    db: {
      ...writeOps,
      // Genuinely rolls back BOTH tables, rather than just invoking the
      // callback — same "snapshot, run, restore on throw" shape
      // actions.attach.test.ts's own fake established, extended to two
      // tables since this action's transaction touches both.
      transaction: async (fn: (tx: typeof writeOps) => Promise<unknown>) => {
        const galleriesSnapshot = galleryRows.map((row) => ({ ...row }));
        const assetsSnapshot = assetRows.map((row) => ({ ...row }));
        try {
          return await fn(writeOps);
        } catch (error) {
          galleryRows.length = 0;
          galleryRows.push(...galleriesSnapshot);
          assetRows.length = 0;
          assetRows.push(...assetsSnapshot);
          throw error;
        }
      },
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const rows = rowsFor(table)
              .filter((row) => matchesRow(row, tableShapeFor(table), condition))
              .map((row) => {
                if (!columns) return { ...row };
                const projected: Row = {};
                for (const key of Object.keys(columns)) projected[key] = row[key];
                return projected;
              });
            const resultPromise = Promise.resolve(rows);
            return {
              limit: async (n: number) => rows.slice(0, n),
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
            };
          },
        }),
      }),
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { galleries: galleryRows, assets: assetRows },
      __faults: faults,
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { galleries: Row[]; assets: Row[] };
      __faults: { failNextAssetsUpdate: boolean; failNextGalleriesUpdate: boolean };
    };
  };
  return db;
}

function adminSession(email = "photographer@example.com"): Session {
  return {
    user: { id: "admin-1", role: "admin", email },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientSession(): Session {
  return {
    user: { id: "client-1", role: "client", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";

function galleryRow(overrides: Row = {}): Row {
  return {
    id: GALLERY_ID,
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "proofing",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    originalPhotoPriceCopSnapshot: 2_000,
    termsOverridden: false,
    selectionTrayMode: "flat",
    allowsOriginalSelection: false,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function assetRow(overrides: Row = {}): Row {
  return {
    id: "asset-1",
    galleryId: GALLERY_ID,
    originalFilename: "IMG_0001.JPG",
    isSelected: true,
    selectionKind: "edited",
    ...overrides,
  };
}

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  revalidatePathMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__faults.failNextAssetsUpdate = false;
  db.__faults.failNextGalleriesUpdate = false;
});

describe("updateAllowsOriginalSelection authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { updateAllowsOriginalSelection } = await import("./actions");

    await expect(
      updateAllowsOriginalSelection(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "true" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: false });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { updateAllowsOriginalSelection } = await import("./actions");

    await expect(
      updateAllowsOriginalSelection(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "true" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("updateAllowsOriginalSelection validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a malformed gallery id, before ever querying the database", async () => {
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: "not-a-uuid", allowsOriginalSelection: "true" }),
    );

    expect(result.status).toBe("error");
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "true" }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });

  // The mutation-provable case: a value outside the `"true"`/`"false"` pair
  // (a typo, a tampered form field) must be REJECTED, never silently treated
  // as either boolean.
  it("rejects a value that is not exactly true or false", async () => {
    const db = await seededDb();
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "yes" }),
    );

    expect(result.status).toBe("error");
    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: false });
  });

  it("rejects a missing allowsOriginalSelection field", async () => {
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
  });
});

describe("updateAllowsOriginalSelection — turning ON", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("sets the flag to true and touches no asset", async () => {
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ selectionKind: "edited" }));
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "true" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: true });
    expect(db.__rows.assets[0]).toMatchObject({ selectionKind: "edited" });
  });

  it("revalidates both the dashboard detail page and the client's own gallery page", async () => {
    const { updateAllowsOriginalSelection } = await import("./actions");

    await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "true" }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
  });
});

describe("updateAllowsOriginalSelection — turning OFF", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    // Start from ON, since this is the "turn off" describe block.
  });

  it("sets the flag to false when there is nothing to reset", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: false });
  });

  // THE MUTATION THAT MATTERS MOST FOR THIS ACTION, per the task's own
  // mutation-proof list (#4): turning off resets every `original` asset to
  // `edited` AND flips the flag — both, not just the flag.
  it("resets every original asset in this gallery to edited AND flips the flag", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    db.__rows.assets.push(
      assetRow({ id: "asset-1", selectionKind: "original" }),
      assetRow({ id: "asset-2", selectionKind: "original" }),
      assetRow({ id: "asset-3", selectionKind: "edited" }),
    );
    const { updateAllowsOriginalSelection } = await import("./actions");

    const result = await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: false });
    expect(db.__rows.assets[0]).toMatchObject({ id: "asset-1", selectionKind: "edited" });
    expect(db.__rows.assets[1]).toMatchObject({ id: "asset-2", selectionKind: "edited" });
    // Was already edited — untouched, not merely left the same by accident.
    expect(db.__rows.assets[2]).toMatchObject({ id: "asset-3", selectionKind: "edited" });
  });

  it("resets an original asset regardless of isSelected — the column is meaningless while unselected, but must not survive stale", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    db.__rows.assets.push(
      assetRow({ id: "asset-1", isSelected: false, selectionKind: "original" }),
    );
    const { updateAllowsOriginalSelection } = await import("./actions");

    await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
    );

    expect(db.__rows.assets[0]).toMatchObject({ selectionKind: "edited" });
  });

  it("never touches an original asset belonging to a DIFFERENT gallery", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    db.__rows.assets.push(
      assetRow({ id: "asset-other", galleryId: OTHER_GALLERY_ID, selectionKind: "original" }),
    );
    const { updateAllowsOriginalSelection } = await import("./actions");

    await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
    );

    expect(db.__rows.assets[0]).toMatchObject({ selectionKind: "original" });
  });

  // ATOMICITY — the owner's own explicit requirement (task #214's kanban
  // body): "el reseteo de esos assets a edited y el apagado del flag van en
  // la MISMA transacción". If the assets reset fails partway through, the
  // flag must NOT flip either — an off switch with orphaned originals is
  // exactly the state this decision exists to prevent.
  it("does not flip the flag when the assets reset fails mid-transaction", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    db.__rows.assets.push(assetRow({ id: "asset-1", selectionKind: "original" }));
    db.__faults.failNextAssetsUpdate = true;
    const { updateAllowsOriginalSelection } = await import("./actions");

    await expect(
      updateAllowsOriginalSelection(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
      ),
    ).rejects.toThrow(/simulated failure resetting assets/);

    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: true });
    expect(db.__rows.assets[0]).toMatchObject({ selectionKind: "original" });
  });

  // The symmetric half of atomicity — if the flag flip itself fails, the
  // asset reset that already ran must not be left standing either.
  it("rolls back the assets reset when the flag flip fails mid-transaction", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    db.__rows.assets.push(assetRow({ id: "asset-1", selectionKind: "original" }));
    db.__faults.failNextGalleriesUpdate = true;
    const { updateAllowsOriginalSelection } = await import("./actions");

    await expect(
      updateAllowsOriginalSelection(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
      ),
    ).rejects.toThrow(/simulated failure updating gallery/);

    expect(db.__rows.galleries[0]).toMatchObject({ allowsOriginalSelection: true });
    expect(db.__rows.assets[0]).toMatchObject({ selectionKind: "original" });
  });

  it("revalidates both the dashboard detail page and the client's own gallery page", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    const { updateAllowsOriginalSelection } = await import("./actions");

    await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
  });

  it("does not touch the frozen commercial terms or termsOverridden", async () => {
    const db = await seededDb();
    db.__rows.galleries[0] = galleryRow({ allowsOriginalSelection: true });
    const { updateAllowsOriginalSelection } = await import("./actions");

    await updateAllowsOriginalSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, allowsOriginalSelection: "false" }),
    );

    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      termsOverridden: false,
    });
  });
});
