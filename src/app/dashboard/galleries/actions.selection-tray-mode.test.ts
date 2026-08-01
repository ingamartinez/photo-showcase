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

// A minimal, genuinely-behaving double for `@/lib/db` — same shape
// actions.terms.test.ts already established for this exact action shape
// (a plain `eq()` UPDATE, no CAS guard, no state gate to race against).
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

function eqConditions(condition: unknown): LeafCondition[] {
  const leaf = parseLeaf(condition);
  if (leaf) return [leaf];
  throw new Error("eqConditions: expected a plain eq() condition");
}

function jsKeyFor(table: Record<string, unknown>, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`jsKeyFor: no column named ${dbColumnName} on this table`);
  return found[0];
}

function matchesRow(row: Row, table: Record<string, unknown>, condition: unknown): boolean {
  return eqConditions(condition).every((c) => {
    const jsKey = jsKeyFor(table, c.dbColumnName);
    return row[jsKey] === c.value;
  });
}

function project(row: Row, columns: Record<string, unknown> | undefined): Row {
  if (!columns) return { ...row };
  const projected: Row = {};
  for (const key of Object.keys(columns)) projected[key] = row[key];
  return projected;
}

vi.mock("@/lib/db", async () => {
  const { galleries } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            if (table !== galleries) throw new Error("fake db: unsupported table in select()");
            const rows = galleryRows
              .filter((row) =>
                matchesRow(row, galleries as unknown as Record<string, unknown>, condition),
              )
              .map((row) => project(row, columns));
            const resultPromise = Promise.resolve(rows);
            return {
              limit: async (n: number) => rows.slice(0, n),
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
            };
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            if (table !== galleries) throw new Error("fake db: unsupported table in update()");
            const matches = galleryRows.filter((row) =>
              matchesRow(row, galleries as unknown as Record<string, unknown>, condition),
            );
            for (const row of matches) Object.assign(row, patch);
            return Promise.resolve(matches.map((row) => ({ ...row })));
          },
        }),
      }),
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: { galleries: galleryRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[] } };
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

function galleryRow(overrides: Row = {}): Row {
  return {
    id: GALLERY_ID,
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "draft",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    termsOverridden: false,
    selectionTrayMode: "flat",
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    unlockedAt: null,
    unlockedByEmail: null,
    unlockReason: null,
    termsUpdatedAt: null,
    termsUpdatedByEmail: null,
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
  db.__rows.galleries.push(galleryRow());
});

describe("updateSelectionTrayMode authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { updateSelectionTrayMode } = await import("./actions");

    await expect(
      updateSelectionTrayMode(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ selectionTrayMode: "flat" });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { updateSelectionTrayMode } = await import("./actions");

    await expect(
      updateSelectionTrayMode(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("updateSelectionTrayMode validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a malformed gallery id, before ever querying the database", async () => {
    const { updateSelectionTrayMode } = await import("./actions");

    const result = await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: "not-a-uuid", selectionTrayMode: "by-person" }),
    );

    expect(result.status).toBe("error");
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { updateSelectionTrayMode } = await import("./actions");

    const result = await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });

  // The mutation-provable case: a value outside the Postgres enum (a typo, a
  // tampered form field) must be REJECTED, never silently written. Without
  // `z.enum(selectionTrayMode.enumValues)` this would fall straight through
  // to the UPDATE and either write garbage or throw a raw Postgres error.
  it("rejects a value that is not one of the two known modes", async () => {
    const db = await seededDb();
    const { updateSelectionTrayMode } = await import("./actions");

    const result = await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "grouped-somehow" }),
    );

    expect(result.status).toBe("error");
    expect(db.__rows.galleries[0]).toMatchObject({ selectionTrayMode: "flat" });
  });

  it("rejects a missing selectionTrayMode field", async () => {
    const { updateSelectionTrayMode } = await import("./actions");

    const result = await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
  });
});

describe("updateSelectionTrayMode success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession("photographer@example.com"));
  });

  it("saves the new mode for a draft gallery", async () => {
    const { updateSelectionTrayMode } = await import("./actions");
    const db = await seededDb();

    const result = await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({ selectionTrayMode: "by-person" });
  });

  // The task's own explicit acceptance criterion: no state gate, unlike
  // `publishGallery`/`unlockSelection`. `archived` — the state furthest from
  // "still being set up" — must work exactly like `draft`.
  it.each(["draft", "proofing", "selected", "delivered", "archived"])(
    "saves the new mode for a gallery in status %s — no state gate, by design",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries[0]!.status = status;
      const { updateSelectionTrayMode } = await import("./actions");

      const result = await updateSelectionTrayMode(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
      );

      expect(result).toEqual({ status: "updated" });
      expect(db.__rows.galleries[0]).toMatchObject({ selectionTrayMode: "by-person", status });
    },
  );

  it("can switch back from by-person to flat", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.selectionTrayMode = "by-person";
    const { updateSelectionTrayMode } = await import("./actions");

    const result = await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "flat" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({ selectionTrayMode: "flat" });
  });

  // THE MOST INVISIBLE FAILURE MODE (same as updateGalleryTerms's own
  // suite) — revalidating only the dashboard would leave the admin looking
  // at the new mode while the client's own gallery page kept serving the
  // router cache's stale layout. Both surfaces, asserted by exact path.
  it("revalidates BOTH the dashboard detail page and the client's own gallery page", async () => {
    const { updateSelectionTrayMode } = await import("./actions");

    await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
  });

  it("does not touch the frozen commercial terms or termsOverridden", async () => {
    const { updateSelectionTrayMode } = await import("./actions");
    const db = await seededDb();

    await updateSelectionTrayMode(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, selectionTrayMode: "by-person" }),
    );

    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      termsOverridden: false,
    });
  });
});
