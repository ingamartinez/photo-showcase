import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { eqColumnAndValue } from "@/lib/test/eq-column-and-value";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/clients/actions.test.ts: mock only
// `@/auth`'s `auth()`, leave `requireAdmin()`'s own redirect()/forbidden()
// logic real, so a test only passes if this action actually calls
// requireAdmin(). `signIn` is exported too (task #21's publishGallery now
// imports it from this same module) — unused by createGallery itself, but
// listed explicitly rather than left to resolve to `undefined`, same stance
// as src/app/dashboard/layout.test.ts's own `@/auth` mock.
const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: vi.fn(),
}));

// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) and `./lib/actions.js` at module scope —
// there is no way to pull just `AuthError` off it without loading that
// whole chain, which fails to resolve under Vitest. Mocked wholesale here
// (task #21's actions.ts now imports `AuthError` from "next-auth" too, for
// publishGallery's error handling) — same fix as
// src/app/(marketing)/login/actions.test.ts already applies for the same
// reason; see that file's comment on why `instanceof AuthError` still holds
// against a mocked class.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// `revalidatePath` throws outside a real Next.js request — stub it so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// Forcing `generateGallerySlug()` to a fixed value is the only way to make a
// slug COLLISION happen on demand in a test — real entropy (128 bits) makes
// one practically unreachable otherwise. Left un-mocked (real randomness) for
// every test except the one that specifically needs a forced collision.
const generateGallerySlugMock = vi.fn();
vi.mock("@/lib/slug", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slug")>("@/lib/slug");
  return {
    ...actual,
    generateGallerySlug: () => generateGallerySlugMock(),
  };
});

// A minimal, genuinely-behaving double for `@/lib/db` — not a mock that
// returns a fixed response regardless of input. `insert(galleries).values()`
// really enforces the same constraints Postgres does (a FK to a client that
// doesn't exist, a duplicate public_slug) by throwing the SAME shape
// drizzle-orm 0.45 actually delivers in production: a `DrizzleQueryError`
// whose `.cause` is the real `postgres.PostgresError` (both imported for
// real, not faked) with the real SQLSTATE — same pattern as
// src/app/dashboard/clients/actions.test.ts. `select().from(packages)
// .where().limit()` really filters by the column/value encoded in the
// `eq()` condition it's given (duck-typed off drizzle's SQL chunks, verified
// against the real shape before writing this).
//
// Task #53: `eqColumnAndValue` itself used to live here as a local copy that
// read the DB column name straight off the condition and indexed fixture
// rows with it directly — silently wrong for any column whose JS key and DB
// name differ (it only worked here by accident, because every `eq()` below
// happens to compare a column named "id"). Now shared with
// src/app/api/galleries/[galleryId]/proofs/route.test.ts (the file that
// already had the corrected version) via src/lib/test/eq-column-and-value.ts
// — see that module's own header comment for the full story.
type Row = Record<string, unknown>;

