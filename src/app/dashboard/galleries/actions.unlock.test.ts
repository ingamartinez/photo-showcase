import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts,
// same stub as this directory's own actions.publish.test.ts.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale — BOTH exports this file's transitive imports
// actually need: `auth()` (via requireAdmin()) and `signIn()` (called
// directly by unlockSelection since task #85, the SAME MECHANISM
// `publishGallery`/`deliverGallery` use, on its own `gallery-unlock`
// provider — see actions.ts's own header comment on `unlockSelection` for
// why this is a magic link rather than the bare gallery URL task #73
// originally shipped).
const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// `unlockSelection` lives in the SAME MODULE as `publishGallery`, which
// imports `AuthError` from "next-auth" at the top of the file — the real
// package's root index eagerly imports `./lib/env.js` (which imports
// `next/server`) at module scope, unresolvable under Vitest. Mocked
// wholesale, same fix as actions.publish.test.ts's own identical mock.
// Unlike before task #85, this suite NOW exercises the `AuthError` branch —
// see the "client notification failure" describe block below.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// `revalidatePath` throws outside a real Next.js request — stubbed so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// Task #114: `unlockSelection` is one of the three write paths that must
// signal the shared selection changed — this is the direction #73's own
// "converges BOTH ways" promise depends on: an admin unlock has to reopen
// every open client tab live, not just close one.
const notifySelectionChangedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: (...args: [string]) => notifySelectionChangedMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` supporting BOTH a
// plain `eq()` and an `and(eq(), eq())` condition (this action's atomic
// conditional UPDATE needs the latter) — same `flattenChunks`/`eqConditions`
// approach as
// src/app/api/galleries/[galleryId]/submit-selection/route.test.ts's own
// fake db, reused here rather than re-deriving it, since this action's own
// UPDATE is guarded the identical way.
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

// Always returns a FRESH copy, never the live row object — a real `SELECT`
// returns a point-in-time snapshot, not a handle a later, unrelated UPDATE
// could mutate out from under an already-in-flight caller. Returning the
// live reference here (as this helper originally did for the no-`columns`
// case) let a WINNING concurrent call's `Object.assign` corrupt a LOSING
// call's already-read `gallery` object between its `await` points, which
// made `isUnlockable(gallery.status)` — a plain, non-atomic pre-flight
// check — appear to catch the race on its own. That defeated the entire
// point of the `Promise.all` race test below: removing the real guard
// (`eq(galleries.status, "selected")`) from the UPDATE's `WHERE` in
// actions.ts did NOT make that test fail, because the aliasing bug was
// silently doing the guard's job instead of the UPDATE's own `WHERE` clause.
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
      // is what unlockSelection now calls instead of a `users` lookup by
      // the (now nonexistent) `gallery.clientId`.
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
const CLIENT_ID = "client-a";
const CLIENT_EMAIL = "ana@example.com";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

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
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
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
  db.__rows.assets.push({ id: ASSET_1_ID, galleryId: GALLERY_ID, isSelected: true });
});

describe("unlockSelection authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing or emailing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { unlockSelection } = await import("./actions");

    await expect(
      unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(signInMock).not.toHaveBeenCalled();
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { unlockSelection } = await import("./actions");

    await expect(
      unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });

    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("unlockSelection validation and guards", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a malformed gallery id, before ever querying the database", async () => {
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: "not-a-uuid" }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });

  it.each(["draft", "proofing", "delivered", "archived"])(
    "refuses to unlock a gallery in status %s — only `selected` has anything to unlock",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { unlockSelection } = await import("./actions");

      const result = await unlockSelection(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID }),
      );

      expect(result.status).toBe("error");
      expect(signInMock).not.toHaveBeenCalled();
      expect(db.__rows.galleries[0]).toMatchObject({ status });
    },
  );

  it("rejects a reason that is unreasonably long, before writing anything", async () => {
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, reason: "x".repeat(1001) }),
    );

    expect(result.status).toBe("error");
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected", unlockedAt: null });
  });
});

describe("unlockSelection success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession("photographer@example.com"));
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-unlock",
    );
  });

  it("flips the gallery from selected to proofing, revalidates both dashboard views, and preserves selectionSubmittedAt", async () => {
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();
    const submittedAt = db.__rows.galleries[0]!.selectionSubmittedAt;

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "unlocked" });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    // The decision this task pins down: PRESERVE selectionSubmittedAt on
    // unlock — see actions.ts's own header comment for the full reasoning
    // (task #75 made it the dashboard's sort key).
    expect(db.__rows.galleries[0]!.selectionSubmittedAt).toBe(submittedAt);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    // Task #114 — every open client tab reopens live off this signal.
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_ID);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });

  // Acceptance criterion: "the unlock is visible in the record — who did it
  // and when, at minimum."
  it("records who unlocked it (the acting admin's own session email) and when", async () => {
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();
    const before = Date.now();

    await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, reason: "Hablamos por WhatsApp." }),
    );

    const row = db.__rows.galleries[0]!;
    expect(row.unlockedByEmail).toBe("photographer@example.com");
    expect(row.unlockReason).toBe("Hablamos por WhatsApp.");
    expect(row.unlockedAt).toBeInstanceOf(Date);
    expect((row.unlockedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("records a null reason when the admin leaves it blank", async () => {
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();

    await unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));

    expect(db.__rows.galleries[0]!.unlockReason).toBeNull();
  });

  // Task #85: the notification moved off a bare `/galleries/{slug}` URL
  // (src/lib/unlock-notification-email.ts, now removed) onto a magic link,
  // the SAME mechanism `publishGallery`/`deliverGallery` use, on its own
  // `gallery-unlock` provider.
  it("emails the client at their own address via the gallery-unlock provider, with the gallery's own URL", async () => {
    const { unlockSelection } = await import("./actions");

    await unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));

    expect(signInMock).toHaveBeenCalledWith("gallery-unlock", {
      email: CLIENT_EMAIL,
      redirect: false,
      redirectTo: "/galleries/abc123",
    });
  });

  // Task #94's own acceptance criterion: every client attached to the
  // gallery is notified, not just the first.
  it("emails EVERY client attached to the gallery when there are several", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-b", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-b" });
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "unlocked" });
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-unlock",
      expect.objectContaining({ email: CLIENT_EMAIL }),
    );
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-unlock",
      expect.objectContaining({ email: "beto@example.com" }),
    );
  });

  // Task #97 acceptance criterion: a REMOVED client must never receive an
  // unlock notification either, even though their `gallery_clients` row
  // still exists (soft delete).
  it("never notifies a client whose membership was REMOVED (removedAt set)", async () => {
    const db = await seededDb();
    db.__rows.users.push({ id: "client-b", name: "Beto Ruiz", email: "beto@example.com" });
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-b",
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result).toEqual({ status: "unlocked" });
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-unlock",
      expect.objectContaining({ email: CLIENT_EMAIL }),
    );
  });

  // The gate this task's own acceptance criterion asks to verify against —
  // the REAL SELECTION_LOCKED_STATUSES set, not an assumption — imported
  // directly from the sibling PATCH route rather than duplicated here, so a
  // future change to that route's own gate is what this test actually
  // tracks.
  it("leaves the gallery in a status the real SELECTION_LOCKED_STATUSES gate does NOT refuse", async () => {
    const { SELECTION_LOCKED_STATUSES } =
      await import("@/app/api/assets/[assetId]/selection/route");
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();

    await unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID }));

    const newStatus = db.__rows.galleries[0]!.status as "proofing";
    expect(SELECTION_LOCKED_STATUSES.has(newStatus)).toBe(false);
  });

  it("re-throws a non-AuthError failure from signIn instead of silently reporting it as a form error", async () => {
    signInMock.mockRejectedValue(new Error("totally unrelated bug"));
    const { unlockSelection } = await import("./actions");

    await expect(
      unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ).rejects.toThrow("totally unrelated bug");
  });
});

describe("unlockSelection — client notification failure", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // The unlock itself must NEVER be rolled back to "fix" an unrelated email
  // failure (see actions.ts's own header comment) — but the admin must
  // learn immediately, since the client has no other way to discover the
  // reopen on their own.
  it("still unlocks the gallery, but reports a distinct result, when the client email fails to send", async () => {
    const { AuthError } = await import("next-auth");
    signInMock.mockRejectedValue(new AuthError("Resend error (500): boom"));
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("unlocked_email_failed");
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
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
      return "http://localhost/api/auth/verify-request?provider=gallery-unlock";
    });
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("unlocked_email_failed");
    expect(result.message).toContain("beto@example.com");
    expect(result.message).not.toContain(CLIENT_EMAIL);
    // The unlock itself still committed for BOTH clients — a partial email
    // failure never rolls back the durable state transition.
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
  });

  it("also reports the distinct failure result when the gallery has no clients attached at all", async () => {
    const db = await seededDb();
    // This comment claimed "unreachable BY DESIGN (gallery-form.tsx requires
    // at least one client at creation)" until task #100 made that false — #97
    // added a removal path, and #100 removed the creation-time requirement.
    // Reachable, narrowly: `isUnlockable` is `status === "selected"`, which
    // the rule protects, so `removeGalleryClient` refuses to strip the last
    // client off a gallery that could get here. The only route is the
    // read-then-write race that action documents in its own header.
    //
    // And unlockSelection deliberately does NOT refuse this, unlike
    // deliverGallery — see its own comment at the client lookup for why
    // (unlock neither causes nor worsens the violating state).
    db.__rows.galleryClients.length = 0;
    const { unlockSelection } = await import("./actions");

    const result = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("unlocked_email_failed");
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
  });
});

describe("unlockSelection — concurrent unlock (the atomic guard)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-unlock",
    );
  });

  // A SEQUENTIAL double-unlock (the first call fully resolves before the
  // second one starts) only exercises the pre-flight `isUnlockable` check at
  // the top of the action — the second call's own read already sees
  // `status: "proofing"` and short-circuits before ever reaching the UPDATE.
  // Real, worth covering on its own, but NOT proof the CAS guard works: this
  // same assertion would still pass even if the UPDATE's own
  // `eq(galleries.status, "selected")` half of the `and(...)` were deleted
  // entirely, because the second call never reaches it.
  it("the second of two SEQUENTIAL unlocks short-circuits before ever reaching the UPDATE", async () => {
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();

    const first = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );
    const second = await unlockSelection(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(first.status).toBe("unlocked");
    expect(second.status).toBe("error");
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  // THE actual proof of the atomicity guard (actions.ts's own "the UPDATE's
  // own `WHERE status = 'selected'` is the REAL, atomic guard" comment): two
  // unlocks issued via `Promise.all`, so BOTH calls run past every read
  // (auth, gallery lookup, the `isUnlockable` pre-flight check) and reach
  // `db.update(...).where(and(eq(id), eq(status, "selected")))` before either
  // one has mutated anything — genuinely racing the UPDATE itself, not the
  // pre-flight short-circuit above. The fake `@/lib/db` mutates its rows
  // SYNCHRONOUSLY inside `.where()` (no extra `await` in between), which is
  // what makes this a meaningful test at all: JS's single-threaded run-to-
  // completion between `await` points means whichever of the two
  // `unlockSelection` calls' turns comes up first at that exact line
  // completes its match-and-mutate atomically before the other one can
  // interleave — exactly mirroring how Postgres serializes two concurrent
  // UPDATEs against the same row. Deleting the `eq(galleries.status,
  // "selected")` half of the action's `and(...)` (this task's own review
  // proved it by doing exactly that) makes BOTH calls match and mutate, and
  // this test catches that: two winners, and a second email, instead of one.
  it("lets exactly one of two racing unlocks (via Promise.all) win the atomic UPDATE", async () => {
    const { unlockSelection } = await import("./actions");
    const db = await seededDb();

    const [first, second] = await Promise.all([
      unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
      unlockSelection({ status: "idle" }, formDataWith({ galleryId: GALLERY_ID })),
    ]);

    // Exactly one winner ("unlocked") and one loser ("error") — never two
    // winners, which would mean the guard let both through.
    expect([first.status, second.status].sort()).toEqual(["error", "unlocked"]);
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    // Only the WINNER's email ever went out.
    expect(signInMock).toHaveBeenCalledTimes(1);
  });
});
