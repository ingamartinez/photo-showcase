import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale here — BOTH exports this file's transitive
// imports actually need: `auth()` (via requireAdmin()) and `signIn()`
// (called directly by attachGalleryClients, the SAME provider call
// `publishGallery`/`deliverGallery` already make — see actions.ts's own
// header comment on `attachGalleryClients` for why).
const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) at module scope, unresolvable under Vitest —
// mocked wholesale, same fix as every sibling actions.*.test.ts in this
// directory.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// `revalidatePath` throws outside a real Next.js request — stubbed so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering via a
// leaf-condition parser understanding `eq()`, `isNull()`, and `inArray()`
// (this action's own reads/writes use all three). Duplicated per this
// codebase's own per-file test-double convention rather than shared — see
// src/lib/gallery-access.test.ts's identical `eq`/`isNull` parser for the
// two-leaf-type version this extends with `inArray`.
type Row = Record<string, unknown>;

type LeafCondition =
  | { dbColumnName: string; op: "eq"; value: unknown }
  | { dbColumnName: string; op: "isNull" }
  | { dbColumnName: string; op: "inArray"; values: unknown[] };

function parseLeaf(node: unknown): LeafCondition | undefined {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return undefined;
  let dbColumnName: string | undefined;
  let value: unknown;
  let hasValue = false;
  let isNullText = false;
  let inArrayValues: unknown[] | undefined;
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) {
      inArrayValues = chunk
        .filter((item) => item && typeof item === "object" && "value" in item && "encoder" in item)
        .map((item) => (item as { value: unknown }).value);
      continue;
    }
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
  if (inArrayValues) return { dbColumnName, op: "inArray", values: inArrayValues };
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

function conditions(condition: unknown): LeafCondition[] {
  const results = walkConditions(condition);
  if (results.length === 0) {
    throw new Error("conditions: not a supported eq()/isNull()/inArray()/and(...) condition");
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
    if (c.op === "isNull") return row[jsKey] == null;
    if (c.op === "inArray") return c.values.includes(row[jsKey]);
    return row[jsKey] === c.value;
  });
}

