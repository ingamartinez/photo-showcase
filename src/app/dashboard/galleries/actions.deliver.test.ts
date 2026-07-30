import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts,
// same stub as this directory's own actions.publish.test.ts /
// actions.unlock.test.ts.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale — BOTH exports this file's transitive imports
// actually need: `auth()` (via requireAdmin()) and `signIn()` (called
// directly by deliverGallery, the SAME provider call `publishGallery` makes
// — see actions.ts's own header comment on `deliverGallery` for why this
// reuses `signIn("gallery-access", ...)` rather than a bare gallery URL).
const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// `deliverGallery` lives in the SAME MODULE as `publishGallery`/
// `unlockSelection`, which import `AuthError` from "next-auth" at the top of
// the file — the real package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) at module scope, unresolvable under Vitest.
// Mocked wholesale, same fix as actions.publish.test.ts / actions.unlock.test.ts.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// `revalidatePath` throws outside a real Next.js request — stubbed so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` supporting BOTH a
// plain `eq()` and an `and(eq(), eq())` condition (this action's atomic
// conditional UPDATE needs the latter) — the SAME `flattenChunks`/
// `eqConditions`/`project` approach as actions.unlock.test.ts's own fake db,
// reused here verbatim rather than re-derived, since this action's own
// UPDATE is guarded the identical way. In particular this copies the FIXED
// `project()` (always returns a fresh `{ ...row }`, never the live row
// object) — see actions.unlock.test.ts's own comment on this exact function
// for why the naive version silently defeated its own concurrency test, and
// the sibling bug still open as task #84 in submit-selection/route.test.ts.
type Row = Record<string, unknown>;

// Task #97: upgraded from a pure `eq()`-chain flattener to a LEAF-aware
// parser (same shape as src/lib/gallery-access.test.ts's own) so it also
// understands `isNull()` — `getGalleryClients` now filters `removedAt IS
// NULL` alongside `galleryId`. Reads each SQL node's own chunks locally
// (never flattening across node boundaries), so an `eq()`'s value chunk can
// never be mistaken for a sibling `isNull()`'s absence of one.
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

function walkConditions(node: unknown): LeafCondition[] {
  const leaf = parseLeaf(node);
  if (leaf) return [leaf];
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const results: LeafCondition[] = [];
  for (const chunk of chunks) results.push(...walkConditions(chunk));
  return results;
}

function eqConditions(condition: unknown): LeafCondition[] {
  const results = walkConditions(condition);
  if (results.length === 0) {
    throw new Error("eqConditions: not a supported eq()/isNull()/and(...) condition");
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
  return eqConditions(condition).every((c) => {
    const jsKey = jsKeyFor(table, c.dbColumnName);
    return c.op === "isNull" ? row[jsKey] == null : row[jsKey] === c.value;
  });
}

// Always returns a FRESH copy, never the live row object — see this file's
// header comment / actions.unlock.test.ts's own comment on why this matters
// for the `Promise.all` race test below to be a meaningful proof of the
// atomic guard rather than an artifact of row aliasing.
function project(row: Row, columns: Record<string, unknown> | undefined): Row {
  if (!columns) return { ...row };
  const projected: Row = {};
  for (const key of Object.keys(columns)) projected[key] = row[key];
  return projected;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries, users, galleryClients } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const assetRows: Row[] = [];
  const userRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  function rowsFor(table: unknown): Row[] {
    if (table === galleries) return galleryRows;
    if (table === assets) return assetRows;
    if (table === users) return userRows;
    if (table === galleryClients) return galleryClientRows;
    throw new Error("fake db: unsupported table");
  }

  function tableShapeFor(table: unknown): Record<string, unknown> {
    if (table === galleries) return galleries as unknown as Record<string, unknown>;
    if (table === assets) return assets as unknown as Record<string, unknown>;
    if (table === users) return users as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const rows = rowsFor(table)
              .filter((row) => matchesRow(row, tableShapeFor(table), condition))
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
            const snapshot = matches.map((row) => ({ ...row }));
            const promise = Promise.resolve(snapshot) as Promise<Row[]> & {
              returning: () => Promise<Row[]>;
            };
            promise.returning = async () => snapshot;
            return promise;
          },
        }),
      }),
      // Task #94: `getGalleryClients` (src/lib/galleries.ts) reads through
      // the relational API, `db.query.galleryClients.findMany(...)` — this
      // is what deliverGallery now calls instead of a `users` lookup by the
      // (now nonexistent) `gallery.clientId`.
      //
      // Task #97: also asserts (and applies) the `removedAt IS NULL` half of
      // that same `where` — throws if that filter is ever missing, so a
      // regression that drops it fails loudly here rather than quietly
      // re-emailing a removed client.
      query: {
        galleryClients: {
          findMany: async (args: { where: unknown }) => {
            const conditions = eqConditions(args.where);
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
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; assets: Row[]; users: Row[]; galleryClients: Row[] } };
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
const CLIENT_ID = "client-a";
const CLIENT_EMAIL = "ana@example.com";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ASSET_2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

function galleryRow(overrides: Row = {}): Row {
  return {
    id: GALLERY_ID,
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "selected",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: new Date("2026-07-20T10:00:00.000Z"),
    deliveredAt: null,
    unlockedAt: null,
    unlockedByEmail: null,
    unlockReason: null,
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
  db.__rows.galleries.push(galleryRow());
  db.__rows.users.push({ id: CLIENT_ID, name: "Ana Pérez", email: CLIENT_EMAIL });
  // Task #94: ownership/notification recipients now come from the
  // `gallery_clients` join table, not a `clientId` column on the gallery.
  db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: CLIENT_ID });
  // Default fixture: a single selected asset that already has its final —
  // deliverable out of the box. Tests that need a missing final override
  // this.
  db.__rows.assets.push({
    id: ASSET_1_ID,
    galleryId: GALLERY_ID,
    isSelected: true,
    finalKey: "galleries/g/assets/a1/final.jpg",
  });
});

