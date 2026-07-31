import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale here — BOTH exports this file's transitive
// imports actually need: `auth()` (via requireAdmin()) and `signIn()`
// (called directly by publishGallery). Naming every export a mock provides
// explicitly, rather than relying on an unnamed one silently resolving to
// `undefined`, matches src/app/dashboard/layout.test.ts's own `@/auth` mock.
const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) and `./lib/actions.js` at module scope —
// pulling just `AuthError` off it fails to resolve under Vitest. Mocked
// wholesale, same fix (and same reasoning for why `instanceof AuthError`
// still holds against a mocked class shared by both this file and
// actions.ts under test) as src/app/(marketing)/login/actions.test.ts.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// `revalidatePath` throws outside a real Next.js request — stub it so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering by
// the column/value encoded in `eq()`, same duck-typing approach (and the
// SAME corrected helper — table's own entries resolve the db column name
// back to the JS property key, not a hardcoded snake_case<->camelCase
// transform) as
// src/app/api/galleries/[galleryId]/proofs/route.test.ts's eqColumnAndValue.
// The OLDER copy in this directory's own actions.test.ts does not do that
// resolution and would silently mis-filter `assets.galleryId` (db column
// `gallery_id`) here.
type Row = Record<string, unknown>;

function eqColumnAndValue(condition: unknown): { column?: string; value?: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  let dbColumnName: string | undefined;
  let table: unknown;
  let value: unknown;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnName = (chunk as { name: string }).name;
        table = (chunk as { table: unknown }).table;
      }
      if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
    }
  }
  if (!dbColumnName || !table) return { column: undefined, value };
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  return { column: jsKey, value };
}

// Task #97: `getGalleryClients` now filters `removedAt IS NULL` alongside
// `galleryId` — a leaf-condition parser (same shape as
// src/lib/gallery-access.test.ts's own) that reads each SQL node's chunks
// LOCALLY, rather than flattening the whole tree, so an `eq()`'s value chunk
// is never confused with a sibling `isNull()`'s absence of one.
type LeafCondition =
  { dbColumnName: string; op: "eq"; value: unknown } | { dbColumnName: string; op: "isNull" };

function parseLeaf(node: unknown): LeafCondition | undefined {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return undefined;
  let dbColumnName: string | undefined;
  let value: unknown;
  let hasValue = false;
  let isNullText = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) dbColumnName = (chunk as { name: string }).name;
      if ("value" in chunk && "encoder" in chunk) {
        value = (chunk as { value: unknown }).value;
        hasValue = true;
      }
      if ("value" in chunk && Array.isArray((chunk as { value: unknown }).value)) {
        if ((chunk as { value: string[] }).value.join("").includes("is null")) isNullText = true;
      }
    }
  }
  if (!dbColumnName) return undefined;
  if (isNullText) return { dbColumnName, op: "isNull" };
  if (hasValue) return { dbColumnName, op: "eq", value };
  return undefined;
}

