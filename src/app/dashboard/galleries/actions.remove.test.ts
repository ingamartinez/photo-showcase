import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// `removeGalleryClient` lives in the SAME MODULE as `publishGallery`, which
// imports `AuthError` from "next-auth" at the top of the file — mocked
// wholesale, same fix as every sibling actions.*.test.ts in this directory,
// even though this suite never exercises that branch itself.
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
// leaf-condition parser understanding `eq()` and `isNull()`. Duplicated per
// this codebase's own per-file test-double convention, same shape as
// src/lib/gallery-access.test.ts's own version.
type Row = Record<string, unknown>;

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

function conditions(condition: unknown): LeafCondition[] {
  const results = walkConditions(condition);
  if (results.length === 0) {
    throw new Error("conditions: not a supported eq()/isNull()/and(...) condition");
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
    return c.op === "isNull" ? row[jsKey] == null : row[jsKey] === c.value;
  });
}

vi.mock("@/lib/db", async () => {
  const { galleries, galleryClients } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  function rowsFor(table: unknown): Row[] {
    if (table === galleries) return galleryRows;
    if (table === galleryClients) return galleryClientRows;
    throw new Error("fake db: unsupported table");
  }

  function tableShapeFor(table: unknown): Record<string, unknown> {
    if (table === galleries) return galleries as unknown as Record<string, unknown>;
    if (table === galleryClients) return galleryClients as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }

  return {
    db: {
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
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            if (table !== galleryClients) throw new Error("fake db: unsupported table in update()");
            const matches = galleryClientRows.filter((row) =>
              matchesRow(row, galleryClients as unknown as Record<string, unknown>, condition),
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
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { galleries: galleryRows, galleryClients: galleryClientRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; galleryClients: Row[] } };
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
const CLIENT_B = "client-b";

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

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

beforeEach(async () => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.galleryClients.push(
    { galleryId: GALLERY_ID, userId: CLIENT_A, removedAt: null, createdAt: new Date("2026-07-01") },
    { galleryId: GALLERY_ID, userId: CLIENT_B, removedAt: null, createdAt: new Date("2026-07-02") },
  );
});

describe("removeGalleryClient authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { removeGalleryClient } = await import("./actions");

    await expect(
      removeGalleryClient(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const db = await seededDb();
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_A)).toMatchObject({
      removedAt: null,
    });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { removeGalleryClient } = await import("./actions");

    await expect(
      removeGalleryClient(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("removeGalleryClient validation and guards", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { removeGalleryClient } = await import("./actions");

    const result = await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });

  it("refuses a client who is not currently active (never attached / already removed), without writing anything", async () => {
    const { removeGalleryClient } = await import("./actions");
    const db = await seededDb();

    const result = await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: "not-attached" }),
    );

    expect(result.status).toBe("error");
    expect(db.__rows.galleryClients).toHaveLength(2);
  });
});

describe("removeGalleryClient — soft delete", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("sets removedAt instead of deleting the row", async () => {
    const { removeGalleryClient } = await import("./actions");
    const db = await seededDb();
    const before = Date.now();

    const result = await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result).toEqual({ status: "removed" });
    // The row SURVIVES — never deleted.
    expect(db.__rows.galleryClients).toHaveLength(2);
    const removed = db.__rows.galleryClients.find((r) => r.userId === CLIENT_A);
    expect(removed).toBeDefined();
    expect(removed?.removedAt).toBeInstanceOf(Date);
    expect((removed?.removedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    // The OTHER client is untouched.
    const other = db.__rows.galleryClients.find((r) => r.userId === CLIENT_B);
    expect(other?.removedAt).toBeNull();
  });

  it("revalidates both dashboard views on success", async () => {
    const { removeGalleryClient } = await import("./actions");

    await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });
});