describe("deliverGallery authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing or emailing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { deliverGallery } = await import("./actions");

    await expect(
      deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(signInMock).not.toHaveBeenCalled();
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { deliverGallery } = await import("./actions");

    await expect(
      deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });

    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("deliverGallery validation and guards", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a malformed gallery id, before ever querying the database", async () => {
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: "not-a-uuid" }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it.each(["draft", "proofing", "delivered", "archived"])(
    "refuses to deliver a gallery in status %s — only `selected` has anything to deliver",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { deliverGallery } = await import("./actions");

      const result = await deliverGallery(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID }),
      );

      expect(result.status).toBe("error");
      expect(signInMock).not.toHaveBeenCalled();
      expect(db.__rows.galleries[0]).toMatchObject({ status });
    },
  );

  // THE core rule of this slice, and it must be enforced HERE, not only by
  // <GalleryWorkspace>'s own "Faltan N de M finales" counter (task #26) —
  // that counter is a convenience while the photographer works, this check
  // is the authority a crafted request cannot bypass.
  it("refuses delivery while a selected asset still lacks a final", async () => {
    const db = await seededDb();
    db.__rows.assets.push({
      id: ASSET_2_ID,
      galleryId: GALLERY_ID,
      isSelected: true,
      finalKey: null,
    });
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Falta 1 final por subir antes de poder entregar esta galería.",
    });
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("pluralizes the missing-finals count when more than one is missing", async () => {
    const db = await seededDb();
    db.__rows.assets.push(
      { id: ASSET_2_ID, galleryId: GALLERY_ID, isSelected: true, finalKey: null },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        galleryId: GALLERY_ID,
        isSelected: true,
        finalKey: null,
      },
    );
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Faltan 2 finales por subir antes de poder entregar esta galería.",
    });
    expect(signInMock).not.toHaveBeenCalled();
  });

  // An UNSELECTED asset with no final must never block delivery — finals
  // exist only for selected assets (schema.ts, PLAN.md §2's epic rule), so a
  // null `finalKey` on a non-selected asset is the expected, common case.
  it("does not count a missing final on an unselected asset", async () => {
    const db = await seededDb();
    db.__rows.assets.push({
      id: ASSET_2_ID,
      galleryId: GALLERY_ID,
      isSelected: false,
      finalKey: null,
    });
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "delivered" });
  });
});

describe("deliverGallery success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  it("flips the gallery from selected to delivered, stamps deliveredAt, and revalidates both dashboard views", async () => {
    const { deliverGallery } = await import("./actions");
    const db = await seededDb();
    const before = Date.now();

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "delivered" });
    const row = db.__rows.galleries[0]!;
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect((row.deliveredAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });

  // "A real email lands, with a working link to the gallery" — this reuses
  // the SAME `signIn("gallery-access", ...)` mechanism publishGallery uses,
  // which is what actually GRANTS access on click (a fresh single-use
  // token + a brand-new database session), rather than a bare URL that
  // assumes the client's original session from the publish email is still
  // valid — see actions.ts's own header comment on `deliverGallery` for the
  // full reasoning.
  it("emails the client at their own address via the gallery-access provider, with the gallery's own URL", async () => {
    const { deliverGallery } = await import("./actions");

    await deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));

    expect(signInMock).toHaveBeenCalledWith("gallery-access", {
      email: CLIENT_EMAIL,
      redirect: false,
      redirectTo: "/galleries/abc123",
    });
  });

  // Task #94's own acceptance criterion: every client attached to the
  // gallery gets a working link, not just the first.
  it("emails EVERY client attached to the gallery when there are several", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-b", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-b" });
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "delivered" });
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
  // delivery email either, even though their `gallery_clients` row still
  // exists (soft delete).
  it("never emails a client whose membership was REMOVED (removedAt set)", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-b", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-b",
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "delivered" });
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

  it("re-throws a non-AuthError failure from signIn instead of silently reporting it as a form error", async () => {
    signInMock.mockRejectedValue(new Error("totally unrelated bug"));
    const { deliverGallery } = await import("./actions");

    await expect(
      deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toThrow("totally unrelated bug");
  });
});