vi.mock("@/lib/db", async () => {
  const { PostgresError } = await import("postgres");
  const { DrizzleQueryError } = await import("drizzle-orm");
  const { packages, galleries, galleryClients } = await import("@/lib/db/schema");

  const packageRows: Row[] = [];
  const userRows: Row[] = [];
  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  function throwWrapped(message: string, code: string): never {
    const pgError = Object.assign(new PostgresError(message), { code });
    throw new DrizzleQueryError("insert into galleries ...", [], pgError);
  }

  // Factory rather than a single fixed function, so `db.transaction` below
  // can hand its callback a version that writes into PENDING arrays instead
  // of the committed ones directly — the only way to make a mid-transaction
  // failure's rollback actually observable (review finding: this fake used
  // to write straight into the shared committed arrays, so "never a gallery
  // with zero clients" was documented but unproven — a gallery row would
  // have stuck around even after the `gallery_clients` insert failed).
  // Uniqueness/FK checks still read the COMMITTED arrays (`galleryRows`/
  // `userRows`), matching Postgres: a slug collision or a bad client id is
  // checked against what's actually durable, not against another
  // in-progress transaction's own uncommitted rows.
  function makeInsertInto(targetGalleryRows: Row[], targetGalleryClientRows: Row[]) {
    return function insertInto(table: unknown) {
      return {
        values: (rowOrRows: Row | Row[]) => {
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];

          if (table === galleries) {
            const row = rows[0]!;
            if (galleryRows.some((g) => g.publicSlug === row.publicSlug)) {
              throwWrapped(
                'duplicate key value violates unique constraint "galleries_public_slug_idx"',
                "23505",
              );
            }
            const stored: Row = { id: crypto.randomUUID(), createdAt: new Date(), ...row };
            targetGalleryRows.push(stored);
            const resultPromise = Promise.resolve([stored]);
            return Object.assign(resultPromise, {
              returning: async () => [stored],
            });
          }

          if (table === galleryClients) {
            for (const row of rows) {
              if (!userRows.some((u) => u.id === row.userId)) {
                throwWrapped(
                  'insert or update on table "gallery_clients" violates foreign key constraint "gallery_clients_user_id_users_id_fk"',
                  "23503",
                );
              }
            }
            const stored = rows.map((row) => ({ createdAt: new Date(), ...row }));
            targetGalleryClientRows.push(...stored);
            const resultPromise = Promise.resolve(stored);
            return Object.assign(resultPromise, {
              returning: async () => stored,
            });
          }

          throw new Error("this fake only supports inserting galleries/galleryClients");
        },
      };
    };
  }
  const insertInto = makeInsertInto(galleryRows, galleryClientRows);

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => ({
            limit: async (n: number) => {
              const rows = table === packages ? packageRows : [];
              // `eqColumnAndValue` itself throws (rather than returning an
              // unresolved column) when `condition` isn't a genuine `eq()`
              // or its column can't be mapped back to a JS key — no local
              // guard needed here.
              const { column, value } = eqColumnAndValue(condition);
              return rows.filter((r) => r[column] === value).slice(0, n);
            },
          }),
        }),
      }),
      insert: (table: unknown) => insertInto(table),
      // Buffers every write the callback makes into PENDING arrays, and only
      // merges them into the committed `galleryRows`/`galleryClientRows`
      // AFTER `fn` resolves without throwing — a throw propagates straight
      // out of this `async` function instead, and the pending arrays are
      // simply discarded, exactly mirroring a real Postgres ROLLBACK. See
      // this file's own comment on `makeInsertInto` above for why the
      // uniqueness/FK checks still read the committed arrays regardless.
      transaction: async (
        fn: (tx: { insert: ReturnType<typeof makeInsertInto> }) => Promise<unknown>,
      ) => {
        const pendingGalleryRows: Row[] = [];
        const pendingGalleryClientRows: Row[] = [];
        const result = await fn({
          insert: makeInsertInto(pendingGalleryRows, pendingGalleryClientRows),
        });
        galleryRows.push(...pendingGalleryRows);
        galleryClientRows.push(...pendingGalleryClientRows);
        return result;
      },
      // Only what src/lib/galleries.ts's getGalleriesWithDetails() needs:
      // real joins against the SAME userRows/packageRows arrays `insert`
      // above reads/mutates, so a test that mutates a package row after
      // creating a gallery is read back through a genuinely live join, not a
      // second, disconnected fixture. `galleryClients` here mirrors the
      // REAL relational query's shape (task #94) — one row per membership,
      // each carrying its joined `user`.
      query: {
        galleries: {
          findMany: async () =>
            [...galleryRows]
              .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
              .map((g) => ({
                ...g,
                galleryClients: galleryClientRows
                  .filter((gc) => gc.galleryId === g.id)
                  .map((gc) => ({ user: userRows.find((u) => u.id === gc.userId) })),
                package: packageRows.find((p) => p.id === g.packageId),
                assets: [],
              })),
        },
      },
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: {
        packages: packageRows,
        users: userRows,
        galleries: galleryRows,
        galleryClients: galleryClientRows,
      },
    },
  };
});

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientSession(): Session {
  return {
    user: { id: "client-1", role: "client", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function formDataWith(fields: Record<string, string | string[] | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // Task #94: `clientIds` is an array — `<select multiple>` posts one
    // FormData entry per selected option under the SAME name, so this
    // `.append`s each one instead of `.set`ting a single value, matching
    // what `formData.getAll("clientIds")` (createGallery's own read) expects.
    if (Array.isArray(value)) {
      for (const v of value) data.append(key, v);
    } else {
      data.set(key, value);
    }
  }
  return data;
}

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { packages: Row[]; users: Row[]; galleries: Row[]; galleryClients: Row[] } };
  };
  return db;
}