function parseConditions(node: unknown): LeafCondition[] {
  const leaf = parseLeaf(node);
  if (leaf) return [leaf];
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const results: LeafCondition[] = [];
  for (const chunk of chunks) results.push(...parseConditions(chunk));
  return results;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries, users } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const assetRows: Row[] = [];
  const userRows: Row[] = [];
  const galleryClientRows: Row[] = [];
  let failNextUpdate = false;
  // Task #61 — one entry pushed per UPDATE attempt against `galleries`,
  // recording how many rows THAT attempt matched (0 or 1). This is how the
  // race test below observes the guard actually doing its job at the write
  // itself, independent of `publishGallery`'s return value (which is the
  // SAME `{ status: "published" }` for the winner and the loser, on
  // purpose — see actions.ts's own comment on that branch).
  const updateOutcomes: number[] = [];

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const { column, value } = eqColumnAndValue(condition);
            if (!column) throw new Error("eqColumnAndValue: not an eq() condition");

            if (table === galleries) {
              const rows = galleryRows.filter((r) => r[column] === value);
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            if (table === users) {
              const rows = userRows.filter((r) => r[column] === value);
              return {
                limit: async (n: number) => rows.map((r) => ({ email: r.email })).slice(0, n),
              };
            }
            if (table === assets) {
              const rows = assetRows.filter((r) => r[column] === value);
              // `db.select({ value: count() })` vs. a plain row select —
              // same distinction as the proofs route's fake db.
              if (columns && "value" in columns) {
                return Promise.resolve([{ value: rows.length }]);
              }
              return Promise.resolve(rows);
            }
            throw new Error("fake db: unsupported table in select().where()");
          },
        }),
      }),
      // Task #61: `publishGallery`'s UPDATE is now `WHERE id = ... AND status
      // = 'draft'` (an `and()` of TWO conditions, not one bare `eq()`) and
      // ends in `.returning(...)` — this fake has to model BOTH changes, not
      // just tolerate them, or the guard this fake is meant to help prove
      // out would be invisible to it.
      update: (table: unknown) => ({
        set: (values: Row) => ({
          where: (condition: unknown) => {
            if (table !== galleries) throw new Error("fake db: unsupported table in update()");
            const conditions = parseConditions(condition).filter(
              (c): c is { dbColumnName: string; op: "eq"; value: unknown } => c.op === "eq",
            );
            if (conditions.length === 0) {
              throw new Error("eqColumnAndValue: not an eq() condition");
            }

            // Resolves a db column name back to the row's JS property key,
            // same job `eqColumnAndValue` does for a single condition —
            // generalized here across ALL of an `and()`'s leaves, so the
            // second condition (`status = 'draft'`) is actually enforced by
            // this fake and not silently dropped.
            const jsKeyFor = (dbColumnName: string) =>
              Object.entries(galleries as unknown as Record<string, unknown>).find(
                ([, col]) =>
                  col &&
                  typeof col === "object" &&
                  (col as { name?: string }).name === dbColumnName,
              )?.[0];

            // Deliberately runs to completion SYNCHRONOUSLY — no `await`
            // between reading the row and mutating it — which is what makes
            // this fake a faithful stand-in for Postgres's own row-level
            // atomicity. Two "concurrent" `publishGallery` calls in this
            // test file are two async functions interleaved by the JS event
            // loop at THEIR OWN await points; neither can be mid-way through
            // THIS function while the other runs it, so of two racing
            // UPDATEs against the same row, only one can ever observe (and
            // flip) `status = 'draft'` — exactly what the real `WHERE`
            // clause guarantees against a real table.
            const applyUpdate = (): Row[] => {
              if (failNextUpdate) {
                failNextUpdate = false;
                throw new Error("simulated update failure");
              }
              const row = galleryRows.find((r) =>
                conditions.every((c) => {
                  const jsKey = jsKeyFor(c.dbColumnName);
                  return jsKey !== undefined && r[jsKey] === c.value;
                }),
              );
              updateOutcomes.push(row ? 1 : 0);
              if (!row) return [];
              Object.assign(row, values);
              return [row];
            };

            return { returning: async () => applyUpdate() };
          },
        }),
      }),
      // Task #94: `getGalleryClients` (src/lib/galleries.ts) reads through
      // the relational API, `db.query.galleryClients.findMany(...)` — this
      // is what publishGallery now calls instead of a `users` lookup by the
      // (now nonexistent) `gallery.clientId`.
      //
      // Task #97: also asserts (and applies) the `removedAt IS NULL` half of
      // that same `where` — this fake THROWS if that filter is ever missing,
      // so a regression that drops it fails loudly here rather than quietly
      // re-emailing a removed client.
      query: {
        galleryClients: {
          findMany: async (args: { where: unknown }) => {
            const conditions = parseConditions(args.where);
            const galleryIdCond = conditions.find(
              (c): c is { dbColumnName: string; op: "eq"; value: unknown } =>
                c.dbColumnName === "gallery_id" && c.op === "eq",
            );
            if (!galleryIdCond) {
              throw new Error("fake db: expected a where on galleryClients.galleryId");
            }
            const hasRemovedAtFilter = conditions.some(
              (c) => c.dbColumnName === "removed_at" && c.op === "isNull",
            );
            if (!hasRemovedAtFilter) {
              throw new Error(
                "fake db: expected getGalleryClients to filter removedAt IS NULL (task #97)",
              );
            }
            return galleryClientRows
              .filter((r) => r.galleryId === galleryIdCond.value && r.removedAt == null)
              .map((r) => ({ user: userRows.find((u) => u.id === r.userId) }));
          },
        },
      },
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: {
        galleries: galleryRows,
        assets: assetRows,
        users: userRows,
        galleryClients: galleryClientRows,
      },
      __failNextUpdate: () => {
        failNextUpdate = true;
      },
      __updateOutcomes: updateOutcomes,
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { galleries: Row[]; assets: Row[]; users: Row[]; galleryClients: Row[] };
      __failNextUpdate: () => void;
      __updateOutcomes: number[];
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