describe("removeGalleryClient — the conditional last-active-client invariant", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Task #97's own reversal of part of #94's invariant: a DRAFT gallery may
  // legitimately have zero ACTIVE clients, and this action is one of the two
  // ways to get there. Task #100 added the other — `createGallery` now
  // accepts an empty client list outright, so a draft can be born clientless
  // rather than only stripped down to it. Removing the last one here must
  // succeed either way.
  it("allows removing the LAST active client from a DRAFT gallery", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "draft";
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_A,
      removedAt: null,
      createdAt: new Date("2026-07-01"),
    });
    const { removeGalleryClient } = await import("./actions");

    const result = await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result).toEqual({ status: "removed" });
    expect(db.__rows.galleryClients[0]?.removedAt).toBeInstanceOf(Date);
  });

  // Everything PAST draft still needs at least one active client —
  // `activeClientRuleViolation()` (src/lib/galleries.ts) is what this
  // consults, the SAME function `publishGallery` and `deliverGallery` use
  // since task #100 folded their own copies of the rule into it.
  it.each(["proofing", "selected", "delivered", "archived"])(
    "refuses to remove the LAST active client from a %s gallery",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries[0]!.status = status;
      db.__rows.galleryClients.length = 0;
      db.__rows.galleryClients.push({
        galleryId: GALLERY_ID,
        userId: CLIENT_A,
        removedAt: null,
        createdAt: new Date("2026-07-01"),
      });
      const { removeGalleryClient } = await import("./actions");

      const result = await removeGalleryClient(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      );

      expect(result.status).toBe("error");
      // Never touched — the row must survive exactly as it was.
      expect(db.__rows.galleryClients[0]?.removedAt).toBeNull();
    },
  );

  // The invariant is about the LAST ACTIVE client, not "any removal at
  // all" — removing one of TWO active clients on a non-draft gallery must
  // still succeed.
  it("allows removing one of TWO active clients from a non-draft gallery", async () => {
    const { removeGalleryClient } = await import("./actions");
    const db = await seededDb();

    const result = await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result).toEqual({ status: "removed" });
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_A)?.removedAt).toBeInstanceOf(
      Date,
    );
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_B)?.removedAt).toBeNull();
  });

  // MUTATION-TESTED in BOTH directions. Task #97 proved this against its own
  // inline `activeMemberships.length <= 1 && requiresActiveClient(...)`
  // conjunction; task #100 replaced that with a call to the shared
  // `activeClientRuleViolation()`, so both mutations were RE-RUN against the
  // new shape rather than carried over. Observed, not predicted:
  //
  //   1. Mutating the STATUS argument — `targetStatus: "draft"` as a literal,
  //      simulating "no status ever needs an active client" — made exactly
  //      the four `it.each` cases above (proofing/selected/delivered/
  //      archived) FAIL, each with `expected 'removed' to be 'error'`. This
  //      is the dangerous direction: it would let an admin strip a PUBLISHED
  //      gallery down to zero clients. `10 passed | 4 failed`.
  //
  //   2. Mutating the COUNT argument — `activeClientCount: 0` unconditionally
  //      (dropping the `- 1`, so the refusal fires whatever the real count) —
  //      made a DIFFERENT four fail: "sets removedAt instead of deleting the
  //      row", "revalidates both dashboard views on success", "allows
  //      removing one of TWO active clients from a non-draft gallery", and
  //      "has no code path that reads or writes the assets table at all".
  //      Every one of them removes a client from a gallery that has another,
  //      and every one turned into a wrongful refusal. `10 passed | 4 failed`.
  //
  //      NOTE WHAT MUTATION 2 DOES NOT BREAK, because it is the interesting
  //      half: neither DRAFT test — "allows removing the LAST active client
  //      from a DRAFT gallery" nor THIS one — notices it at all. The rule
  //      short-circuits on `draft` before the count is ever consulted, so a
  //      broken count is invisible on a draft. Those two tests pin the STATUS
  //      half of the rule and cannot pin the count half; mutation 1's four
  //      cases are what cover them. Claiming otherwise is how a mutation note
  //      goes stale.
  //
  // Restoring the real call made all 14 pass again in both directions.
  it("does not refuse removal on a DRAFT gallery even when it is the only client (negative control for the guard above)", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "draft";
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_A,
      removedAt: null,
      createdAt: new Date("2026-07-01"),
    });
    const { removeGalleryClient } = await import("./actions");

    const result = await removeGalleryClient(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result.status).toBe("removed");
  });
});

describe("removeGalleryClient — never touches asset attribution", () => {
  it("has no code path that reads or writes the assets table at all", async () => {
    authMock.mockResolvedValue(adminSession());
    const { removeGalleryClient } = await import("./actions");

    // The fake db's own `rowsFor`/`tableShapeFor` throw on any table other
    // than `galleries`/`galleryClients` — if `removeGalleryClient` ever
    // touched `assets` (e.g. to clear `selectedBy`), this call would throw
    // instead of resolving cleanly.
    await expect(
      removeGalleryClient(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      ),
    ).resolves.toEqual({ status: "removed" });
  });
});
