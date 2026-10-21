import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts,
// same stub as every sibling actions.*.test.ts in this directory.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale, same as every sibling suite: `auth()` (via
// requireAdmin()) and `signIn()` (never CALLED by updateGalleryMeta itself —
// this slice's own "no email" decision — but still imported at module scope
// by actions.ts for its sibling actions, so it must resolve here regardless).
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

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering via a
// leaf-condition parser understanding a plain `eq()`. `update().set().where()`
// mirrors the real chain closely enough for this action: it records the last
// `set()` patch (the "only two columns" test reads it) and exposes
// `.returning()`, which projects the matched rows. `__afterSelect` lets a test
// delete the row between the action's own read and its write, reproducing the
// #282 race the `RETURNING` guard exists for.
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
  let lastPatch: Row | undefined;
  let afterSelect: (() => void) | undefined;

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
              limit: async (n: number) => {
                const sliced = rows.slice(0, n);
                // Runs AFTER this read resolves and BEFORE the caller's own
                // write — the exact window the race test needs.
                if (afterSelect) {
                  const hook = afterSelect;
                  afterSelect = undefined;
                  hook();
                }
                return sliced;
              },
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
            lastPatch = { ...patch };
            const matches = galleryRows.filter((row) =>
              matchesRow(row, galleries as unknown as Record<string, unknown>, condition),
            );
            for (const row of matches) Object.assign(row, patch);
            const returning = async (cols?: Record<string, unknown>) =>
              matches.map((row) => project(row, cols));
            const resultPromise = Promise.resolve(matches.map((row) => ({ ...row })));
            return {
              returning,
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
            };
          },
        }),
      }),
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { galleries: galleryRows },
      __lastPatch: () => lastPatch,
      __afterSelect: (fn: () => void) => {
        afterSelect = fn;
      },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { galleries: Row[] };
      __lastPatch: () => Row | undefined;
      __afterSelect: (fn: () => void) => void;
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
    extraPhotoPriceTiersSnapshot: null,
    originalPhotoPriceCopSnapshot: 2_000,
    termsOverridden: false,
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

function metaForm(overrides: Record<string, string | undefined> = {}) {
  return formDataWith({
    galleryId: GALLERY_ID,
    title: "Boda Ana y Beto — corregida",
    sessionDate: "2026-12-31",
    ...overrides,
  });
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

describe("updateGalleryMeta authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { updateGalleryMeta } = await import("./actions");

    await expect(updateGalleryMeta({ status: "idle" }, metaForm())).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ title: "Boda Ana y Beto" });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { updateGalleryMeta } = await import("./actions");

    await expect(updateGalleryMeta({ status: "idle" }, metaForm())).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });
});