function clientSession(): Session {
  return {
    user: { id: "client-1", role: "client", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "client-1";
const CLIENT_EMAIL = "ana@example.com";

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
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
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
  db.__rows.users.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__updateOutcomes.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.users.push({ id: CLIENT_ID, name: "Ana Pérez", email: CLIENT_EMAIL });
  // Task #94: ownership/notification recipients now come from the
  // `gallery_clients` join table, not a `clientId` column on the gallery.
  db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: CLIENT_ID });
  db.__rows.assets.push({ id: crypto.randomUUID(), galleryId: GALLERY_ID, sortOrder: 0 });
});

describe("publishGallery authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without sending anything or writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { publishGallery } = await import("./actions");

    await expect(
      publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(signInMock).not.toHaveBeenCalled();
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { publishGallery } = await import("./actions");

    await expect(
      publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });

    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("publishGallery validation and guards", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a malformed gallery id, before ever querying the database", async () => {
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: "not-a-uuid" }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it.each(["proofing", "selected", "delivered", "archived"])(
    "refuses to (re-)publish a gallery already in status %s",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { publishGallery } = await import("./actions");

      const result = await publishGallery(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID }),
      );

      expect(result.status).toBe("error");
      expect(signInMock).not.toHaveBeenCalled();
      expect(db.__rows.galleries[0]).toMatchObject({ status });
    },
  );

  // Acceptance criterion: a gallery with zero assets cannot be published —
  // enforced HERE, not only by hiding the button when the workspace shows
  // no photos.
  it("refuses to publish a draft gallery with zero assets, and never emails the client", async () => {
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Subí al menos una foto antes de publicar la galería.",
    });
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
  });
});

// Task #100's central refusal on this action. Since #100 a gallery can be
// CREATED with nobody attached, and since #97 a `draft` one can be stripped
// back down to zero — so an empty client list here is the ordinary case for
// the workflow the owner asked for, not a corrupt row. Publishing it anyway
// would flip the status to `proofing` and send exactly zero emails: a
// gallery "published" to nobody, which is the silent no-op the rule exists
// to prevent.
//
// MUTATION-PROVEN, twice, with the observed output:
//   1. Deleting the `if (activeClientViolation) return ...` block (keeping
//      the call, so the mutation lands on the GUARD and not on the shared
//      predicate) made both refusal tests below fail with
//      `expected 'published' to be 'error'`. The gallery published to zero
//      recipients — the exact silent no-op. `19 passed | 2 failed`.
//   2. Swapping `targetStatus: PUBLISH_TARGET_STATUS` for
//      `targetStatus: gallery.status` produced the IDENTICAL two failures,
//      same message. That is the whole reason the call names the
//      destination: `isPublishable` is `status === "draft"`, and the rule
//      exempts `draft`, so asking about the current status answers about a
//      state the transition is leaving and permits everything.
// Restoring each made all 21 pass again.
describe("publishGallery — refuses a gallery with no active clients", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  it("refuses to publish a gallery with no active clients, emails nobody, and leaves it in draft", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    // The shared rule's own Spanish copy (src/lib/galleries.ts) — it must say
    // what to DO, not merely that something is missing.
    expect(result.message).toMatch(/cliente/i);
    expect(result.message).toMatch(/agregale/i);
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // A soft-removed client (task #97) is not an active client — the row still
  // exists, so "there is a gallery_clients row" is not the question the guard
  // asks.
  it("refuses to publish when every attached client has been REMOVED", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_ID,
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
  });

  // The negative control the mutation notes above lean on: one active client
  // is enough, so a mutation that turned the guard into an unconditional
  // refusal would be caught here rather than looking harmless.
  it("publishes normally as soon as ONE active client is attached (negative control)", async () => {
    const db = await seededDb();
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "published" });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
  });
});