vi.mock("@/lib/db", async () => {
  const { galleries, galleryClients, users } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const userRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  function rowsFor(table: unknown): Row[] {
    if (table === galleries) return galleryRows;
    if (table === users) return userRows;
    if (table === galleryClients) return galleryClientRows;
    throw new Error("fake db: unsupported table");
  }

  function tableShapeFor(table: unknown): Record<string, unknown> {
    if (table === galleries) return galleries as unknown as Record<string, unknown>;
    if (table === users) return users as unknown as Record<string, unknown>;
    if (table === galleryClients) return galleryClients as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }

  // Writes are exposed both directly on `db` and (identically) on the `tx`
  // handed to `db.transaction`'s callback — the action wraps its INSERT and
  // its UPDATE in one transaction (actions.ts), and a fake with no
  // `transaction` at all would make that unrunnable rather than untested.
  // Test-only fault injection, set by the atomicity tests below. There is
  // one fault per statement, ON PURPOSE and symmetrically: see those tests'
  // own comment for why a single fault on whichever statement happens to run
  // second would only prove atomicity by accident of statement order.
  const faults = { failNextUpdate: false, failNextInsert: false };

  const writeOps = {
    insert: (table: unknown) => ({
      values: (rowOrRows: Row | Row[]) => {
        if (table !== galleryClients) throw new Error("fake db: unsupported table in insert()");
        if (faults.failNextInsert) {
          faults.failNextInsert = false;
          return Promise.reject(new Error("simulated failure inserting membership"));
        }
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        galleryClientRows.push(
          ...rows.map((row) => ({ createdAt: new Date(), removedAt: null, ...row })),
        );
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => {
          if (table !== galleryClients) throw new Error("fake db: unsupported table in update()");
          if (faults.failNextUpdate) {
            faults.failNextUpdate = false;
            return Promise.reject(new Error("simulated failure clearing removed_at"));
          }
          const matches = galleryClientRows.filter((row) =>
            matchesRow(row, galleryClients as unknown as Record<string, unknown>, condition),
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
      // Genuinely rolls back, rather than just invoking the callback: the
      // committed rows are snapshotted (row objects copied, since `update`
      // above mutates them in place) before `fn` runs and restored IN PLACE
      // if it throws, so a mid-transaction failure is actually observable —
      // the same lesson actions.test.ts's own fake learned when "both
      // inserts in ONE transaction" turned out to be documented but
      // unproven. A throw propagates out, exactly like a real ROLLBACK.
      transaction: async (fn: (tx: typeof writeOps) => Promise<unknown>) => {
        const snapshot = galleryClientRows.map((row) => ({ ...row }));
        try {
          return await fn(writeOps);
        } catch (error) {
          galleryClientRows.length = 0;
          galleryClientRows.push(...snapshot);
          throw error;
        }
      },
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const rows = rowsFor(table).filter((row) =>
              matchesRow(row, tableShapeFor(table), condition),
            );
            const project = (row: Row) => {
              if (!columns) return { ...row };
              const projected: Row = {};
              for (const key of Object.keys(columns)) projected[key] = row[key];
              return projected;
            };
            const projected = rows.map(project);
            const promise = Promise.resolve(projected) as Promise<Row[]> & {
              limit: (n: number) => Promise<Row[]>;
            };
            promise.limit = async (n: number) => projected.slice(0, n);
            return promise;
          },
        }),
      }),
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { galleries: galleryRows, users: userRows, galleryClients: galleryClientRows },
      __faults: faults,
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { galleries: Row[]; users: Row[]; galleryClients: Row[] };
      __faults: { failNextUpdate: boolean; failNextInsert: boolean };
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
    user: { id: "client-x", role: "client", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_A = "client-a";
const CLIENT_A_EMAIL = "ana@example.com";
const CLIENT_B = "client-b";
const CLIENT_B_EMAIL = "beto@example.com";

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
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function formDataWith(fields: Record<string, string | string[] | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) data.append(key, v);
    } else {
      data.set(key, value);
    }
  }
  return data;
}

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  revalidatePathMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__faults.failNextUpdate = false;
  db.__faults.failNextInsert = false;
  db.__rows.galleries.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.users.push({ id: CLIENT_A, name: "Ana Pérez", email: CLIENT_A_EMAIL });
  db.__rows.users.push({ id: CLIENT_B, name: "Beto Ruiz", email: CLIENT_B_EMAIL });
});

describe("attachGalleryClients authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing or emailing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { attachGalleryClients } = await import("./actions");

    await expect(
      attachGalleryClients(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(signInMock).not.toHaveBeenCalled();
    const db = await seededDb();
    expect(db.__rows.galleryClients).toHaveLength(0);
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { attachGalleryClients } = await import("./actions");

    await expect(
      attachGalleryClients(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });

    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("attachGalleryClients validation and guards", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a request with no clientIds at all", async () => {
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a client id that does not exist, without writing anything", async () => {
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: ["does-not-exist"] }),
    );

    expect(result).toEqual({ status: "error", message: "Elegí clientes válidos." });
    const db = await seededDb();
    expect(db.__rows.galleryClients).toHaveLength(0);
  });
});