const ESTANDAR_PACKAGE: Row = {
  id: 1,
  name: "Estándar",
  priceCop: 100_000,
  includedPhotos: 13,
  extraPhotoPriceCop: 5_000,
  originalPhotoPriceCop: 2_000,
  durationLabel: "1.5–2 h",
  active: true,
  sortOrder: 1,
};

const RETIRED_PACKAGE: Row = {
  id: 2,
  name: "Básico (viejo)",
  priceCop: 50_000,
  includedPhotos: 5,
  extraPhotoPriceCop: 4_000,
  originalPhotoPriceCop: 1_000,
  durationLabel: "1 h",
  active: false,
  sortOrder: 2,
};

const CLIENT_ROW: Row = { id: "client-1", name: "Ana Pérez", email: "ana@example.com" };

let slugCounter = 0;

beforeEach(async () => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  generateGallerySlugMock.mockReset();
  slugCounter = 0;
  generateGallerySlugMock.mockImplementation(() => `slug-${++slugCounter}`);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.packages.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleries.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.packages.push({ ...ESTANDAR_PACKAGE }, { ...RETIRED_PACKAGE });
  db.__rows.users.push({ ...CLIENT_ROW });
});

// MUTATION-PROVEN (re-run for task #100, which relaxed this action's input
// validation and so had to re-establish that the guard, not the schema, is
// what stops a non-admin). Deleting `await requireAdmin()` from
// `createGallery` made both tests in this block fail with
// `promise resolved "{ status: 'created' }" instead of rejecting`: a signed-in
// CLIENT successfully created a gallery, and so did a request with no session
// at all. `15 passed | 2 failed`. Restoring it made all 17 pass.
describe("createGallery authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without inserting anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { createGallery } = await import("./actions");

    await expect(
      createGallery(
        { status: "idle" },
        formDataWith({
          clientIds: ["client-1"],
          packageId: "1",
          title: "Boda",
          sessionDate: "2026-08-01",
        }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const db = await seededDb();
    expect(db.__rows.galleries).toHaveLength(0);
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { createGallery } = await import("./actions");

    await expect(
      createGallery(
        { status: "idle" },
        formDataWith({
          clientIds: ["client-1"],
          packageId: "1",
          title: "Boda",
          sessionDate: "2026-08-01",
        }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("createGallery validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Task #100 REVERSED this. Until #100 the schema carried
  // `.min(1, "Elegí al menos un cliente.")` and this same test asserted the
  // refusal; the owner asked for the opposite workflow — the shoot happens,
  // the files come off the card, and the client record may not exist yet.
  // Posting no `clientIds` at all is now a valid create.
  it("ACCEPTS a create with no client at all, and writes zero memberships", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    const result = await createGallery(
      { status: "idle" },
      formDataWith({ packageId: "1", title: "Sesión sin cliente", sessionDate: "2026-08-01" }),
    );

    expect(result).toEqual({ status: "created" });
    const stored = db.__rows.galleries.find((g) => g.title === "Sesión sin cliente");
    expect(stored).toBeDefined();
    expect(db.__rows.galleryClients.filter((gc) => gc.galleryId === stored!.id)).toHaveLength(0);
    // No `status` written by the action — the column default puts it in
    // `draft` (schema.ts), the one status where zero clients is legitimate.
    expect(stored).not.toHaveProperty("status");
  });

  // An explicitly EMPTY `<select multiple>` posts no entries at all, which is
  // indistinguishable from the case above; a crafted request could still post
  // an empty-string id, and that must NOT become a membership row pointing at
  // nothing. `.min(1)` on each ELEMENT survived #100's removal of `.min(1)`
  // on the array.
  it("still rejects a blank client id posted as an element", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["  "],
        packageId: "1",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects a non-numeric package id", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "not-a-number",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects an empty title", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "  ",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects a malformed session date", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda",
        sessionDate: "08/01/2026",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  // Task #193 — the two override fields are validated the SAME way, each
  // independently: a non-integer or negative value is refused with a
  // friendly message, without ever reaching the package lookup or the
  // insert.
  it("rejects a non-integer override for included photos", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda",
        sessionDate: "2026-08-01",
        includedPhotos: "trece",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
    expect(db.__rows.galleries).toHaveLength(0);
  });

  it("rejects a negative override for the extra-photo price", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda",
        sessionDate: "2026-08-01",
        extraPhotoPriceCop: "-1",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
    expect(db.__rows.galleries).toHaveLength(0);
  });

  // Task #205 — the third override field, validated the SAME independent way
  // as the two above.
  it("rejects a negative override for the original-photo price", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda",
        sessionDate: "2026-08-01",
        originalPhotoPriceCop: "-1",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
    expect(db.__rows.galleries).toHaveLength(0);
  });
});

describe("createGallery package resolution", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a package id that does not exist", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "999",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Elegí un paquete válido.");
  });

  // Acceptance criterion: only active packages appear in the picker — and a
  // crafted request posting a retired package's id directly must ALSO be
  // refused, not just filtered out of the <select> client-side.
  it("rejects a retired (inactive) package even when its id is posted directly", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "2",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ese paquete ya no está disponible.");
    const db = await seededDb();
    expect(db.__rows.galleries).toHaveLength(0);
  });
});