describe("publishGallery — send failure never half-publishes the gallery", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("leaves the gallery in draft and reports an error when signIn throws an AuthError", async () => {
    signInMock.mockRejectedValue(new AuthError("Resend error (500): boom"));
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("re-throws a non-AuthError failure from signIn instead of silently reporting it as a form error", async () => {
    signInMock.mockRejectedValue(new Error("totally unrelated bug"));
    const { publishGallery } = await import("./actions");

    await expect(
      publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toThrow("totally unrelated bug");

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
  });

  // The one side that CAN still leak (documented in actions.ts): email sent,
  // status update fails. The gallery must still read as "draft" afterward —
  // never a state where the write silently appears to have half-happened.
  it("reports a distinct error, but does not throw, when the email sends and the status update fails", async () => {
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
    const db = await seededDb();
    db.__failNextUpdate();
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/correo/);
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
  });
});

describe("publishGallery success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  it("emails the client's own address at the gallery-access provider with the gallery's URL", async () => {
    const { publishGallery } = await import("./actions");

    await publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));

    expect(signInMock).toHaveBeenCalledWith("gallery-access", {
      email: CLIENT_EMAIL,
      redirect: false,
      redirectTo: "/galleries/abc123",
    });
  });

  // Task #94's own acceptance criterion: every client attached to a gallery
  // gets the email, not just the first.
  it("emails EVERY client attached to the gallery when there are several", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-2", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-2" });
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "published" });
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-access",
      expect.objectContaining({ email: CLIENT_EMAIL }),
    );
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-access",
      expect.objectContaining({ email: "beto@example.com" }),
    );
  });

  // Task #97 acceptance criterion: a REMOVED client must never receive a
  // gallery-access email again, even though their `gallery_clients` row
  // still exists (soft delete).
  it("never emails a client whose membership was REMOVED (removedAt set)", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-2", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-2",
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "published" });
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-access",
      expect.objectContaining({ email: CLIENT_EMAIL }),
    );
    expect(signInMock).not.toHaveBeenCalledWith(
      "gallery-access",
      expect.objectContaining({ email: "beto@example.com" }),
    );
  });

  // Task #94's own decision: a partial send failure (one address bounces,
  // others don't) is NOT swallowed into a generic message, and does NOT
  // flip the gallery's status — same all-or-nothing stance as the
  // single-client case, generalized to N, with the failing address named
  // explicitly.
  it("names the specific address that failed when one of several sends fails, and does not flip the gallery's status", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-2", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-2" });
    signInMock.mockImplementation(async (_provider: string, opts: { email: string }) => {
      if (opts.email === "beto@example.com") {
        throw new AuthError("Resend error (500): boom");
      }
      return "http://localhost/api/auth/verify-request?provider=gallery-access";
    });
    const { publishGallery } = await import("./actions");

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain("beto@example.com");
    expect(result.message).not.toContain(CLIENT_EMAIL);
    expect(db.__rows.galleries[0]).toMatchObject({ status: "draft" });
  });

  it("flips the gallery from draft to proofing and revalidates both dashboard views", async () => {
    const { publishGallery } = await import("./actions");
    const db = await seededDb();

    const result = await publishGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "published" });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });

  it("sends the email BEFORE flipping the gallery's status", async () => {
    const callOrder: string[] = [];
    signInMock.mockImplementation(async () => {
      callOrder.push("signIn");
      return "http://localhost/api/auth/verify-request?provider=gallery-access";
    });
    const { db } = await import("@/lib/db");
    const realUpdate = db.update.bind(db);
    vi.spyOn(db, "update").mockImplementation((table: Parameters<typeof db.update>[0]) => {
      callOrder.push("update");
      return realUpdate(table);
    });
    const rows = await seededDb();
    const { publishGallery } = await import("./actions");

    await publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));

    expect(callOrder).toEqual(["signIn", "update"]);
    expect(rows.__rows.galleries[0]).toMatchObject({ status: "proofing" });
  });
});

