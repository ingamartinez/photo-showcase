import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { computeQuota } from "@/lib/quota";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts,
// same stub as every sibling actions.*.test.ts in this directory.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale, same as every sibling suite: `auth()` (via
// requireAdmin()) and `signIn()` (never CALLED by updateGalleryTerms itself —
// task #200's own "no email" decision — but still imported at module scope by
// actions.ts for its sibling actions, so it must resolve here regardless).
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
// leaf-condition parser understanding a plain `eq()` (this action's own
// UPDATE has no `and(...)` CAS guard, unlike the state-transition actions in
// this file — task #200 has no state gate to race against).
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

describe("updateGalleryTerms authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { updateGalleryTerms } = await import("./actions");

    await expect(
      updateGalleryTerms(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ includedPhotosSnapshot: 13 });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { updateGalleryTerms } = await import("./actions");

    await expect(
      updateGalleryTerms(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("updateGalleryTerms validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a malformed gallery id, before ever querying the database", async () => {
    const { updateGalleryTerms } = await import("./actions");

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: "not-a-uuid", includedPhotos: "20", extraPhotoPriceCop: "0" }),
    );

    expect(result.status).toBe("error");
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { updateGalleryTerms } = await import("./actions");

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });

  // Criterion 4, first half: an EMPTY field is REJECTED with a message, never
  // silently coerced to 0 — the exact trap #193 documented for `Number("")`.
  it("rejects an empty included-photos field with a message, and writes nothing", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "", extraPhotoPriceCop: "5000" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/fotos incluidas/i);
    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      termsOverridden: false,
    });
  });

  it("rejects an empty extra-photo-price field with a message, and writes nothing", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/foto extra/i);
    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      termsOverridden: false,
    });
  });

  it("rejects a negative value", async () => {
    const { updateGalleryTerms } = await import("./actions");

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "-1", extraPhotoPriceCop: "0" }),
    );

    expect(result.status).toBe("error");
  });

  it("rejects a non-integer value", async () => {
    const { updateGalleryTerms } = await import("./actions");

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "13.5", extraPhotoPriceCop: "0" }),
    );

    expect(result.status).toBe("error");
  });
});

describe("updateGalleryTerms success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession("photographer@example.com"));
  });

  // Criterion 1.
  it("saves new values for a draft gallery", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 20,
      extraPhotoPriceCopSnapshot: 0,
    });
  });

  // Criterion 2 — the owner's explicit decision this task exists to fix:
  // NO state gate. `delivered` — the furthest-along, most "should this even
  // be allowed" status — must work exactly like `draft`.
  it.each(["draft", "proofing", "selected", "delivered", "archived"])(
    "saves new values for a gallery in status %s — no state gate, by design",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries[0]!.status = status;
      const { updateGalleryTerms } = await import("./actions");

      const result = await updateGalleryTerms(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
      );

      expect(result).toEqual({ status: "updated" });
      expect(db.__rows.galleries[0]).toMatchObject({
        includedPhotosSnapshot: 20,
        extraPhotoPriceCopSnapshot: 0,
        status,
      });
    },
  );

  // Criterion 4, second half: `0` is a LEGITIMATE value in either field
  // (zero included, or free extras) and must be saved as 0, never rejected
  // and never confused with an empty field.
  it("saves 0 in both fields as a legitimate value, not an empty rejection", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "0", extraPhotoPriceCop: "0" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 0,
      extraPhotoPriceCopSnapshot: 0,
    });
  });

  // Criterion 3 — WRITTEN, never derived: even when the admin types back
  // exactly the values the gallery already had (which happen to equal a
  // package's own terms), the flag still flips to true. No comparison
  // against `packages` ever happens in this action at all.
  it("sets termsOverridden = true even when the typed values match the gallery's own current snapshot", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.termsOverridden = false;
    const { updateGalleryTerms } = await import("./actions");

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "13", extraPhotoPriceCop: "5000" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      termsOverridden: true,
    });
  });

  // Criterion 6.
  it("records who edited the terms and when", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();
    const before = Date.now();

    await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
    );

    const row = db.__rows.galleries[0]!;
    expect(row.termsUpdatedByEmail).toBe("photographer@example.com");
    expect(row.termsUpdatedAt).toBeInstanceOf(Date);
    expect((row.termsUpdatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  // THE MOST INVISIBLE FAILURE MODE — revalidating only the dashboard would
  // leave the admin looking at correct numbers while the client's own gallery
  // page kept serving stale ones. Both surfaces, asserted by exact path.
  it("revalidates BOTH the dashboard detail page and the client's own gallery page", async () => {
    const { updateGalleryTerms } = await import("./actions");

    await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
  });

  // Criterion 5 — the client's own gallery page reads these exact two
  // columns and hands them to `computeQuota()` (src/lib/quota.ts) with no
  // extra propagation step in between: `/galleries/[publicSlug]` (page.tsx)
  // passes `gallery.includedPhotosSnapshot`/`extraPhotoPriceCopSnapshot`
  // straight through, unmodified. Proven here THROUGH `computeQuota`, not by
  // re-asserting the raw column values a second time (that would just repeat
  // the "saves new values" test above under a different name) — this is
  // what a client actually sees once the row this action wrote is read back.
  it("changes what the client would see, verified through computeQuota on the written row", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();
    // 22 selected against the gallery's own starting terms (13 included,
    // $5.000/extra) leaves BOTH extras and surchargeCop strictly positive
    // before AND after the edit below — chosen deliberately so a bug that
    // wrote only ONE of the two snapshot columns (e.g. dropping
    // `extraPhotoPriceCopSnapshot` from the UPDATE, leaving the OLD $5.000
    // in place) still changes the `after` numbers relative to `before`, and
    // is caught here. A pair of before/after values that both land on 0
    // (extras clamped by `Math.max(0, …)`, as an all-or-nothing swing to 20
    // included would) can hide exactly that bug — see this task's own report
    // for the mutation this test was built to fail on.
    const selectedCount = 22;

    const before = computeQuota(selectedCount, {
      includedPhotosSnapshot: db.__rows.galleries[0]!.includedPhotosSnapshot as number,
      extraPhotoPriceCopSnapshot: db.__rows.galleries[0]!.extraPhotoPriceCopSnapshot as number,
    });
    expect(before).toMatchObject({ extras: 9, surchargeCop: 45_000 });

    await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "2000" }),
    );

    const after = computeQuota(selectedCount, {
      includedPhotosSnapshot: db.__rows.galleries[0]!.includedPhotosSnapshot as number,
      extraPhotoPriceCopSnapshot: db.__rows.galleries[0]!.extraPhotoPriceCopSnapshot as number,
    });
    expect(after).toMatchObject({ extras: 2, surchargeCop: 4_000 });
  });

  // Criterion 7 — the trap this repo already knows how to get wrong: assert
  // the action did its real work FIRST (the snapshot values actually
  // changed), and only THEN assert nothing was mailed. A `not
  // .toHaveBeenCalled()` alone would pass identically if the action had
  // silently no-opped.
  it("never sends any email", async () => {
    const { updateGalleryTerms } = await import("./actions");
    const db = await seededDb();

    const result = await updateGalleryTerms(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, includedPhotos: "20", extraPhotoPriceCop: "0" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(db.__rows.galleries[0]).toMatchObject({
      includedPhotosSnapshot: 20,
      extraPhotoPriceCopSnapshot: 0,
    });
    expect(signInMock).not.toHaveBeenCalled();
  });
});