describe("attachGalleryClients — the three membership cases", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  // Case 1: NEVER ATTACHED — a fresh row, no duplicate, and the access email
  // reaches them since the gallery is already client-visible (`proofing`).
  it("inserts a new row for a client never attached before, and emails them", async () => {
    const { attachGalleryClients } = await import("./actions");
    const db = await seededDb();

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result.status).toBe("attached");
    const membership = db.__rows.galleryClients.find((r) => r.userId === CLIENT_A);
    expect(membership).toMatchObject({ galleryId: GALLERY_ID, userId: CLIENT_A, removedAt: null });
    expect(signInMock).toHaveBeenCalledWith("gallery-access", {
      email: CLIENT_A_EMAIL,
      redirect: false,
      redirectTo: "/galleries/abc123",
    });
  });

  // Case 2: ATTACHED AND ACTIVE — a no-op at the database level: still
  // exactly ONE row, never a duplicate, never an error.
  it("is a no-op (no duplicate row, no error) for a client already active", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_A,
      removedAt: null,
      createdAt: new Date("2026-07-02"),
    });
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result.status).toBe("attached");
    const memberships = db.__rows.galleryClients.filter((r) => r.userId === CLIENT_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ removedAt: null });
  });

  // Case 3: ATTACHED AND REMOVED — the SAME row is UPDATEd (removedAt
  // cleared), never a second INSERT (which the composite PK could not allow
  // anyway), and they are treated as newly given access again.
  it("clears removedAt on an existing REMOVED row instead of inserting a second one", async () => {
    const db = await seededDb();
    const removedAt = new Date("2026-07-15T10:00:00.000Z");
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_A,
      removedAt,
      createdAt: new Date("2026-07-02"),
    });
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result.status).toBe("attached");
    const memberships = db.__rows.galleryClients.filter((r) => r.userId === CLIENT_A);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.removedAt).toBeNull();
    // Re-attached — they get a fresh access email, the same as someone never
    // attached before (the ticket's own "treat them as newly attached").
    expect(signInMock).toHaveBeenCalledWith(
      "gallery-access",
      expect.objectContaining({ email: CLIENT_A_EMAIL }),
    );
  });

  it("dedupes a client id posted twice, writing only ONE membership row", async () => {
    const { attachGalleryClients } = await import("./actions");
    const db = await seededDb();

    await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A, CLIENT_A] }),
    );

    const memberships = db.__rows.galleryClients.filter((r) => r.userId === CLIENT_A);
    expect(memberships).toHaveLength(1);
  });

  // The INSERT (never-attached ids) and the UPDATE (clearing `removedAt` on
  // previously-removed ids) are two statements, wrapped in ONE transaction —
  // see actions.ts's own comment for why one admin action must not
  // half-apply. Without the transaction, CLIENT_B below would stay attached
  // while CLIENT_A stayed removed, and nobody would be told.
  //
  // WHY THERE ARE TWO OF THESE, ONE PER STATEMENT. A single fault only
  // discriminates when it hits the statement that runs SECOND — the first
  // one has already written something for a missing ROLLBACK to leave
  // behind. Fail the FIRST statement instead and there is nothing committed
  // yet, so the assertions hold with or without `db.transaction`. A reviewer
  // proved that: with only the failing-UPDATE case below, deleting
  // `db.transaction` from the action AND swapping the two statements so the
  // UPDATE runs first left the whole file at 20/20 green. Production code
  // inserts first today, so it is the UPDATE case that carries the proof
  // right now — the INSERT case is what keeps that from being an accident of
  // statement order the day someone reorders them.
  it("attaches NOTHING when the UPDATE half of the pair fails — both statements are one transaction", async () => {
    const db = await seededDb();
    // CLIENT_A is previously REMOVED (drives the UPDATE), CLIENT_B has never
    // been attached (drives the INSERT) — this request needs both halves.
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_A,
      removedAt: new Date("2026-07-15T10:00:00.000Z"),
      createdAt: new Date("2026-07-02"),
    });
    db.__faults.failNextUpdate = true;
    const { attachGalleryClients } = await import("./actions");

    await expect(
      attachGalleryClients(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A, CLIENT_B] }),
      ),
    ).rejects.toThrow("simulated failure clearing removed_at");

    // The INSERT ran first and DID write CLIENT_B's row — the rollback is
    // what takes it back out. Nothing is emailed either: the sends happen
    // after the writes, and the throw never reaches them.
    expect(db.__rows.galleryClients.map((r) => r.userId)).toEqual([CLIENT_A]);
    expect(db.__rows.galleryClients[0]?.removedAt).not.toBeNull();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("attaches NOTHING when the INSERT half of the pair fails — the mirror of the case above", async () => {
    const db = await seededDb();
    // Identical fixture to the test above, so the ONLY difference between
    // the two is which statement is made to fail.
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_A,
      removedAt: new Date("2026-07-15T10:00:00.000Z"),
      createdAt: new Date("2026-07-02"),
    });
    db.__faults.failNextInsert = true;
    const { attachGalleryClients } = await import("./actions");

    await expect(
      attachGalleryClients(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A, CLIENT_B] }),
      ),
    ).rejects.toThrow("simulated failure inserting membership");

    // Same end state, whichever half failed: CLIENT_B never becomes a
    // member, CLIENT_A stays removed, nobody is emailed. With production's
    // current INSERT-then-UPDATE order these hold trivially (the UPDATE
    // never ran); reorder the statements and this becomes the case that
    // needs the ROLLBACK to put `removedAt` back.
    expect(db.__rows.galleryClients.map((r) => r.userId)).toEqual([CLIENT_A]);
    expect(db.__rows.galleryClients[0]?.removedAt).not.toBeNull();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("attaches SEVERAL clients at once, emailing every one of them", async () => {
    const { attachGalleryClients } = await import("./actions");
    const db = await seededDb();

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A, CLIENT_B] }),
    );

    expect(result.status).toBe("attached");
    expect(db.__rows.galleryClients.map((r) => r.userId).sort()).toEqual(
      [CLIENT_A, CLIENT_B].sort(),
    );
    expect(signInMock).toHaveBeenCalledTimes(2);
  });
});