// Task #61's own acceptance criterion: this simulates the RACE, it does not
// merely assert the guard exists. Two SEQUENTIAL calls (call, await, call
// again) would never reach the guard at all — by the time the second call's
// own SELECT ran, the first call's UPDATE would already have flipped the row
// to "proofing", so the second call would be turned away by `isPublishable()`
// long before it ever got near the `WHERE status = 'draft'` clause this task
// added. That is the exact failure this repo has shipped before, more than
// once (tasks #26, #73, #84, #90): a concurrency-sounding test name over
// code that runs sequentially and never actually interleaves.
describe("publishGallery — a genuine concurrent double-submit (task #61)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("guards the WRITE, not the read: both calls pass isPublishable() before either writes, yet exactly one row-update lands", async () => {
    // The interleave, made deterministic rather than hoped-for: `signIn` is
    // the LAST thing both calls do before reaching the guarded UPDATE, and
    // it only runs after every read-side check above it (isPublishable, the
    // asset count, the active-client rule) already passed against a gallery
    // still `draft` in memory — no call has written yet at this point. By
    // gating `signIn`'s own resolution on "the OTHER call has ALSO reached
    // signIn", neither of the two `publishGallery` invocations below can
    // proceed to its UPDATE until BOTH have already cleared every read-side
    // check. That is precisely the real-world condition the ticket
    // describes — a photographer double-clicking "Publicar" on a slow
    // connection, where BOTH clicks' requests are already in flight, past
    // their own reads, before either one's write lands.
    let inFlightSignIns = 0;
    let releaseSignIns!: () => void;
    const bothCallsReadySignInGate = new Promise<void>((resolve) => {
      releaseSignIns = resolve;
    });
    signInMock.mockImplementation(async () => {
      inFlightSignIns += 1;
      if (inFlightSignIns === 2) releaseSignIns();
      await bothCallsReadySignInGate;
      return "http://localhost/api/auth/verify-request?provider=gallery-access";
    });

    const { publishGallery } = await import("./actions");

    const [resultA, resultB] = await Promise.all([
      publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
      publishGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ]);

    // Proves the interleave actually happened: if either call had run to
    // completion before the other started (the sequential-test failure mode
    // this suite is explicitly guarding against), the gate above would have
    // deadlocked — `inFlightSignIns` would be stuck at 1, and this test
    // would time out rather than reach this assertion.
    expect(inFlightSignIns).toBe(2);

    // The guard itself: of the two racing UPDATEs against the SAME row,
    // exactly one `WHERE status = 'draft'` clause matches (1 row affected)
    // and the other matches zero. Without the `AND status = 'draft'` clause
    // this task added, BOTH would match and this array would be `[1, 1]`.
    //
    // MUTATION-PROVEN: reverting the `.where()` clause to the pre-#61
    // `eq(galleries.id, gallery.id)` alone (dropping the `AND status =
    // 'draft'`) turns this exact assertion red — `AssertionError: expected
    // [ 1, 1 ] to deeply equal [ 0, 1 ]` — while every OTHER test in this
    // file keeps passing (`21 passed | 1 failed`). That is the guard being
    // caught in the act of being missing, not merely a name suggesting so.
    const db = await seededDb();
    expect(db.__updateOutcomes.sort()).toEqual([0, 1]);

    // Exactly one status transition landed — the ticket's core requirement.
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });

    // Neither the winner nor the loser sees this as an error. The losing
    // call's write matched zero rows, but the gallery it asked about IS
    // published — by the other call, a moment earlier — so both resolve
    // identically. See publishGallery's own comment on the
    // `updated.length === 0` branch for why an error here would be the
    // wrong signal to the photographer.
    expect(resultA).toEqual({ status: "published" });
    expect(resultB).toEqual({ status: "published" });

    // What this guard deliberately does NOT fix (the ticket's own "watch
    // out", and why this task never reorders the send below the write):
    // both calls' emails were already sent by the time either reached the
    // guarded write, so a true simultaneous double-submit still emails the
    // client twice. Documented, accepted, and unchanged by this task — each
    // Auth.js magic-link token is independently single-use (delete-then-
    // return), so only one of the two links survives being clicked first.
    expect(signInMock).toHaveBeenCalledTimes(2);
  });
});