describe("deliverGallery — client notification failure", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // The delivery itself must NEVER be rolled back to "fix" an unrelated
  // email failure (same stance as unlockSelection) — but the admin must
  // learn immediately, since the client has no other way to discover the
  // delivery on their own.
  it("still delivers the gallery, but reports a distinct result, when the client email fails to send", async () => {
    const { AuthError } = await import("next-auth");
    signInMock.mockRejectedValue(new AuthError("Resend error (500): boom"));
    const { deliverGallery } = await import("./actions");
    const db = await seededDb();

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("delivered_email_failed");
    expect(db.__rows.galleries[0]).toMatchObject({ status: "delivered" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });

  it("also reports the distinct failure result when the gallery has no clients attached at all", async () => {
    const db = await seededDb();
    // Task #94: unreachable BY DESIGN (gallery-form.tsx requires at least
    // one client at creation) but proven here anyway, same "never trust the
    // invariant blindly" stance as this file's own header comment on the
    // action.
    db.__rows.galleryClients.length = 0;
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("delivered_email_failed");
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "delivered" });
  });

  // Task #94's own decision: a partial send failure names exactly which
  // address(es) failed, rather than collapsing into the same generic
  // message a total failure would produce.
  it("names the specific address that failed when one of several clients' sends fails", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-b", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-b" });
    const { AuthError } = await import("next-auth");
    signInMock.mockImplementation(async (_provider: string, opts: { email: string }) => {
      if (opts.email === "beto@example.com") throw new AuthError("Resend error (500): boom");
      return "http://localhost/api/auth/verify-request?provider=gallery-access";
    });
    const { deliverGallery } = await import("./actions");

    const result = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("delivered_email_failed");
    expect(result.message).toContain("beto@example.com");
    expect(result.message).not.toContain(CLIENT_EMAIL);
    expect(db.__rows.galleries[0]).toMatchObject({ status: "delivered" });
  });
});

describe("deliverGallery — concurrent delivery (the atomic guard)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  // A SEQUENTIAL double-delivery (the first call fully resolves before the
  // second one starts) only exercises the pre-flight `isDeliverable` check
  // at the top of the action — the second call's own read already sees
  // `status: "delivered"` and short-circuits before ever reaching the
  // UPDATE. Real, worth covering on its own, but NOT proof the CAS guard
  // works — see the `Promise.all` test below for that, and
  // actions.unlock.test.ts's own identical comment for the full reasoning.
  it("the second of two SEQUENTIAL deliveries short-circuits before ever reaching the UPDATE", async () => {
    const { deliverGallery } = await import("./actions");
    const db = await seededDb();

    const first = await deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));
    const second = await deliverGallery(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(first.status).toBe("delivered");
    expect(second.status).toBe("error");
    expect(db.__rows.galleries[0]).toMatchObject({ status: "delivered" });
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  // THE actual proof of the atomicity guard: two deliveries issued via
  // `Promise.all`, so BOTH calls run past every read (auth, gallery lookup,
  // the `isDeliverable` pre-flight check, the missing-finals check) and
  // reach `db.update(...).where(and(eq(id), eq(status, "selected")))` before
  // either one has mutated anything — genuinely racing the UPDATE itself,
  // not the pre-flight short-circuit above. The fake `@/lib/db` mutates its
  // rows SYNCHRONOUSLY inside `.where()` (no extra `await` in between),
  // which is what makes this a meaningful test at all — same reasoning as
  // actions.unlock.test.ts's own identical test.
  //
  // MUTATION-TESTED, per this task's own instructions: deleting the
  // `eq(galleries.status, "selected")` half of the action's `and(...)` in
  // the UPDATE's `where()` made BOTH calls win — `[first.status,
  // second.status].sort()` became `["delivered", "delivered"]` instead of
  // `["delivered", "error"]`, and `signInMock` was called twice instead of
  // once. Restoring the guard made this test pass again. See this task's
  // final report for both observations.
  it("lets exactly one of two racing deliveries (via Promise.all) win the atomic UPDATE", async () => {
    const { deliverGallery } = await import("./actions");
    const db = await seededDb();

    const [first, second] = await Promise.all([
      deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
      deliverGallery({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ]);

    // Exactly one winner ("delivered") and one loser ("error") — never two
    // winners, which would mean the guard let both through.
    expect([first.status, second.status].sort()).toEqual(["delivered", "error"]);
    expect(db.__rows.galleries[0]).toMatchObject({ status: "delivered" });
    // Only the WINNER's email ever went out.
    expect(signInMock).toHaveBeenCalledTimes(1);
  });
});