describe("attachGalleryClients — what gets sent, per status", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  // THE TRAP this task exists to close: a `draft` gallery has nothing to
  // send yet (the eventual `publishGallery` handles it) — but the client
  // must still be ATTACHED (authorized) right now, just not emailed yet.
  it("attaches the client but sends NOTHING for a draft gallery", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "draft";
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result.status).toBe("attached");
    expect(signInMock).not.toHaveBeenCalled();
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_A)).toMatchObject({
      removedAt: null,
    });
  });

  it.each(["proofing", "selected", "delivered"])(
    "attaches AND emails the client for a %s gallery (client-visible)",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries[0]!.status = status;
      const { attachGalleryClients } = await import("./actions");

      const result = await attachGalleryClients(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
      );

      expect(result.status).toBe("attached");
      expect(signInMock).toHaveBeenCalledWith(
        "gallery-access",
        expect.objectContaining({ email: CLIENT_A_EMAIL }),
      );
    },
  );

  it("attaches but sends nothing for an archived gallery (no defined client behavior)", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "archived";
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result.status).toBe("attached");
    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("attachGalleryClients — email failure", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("still attaches the client, but reports a distinct result naming the failed address", async () => {
    signInMock.mockRejectedValue(new AuthError("Resend error (500): boom"));
    const { attachGalleryClients } = await import("./actions");
    const db = await seededDb();

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(result.status).toBe("attached_email_failed");
    expect(result.message).toContain(CLIENT_A_EMAIL);
    // The attach itself is NOT rolled back for an unrelated email failure —
    // same "the state change already committed, notification is
    // best-effort" stance publishGallery/deliverGallery already take.
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_A)).toBeDefined();
  });

  it("names only the specific address that failed when one of several sends fails", async () => {
    signInMock.mockImplementation(async (_provider: string, opts: { email: string }) => {
      if (opts.email === CLIENT_B_EMAIL) throw new AuthError("Resend error (500): boom");
      return "http://localhost/api/auth/verify-request?provider=gallery-access";
    });
    const { attachGalleryClients } = await import("./actions");

    const result = await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A, CLIENT_B] }),
    );

    expect(result.status).toBe("attached_email_failed");
    expect(result.message).toContain(CLIENT_B_EMAIL);
    expect(result.message).not.toContain(CLIENT_A_EMAIL);
  });

  it("re-throws a non-AuthError failure from signIn instead of silently reporting it as a form error", async () => {
    signInMock.mockRejectedValue(new Error("totally unrelated bug"));
    const { attachGalleryClients } = await import("./actions");

    await expect(
      attachGalleryClients(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
      ),
    ).rejects.toThrow("totally unrelated bug");
  });
});

describe("attachGalleryClients revalidation", () => {
  it("revalidates both dashboard views on success", async () => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
    const { attachGalleryClients } = await import("./actions");

    await attachGalleryClients(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientIds: [CLIENT_A] }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });
});