describe("createGallery success + frozen terms", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("creates a gallery, revalidates the list, and returns created", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result).toEqual({ status: "created" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });

  it("writes snapshot columns that exactly match the chosen package at creation time", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda Ana y Beto");
    expect(stored).toMatchObject({
      packageId: 1,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
    });
    // `status` isn't written by this action at all — the DB column default
    // ("draft", schema.ts) is what puts a new gallery there, not this insert.
    expect(stored).not.toHaveProperty("status");
    // Task #94: the gallery row itself carries NO client reference at all
    // anymore (schema.ts) — membership lives entirely in the separate
    // `gallery_clients` join table, written in the SAME transaction.
    expect(stored).not.toHaveProperty("clientId");
    expect(stored).not.toHaveProperty("clientIds");
    expect(db.__rows.galleryClients).toEqual([
      expect.objectContaining({ galleryId: stored!.id, userId: "client-1" }),
    ]);
    // No override was typed — `termsOverridden` must stay `false`, the
    // column default (schema.ts), and NOT be derived by comparing these
    // snapshots against the live package row (this task's own documented
    // trap: that comparison rots the moment the package is edited).
    expect(stored).toMatchObject({ termsOverridden: false });
  });

  // Task #193 — REVIEW FINDING: the test above never actually posts the two
  // override fields at all (`formDataWith` skips `undefined` entries
  // entirely), so it only ever exercised `null || undefined`, which behaves
  // identically under `??`. It could not have caught the bug this test
  // exists for. THIS test posts an EXPLICIT `""` for both fields — what a
  // real, untouched `<input type="number">` actually posts — and pins the
  // exact spot where blank-vs-typed is decided.
  //
  // MUTATION-PROVEN, TWO WAYS:
  //
  // 1. `optionalNonNegativeInt`'s own trim-and-collapse `.transform` is now
  //    what decides "empty" — moved there FROM the call site's
  //    `formData.get(...) || undefined`, which used to be the only place
  //    deciding it (see that function's own header comment). Removing that
  //    transform's `|| trimmed === ""` clause AND flipping the call site's
  //    `||` to `??` at the same time (reproducing the exact pre-fix shape:
  //    correctness resting on that one operator, with the schema doing
  //    nothing to catch it) turns this test red with
  //    `includedPhotosSnapshot: 0`, `extraPhotoPriceCopSnapshot: 0`,
  //    `termsOverridden: true` — `"" ?? undefined` stays `""`, `Number("")`
  //    is `0`, and a `0` survives `??` against the package's own value like
  //    any other override would.
  //
  // 2. Flipping ONLY the call site's `||` to `??`, with the schema's own fix
  //    left intact, stays GREEN — verified directly, not assumed. That is
  //    the fix working as intended, not a gap: correctness no longer rests
  //    on that operator at all, so mutating it alone is now a no-op. The
  //    schema's own trim-and-collapse is what has to be removed (as in
  //    #1 above) to reach red again.
  it("treats an explicitly blank override field the same as an untouched one — inherits the package, never overridden", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con campos en blanco",
        sessionDate: "2026-08-01",
        includedPhotos: "",
        extraPhotoPriceCop: "",
        // Task #205 — the third field, same blank-vs-typed decision.
        originalPhotoPriceCop: "",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda con campos en blanco");
    expect(stored).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      termsOverridden: false,
    });
  });

  // Task #193 — REVIEW FINDING: the blank-field test right above only pins
  // `""` — the empty-string half of `optionalNonNegativeInt`'s own
  // `trimmed === undefined || trimmed === ""` check (that function's header
  // comment). Nothing pinned the OTHER half, `.trim()` itself: a
  // whitespace-only field (a stray space from a fumbled tap, or a browser
  // extension that pads inputs) is a genuinely empty field in every way that
  // matters here, and has to inherit the package exactly like `""` does —
  // not become a `0` override because it happens to be non-empty BEFORE
  // trimming.
  //
  // MUTATION-PROVEN: removing `.trim()` alone (keeping the `|| trimmed ===
  // ""` clause intact) turns this red — `" ".trim()` never runs, so `value`
  // stays `" "`, which is neither `undefined` nor `""` and sails through as
  // a "typed" value. `Number(" ")` is `0` (JS's `Number()` strips
  // whitespace, unlike the `Number.isInteger`/`>= 0` refine that runs on the
  // STRING first), so this reached exactly the same corruption as the
  // untrimmed `""` case did before the fix: `includedPhotosSnapshot: 0`,
  // `extraPhotoPriceCopSnapshot: 0`, `termsOverridden: true`, despite the
  // admin never typing a digit.
  it("treats a whitespace-only override field the same as an untouched one — inherits the package, never overridden", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con campos de espacios",
        sessionDate: "2026-08-01",
        includedPhotos: " ",
        extraPhotoPriceCop: "  ",
        // Task #205 — the third field, same whitespace-only decision.
        originalPhotoPriceCop: "   ",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda con campos de espacios");
    expect(stored).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      termsOverridden: false,
    });
  });

  // Task #193 (widened by #205) — all three override fields typed together
  // replace all three snapshots, and the gallery is flagged as overridden.
  it("writes the manually typed override values instead of the package's own terms, and flags the gallery as overridden", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con override completo",
        sessionDate: "2026-08-01",
        includedPhotos: "20",
        extraPhotoPriceCop: "9000",
        originalPhotoPriceCop: "7000",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda con override completo");
    expect(stored).toMatchObject({
      packageId: 1,
      includedPhotosSnapshot: 20,
      extraPhotoPriceCopSnapshot: 9_000,
      originalPhotoPriceCopSnapshot: 7_000,
      termsOverridden: true,
    });
  });

  // Each field overrides INDEPENDENTLY — overriding one must not force the
  // others away from the package's own value.
  it("overrides only the included-photos quota, inheriting the package's own extra-photo and original-photo prices", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con tope overrideado",
        sessionDate: "2026-08-01",
        includedPhotos: "7",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda con tope overrideado");
    expect(stored).toMatchObject({
      includedPhotosSnapshot: 7,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      termsOverridden: true,
    });
  });

  it("overrides only the extra-photo price, inheriting the package's own included-photos quota and original-photo price", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con precio extra overrideado",
        sessionDate: "2026-08-01",
        extraPhotoPriceCop: "12000",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda con precio extra overrideado");
    expect(stored).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 12_000,
      originalPhotoPriceCopSnapshot: 2_000,
      termsOverridden: true,
    });
  });

  // Task #205 — the third field's own independence: overriding ONLY the
  // original-photo price must not disturb the other two, and must still flip
  // `termsOverridden` (the widened disjunction at actions.ts's own
  // `termsOverridden = includedPhotosOverride !== undefined ||
  // extraPhotoPriceCopOverride !== undefined ||
  // originalPhotoPriceCopOverride !== undefined`).
  it("overrides only the original-photo price, inheriting the package's own included-photos quota and extra-photo price", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con precio original overrideado",
        sessionDate: "2026-08-01",
        originalPhotoPriceCop: "6000",
      }),
    );

    const stored = db.__rows.galleries.find(
      (g) => g.title === "Boda con precio original overrideado",
    );
    expect(stored).toMatchObject({
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 6_000,
      termsOverridden: true,
    });
  });

  // MUTATION-PROVING TEST for this slice's own named trap: `Number("")` is
  // `0`, and `override || pkg.includedPhotos` would treat a typed `0` as
  // falsy and silently fall back to the package's value instead. A literal
  // `0` has to survive as a REAL override, distinct from an untouched field.
  it("treats a typed 0 as a real override, not as an untouched field falling back to the package", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda con cero incluidas",
        sessionDate: "2026-08-01",
        includedPhotos: "0",
        extraPhotoPriceCop: "0",
        // Task #205 — a free original is a legitimate promotion (task body's
        // own example), so `0` here must survive as a real override too.
        originalPhotoPriceCop: "0",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda con cero incluidas");
    expect(stored).toMatchObject({
      includedPhotosSnapshot: 0,
      extraPhotoPriceCopSnapshot: 0,
      originalPhotoPriceCopSnapshot: 0,
      termsOverridden: true,
    });
  });

  // THE highest-value test in this slice (per the task): prove the snapshot
  // is frozen, not derived live. This actually MUTATES the live package row
  // after the gallery is created and re-reads the gallery through the real
  // read-side query (getGalleriesWithDetails) — not a stub of either side.
  //
  // Task #193 extended this in place (rather than adding a sibling test)
  // with a SECOND, overridden gallery bound to the same package: the frozen-
  // terms guarantee has to hold for an overridden gallery exactly as it
  // already held for a normal one.
  //
  // REVIEW FINDING, FIXED: this comment used to also claim a
  // derived-from-comparison `termsOverridden` (the trap this task's own
  // ticket names) "would be exposed by the SAME live-package mutation this
  // test already performs" — false. `getGalleriesWithDetails` returns
  // `GalleryWithDetails` (src/lib/galleries.ts), which has no
  // `termsOverridden` field at all; the assertions below it only ever
  // checked the four snapshot numbers, never that flag, so a comparison-
  // based derivation could ship right through this test undetected. Fixed
  // by reading BOTH galleries a second time through `getGalleryDetailsByIds`
  // instead — it shares the identical `toGalleryDetail` mapper `getGalleryDetail`
  // (the admin page's own read) uses, and its `GalleryDetail` type DOES carry
  // `termsOverridden` — and asserting the flag directly, AFTER the same
  // live-package mutation, so a comparison-based derivation would now
  // actually flip these assertions the way the comment always claimed.
  //
  // TASK #205 REVIEW FINDING, FIXED: this test never posted or asserted
  // `originalPhotoPriceCop`/`originalPhotoPriceCopSnapshot` at all — the
  // reviewer proved that by deleting `originalPhotoPriceCopSnapshot,` from
  // `createGallery`'s own `.values({...})` (actions.ts) and getting
  // `127 files / 1654 tests passed`, `tsc --noEmit` exit 0. Extended below,
  // IN PLACE (not beside), with a third live-package mutation and a third
  // snapshot assertion on each gallery, read through `getGalleryDetailsByIds`
  // (the one projection both `GalleryDetail` fields — `termsOverridden` and
  // `originalPhotoPriceCopSnapshot` — already carry; `GalleryWithDetails`
  // still doesn't expose the third snapshot, so that one is asserted only
  // through `details`, not through `galleriesList`).
  it("keeps a gallery's displayed terms unmoved after the bound package's price/quota are edited afterward — normal and overridden alike", async () => {
    const { createGallery } = await import("./actions");
    const { getGalleriesWithDetails, getGalleryDetailsByIds } = await import("@/lib/galleries");
    const db = await seededDb();

    const created = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );
    expect(created.status).toBe("created");

    const createdOverride = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Boda Overrideada",
        sessionDate: "2026-08-01",
        includedPhotos: "20",
        extraPhotoPriceCop: "9000",
        originalPhotoPriceCop: "6000",
      }),
    );
    expect(createdOverride.status).toBe("created");

    // A real price/quota increase to the seeded offer, made to the SAME row
    // object the fake db's `select` reads from — genuinely mutated, not a
    // second, disconnected fixture.
    const livePackage = db.__rows.packages.find((p) => p.id === 1)!;
    livePackage.priceCop = 500_000;
    livePackage.includedPhotos = 1;
    livePackage.extraPhotoPriceCop = 999_999;
    livePackage.originalPhotoPriceCop = 777_777;

    // Negative control: prove the mutation actually took effect on the live
    // row, so this test would fail for the right reason if the read-side
    // were (bug) reading the live package instead of the snapshot.
    expect(livePackage.includedPhotos).toBe(1);

    const galleriesList = await getGalleriesWithDetails();
    const gallery = galleriesList.find((g) => g.title === "Boda Ana y Beto");
    const overriddenGallery = galleriesList.find((g) => g.title === "Boda Overrideada");

    expect(gallery).toBeDefined();
    expect(gallery?.includedPhotosSnapshot).toBe(13);
    expect(gallery?.extraPhotoPriceCopSnapshot).toBe(5_000);

    // The overridden gallery's snapshots are what the admin TYPED at
    // creation, and stay exactly that regardless of what happens to the live
    // package afterward — same guarantee, same live mutation, second
    // gallery.
    expect(overriddenGallery).toBeDefined();
    expect(overriddenGallery?.includedPhotosSnapshot).toBe(20);
    expect(overriddenGallery?.extraPhotoPriceCopSnapshot).toBe(9_000);

    // `termsOverridden` AND the third snapshot, read through
    // `getGalleryDetailsByIds` (the one projection that carries both) — the
    // actual fix for this comment's own review findings above. A derivation
    // that compared these frozen snapshots against the package's CURRENT row
    // (still sitting at `includedPhotos: 1` / `extraPhotoPriceCop: 999_999` /
    // `originalPhotoPriceCop: 777_777` from the mutation above) would call
    // the FIRST gallery overridden (13 ≠ 1) — that mismatches the `false`
    // this asserts for it, and is what actually flips this test red under
    // that derivation. A `createGallery` that dropped
    // `originalPhotoPriceCopSnapshot` from its insert (falling back to the
    // column's own `default(2_000)`) would report `2_000` for the OVERRIDDEN
    // gallery below instead of the typed `6_000` — that is what
    // `originalPhotoPriceCopSnapshot` on the second assertion actually
    // catches.
    const galleryId = db.__rows.galleries.find((g) => g.title === "Boda Ana y Beto")!.id as string;
    const overriddenGalleryId = db.__rows.galleries.find((g) => g.title === "Boda Overrideada")!
      .id as string;
    const details = await getGalleryDetailsByIds([galleryId, overriddenGalleryId]);

    const detail = details.find((d) => d.id === galleryId);
    const overriddenDetail = details.find((d) => d.id === overriddenGalleryId);

    expect(detail?.termsOverridden).toBe(false);
    expect(detail?.originalPhotoPriceCopSnapshot).toBe(2_000);

    expect(overriddenDetail?.termsOverridden).toBe(true);
    expect(overriddenDetail?.originalPhotoPriceCopSnapshot).toBe(6_000);
  });

  it("rejects a client id that does not exist (foreign key violation), with a friendly message", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["does-not-exist"],
        packageId: "1",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Elegí clientes válidos.");
  });

  // Review finding on task #94: this suite's own comment used to claim
  // "never a gallery with zero clients" (the reason `createGallery` wraps
  // both inserts in ONE transaction, actions.ts's own header comment) was
  // "documented but unproven" — the fake `db.transaction` wrote straight
  // into the committed row arrays, so a gallery row would have stuck around
  // even after the SAME failure the test above already exercises. Proven
  // here directly: the gallery insert that ran first inside the SAME failed
  // transaction as the test above must never be visible afterward either.
  it("never leaves the gallery row behind when the gallery_clients insert fails inside the same transaction", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["does-not-exist"],
        packageId: "1",
        title: "Boda Rechazada",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(db.__rows.galleries.find((g) => g.title === "Boda Rechazada")).toBeUndefined();
  });

  // Task #94's own acceptance criterion: several real clients, one gallery,
  // all written together in the same transaction.
  it("attaches SEVERAL clients to the same gallery when more than one is selected", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();
    db.__rows.users.push({ id: "client-2", name: "Beto Ruiz", email: "beto@example.com" });

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1", "client-2"],
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result).toEqual({ status: "created" });
    const stored = db.__rows.galleries.find((g) => g.title === "Boda Ana y Beto")!;
    const memberships = db.__rows.galleryClients.filter((gc) => gc.galleryId === stored.id);
    expect(memberships.map((gc) => gc.userId).sort()).toEqual(["client-1", "client-2"]);
  });

  // Review finding on task #94: the defensive dedupe (actions.ts's own
  // comment right above `const clientIds = [...new Set(...)]`) had no test
  // posting the same client id twice — a native `<select multiple>` can
  // never do this, but a crafted request could, and without the dedupe this
  // would hit `gallery_clients`'s composite primary key (schema.ts) as a
  // 23505 this function has no catch for.
  it("dedupes a client id posted twice, writing only ONE membership row", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1", "client-1"],
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result).toEqual({ status: "created" });
    const stored = db.__rows.galleries.find((g) => g.title === "Boda Ana y Beto")!;
    const memberships = db.__rows.galleryClients.filter((gc) => gc.galleryId === stored.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.userId).toBe("client-1");
  });

  // Acceptance criterion: two galleries never share a slug. Forces a
  // collision (real entropy makes this practically unreachable otherwise)
  // and proves the DB-level unique constraint actually stops the second
  // insert — the action does not swallow or silently retry past it.
  it("does not let two galleries share a public_slug", async () => {
    generateGallerySlugMock.mockReturnValue("forced-collision");
    const { createGallery } = await import("./actions");
    const db = await seededDb();
    db.__rows.users.push({ id: "client-2", name: "Beto Ruiz", email: "beto@example.com" });

    const first = await createGallery(
      { status: "idle" },
      formDataWith({
        clientIds: ["client-1"],
        packageId: "1",
        title: "Primera",
        sessionDate: "2026-08-01",
      }),
    );
    expect(first.status).toBe("created");

    await expect(
      createGallery(
        { status: "idle" },
        formDataWith({
          clientIds: ["client-2"],
          packageId: "1",
          title: "Segunda",
          sessionDate: "2026-08-02",
        }),
      ),
    ).rejects.toThrow();

    expect(db.__rows.galleries.filter((g) => g.publicSlug === "forced-collision")).toHaveLength(1);
  });
});