describe("updateGalleryMeta validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Criterion: título vacío → error in the dialog, no write. Both the truly
  // empty string and a whitespace-only one, since `.trim()` runs first.
  it.each(["", "   "])(
    "rejects an empty title (%j) with the creation message and writes nothing",
    async (title) => {
      const { updateGalleryMeta } = await import("./actions");

      const result = await updateGalleryMeta({ status: "idle" }, metaForm({ title }));

      expect(result).toEqual({ status: "error", message: "Ingresa un título." });
      const db = await seededDb();
      expect(db.__rows.galleries[0]).toEqual(galleryRow());
    },
  );

  it("rejects a calendar-invalid date with the creation message and writes nothing", async () => {
    const { updateGalleryMeta } = await import("./actions");

    const result = await updateGalleryMeta(
      { status: "idle" },
      metaForm({ sessionDate: "2026-02-30" }),
    );

    expect(result).toEqual({ status: "error", message: "Ingresa una fecha de sesión válida." });
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toEqual(galleryRow());
  });

  it("rejects an empty date with its own message and writes nothing", async () => {
    const { updateGalleryMeta } = await import("./actions");

    const result = await updateGalleryMeta({ status: "idle" }, metaForm({ sessionDate: "" }));

    expect(result).toEqual({ status: "error", message: "Elige la fecha de la sesión." });
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toEqual(galleryRow());
  });

  it("rejects a malformed gallery id before querying, with no write", async () => {
    const { updateGalleryMeta } = await import("./actions");

    const result = await updateGalleryMeta(
      { status: "idle" },
      metaForm({ galleryId: "not-a-uuid" }),
    );

    expect(result.status).toBe("error");
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toEqual(galleryRow());
  });

  it("rejects a gallery id that does not exist, with a readable error and no revalidation", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { updateGalleryMeta } = await import("./actions");

    const result = await updateGalleryMeta({ status: "idle" }, metaForm());

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // The #282 race: the row exists for the pre-read but is gone by the write.
  // Without the `RETURNING` guard the action would report success for a write
  // that hit zero rows — the "update silencioso" this slice forbids.
  it("reports the gallery no longer exists when it vanishes between the read and the write", async () => {
    const db = await seededDb();
    db.__afterSelect(() => {
      db.__rows.galleries.length = 0;
    });
    const { updateGalleryMeta } = await import("./actions");

    const result = await updateGalleryMeta({ status: "idle" }, metaForm());

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("updateGalleryMeta success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Criterion: the title is editable in EVERY status, including the furthest
  // along. No `isPublishable`-style gate here, by the owner's decision.
  it.each(["draft", "proofing", "selected", "delivered"])(
    "saves the new title and date for a gallery in status %s — no state gate",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries[0]!.status = status;
      const { updateGalleryMeta } = await import("./actions");

      const result = await updateGalleryMeta(
        { status: "idle" },
        metaForm({ title: "Boda Ana y Beto — corregida", sessionDate: "2026-12-31" }),
      );

      expect(result).toEqual({ status: "updated" });
      expect(db.__rows.galleries[0]).toMatchObject({
        title: "Boda Ana y Beto — corregida",
        sessionDate: "2026-12-31",
        status,
      });
    },
  );

  // Criterion: the date is stored as the SAME `YYYY-MM-DD` string it arrived
  // as, never passed through `new Date(...)`. In America/Bogota
  // `new Date("2026-01-01")` renders as 2025-12-31, and a `Date` object would
  // also fail the `toBe` string comparison.
  it.each(["2026-01-01", "2024-02-29"])(
    "stores the boundary date %s verbatim as a string",
    async (sessionDate) => {
      const db = await seededDb();
      const { updateGalleryMeta } = await import("./actions");

      const result = await updateGalleryMeta({ status: "idle" }, metaForm({ sessionDate }));

      expect(result).toEqual({ status: "updated" });
      const stored = db.__rows.galleries[0]!.sessionDate;
      expect(stored).toBe(sessionDate);
      expect(typeof stored).toBe("string");
    },
  );

  it("trims whitespace around the title, same as creation", async () => {
    const db = await seededDb();
    const { updateGalleryMeta } = await import("./actions");

    await updateGalleryMeta({ status: "idle" }, metaForm({ title: "  Boda Ana  " }));

    expect(db.__rows.galleries[0]!.title).toBe("Boda Ana");
  });

  // The task's trap: ONLY these two columns. A write that also touched
  // `publicSlug`, a term snapshot or `termsOverridden` would change what a
  // client owes or break a link already in their hands.
  it("writes only title and sessionDate, leaving every other column intact", async () => {
    const db = await seededDb();
    const { updateGalleryMeta } = await import("./actions");

    await updateGalleryMeta(
      { status: "idle" },
      metaForm({ title: "Nuevo título", sessionDate: "2026-05-05" }),
    );

    expect(db.__rows.galleries[0]).toEqual(
      galleryRow({ title: "Nuevo título", sessionDate: "2026-05-05" }),
    );
    expect(Object.keys(db.__lastPatch() ?? {}).sort()).toEqual(["sessionDate", "title"]);
  });

  // The epic's rule: revalidate EVERY surface that reads this data. The public
  // gallery and the client index are the easy ones to forget.
  it("revalidates the detail page, the dashboard list, the public gallery and the client index", async () => {
    const { updateGalleryMeta } = await import("./actions");

    await updateGalleryMeta({ status: "idle" }, metaForm());

    expect(revalidatePathMock).toHaveBeenCalledTimes(4);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries");
  });

  it("never sends any email", async () => {
    const db = await seededDb();
    const { updateGalleryMeta } = await import("./actions");

    const result = await updateGalleryMeta({ status: "idle" }, metaForm());

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({ title: "Boda Ana y Beto — corregida" });
    expect(signInMock).not.toHaveBeenCalled();
  });
});
