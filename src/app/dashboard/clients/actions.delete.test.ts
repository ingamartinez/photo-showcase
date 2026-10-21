// Task #280 — `deleteClient`, the delete half of the clients CRUD pair.
//
// A SEPARATE file from ./actions.test.ts on purpose: `vi.mock` is per file, and
// that suite installs a row-filtering insert double for `createClient` (it has
// to, to exercise the duplicate-email 23505 path genuinely). `deleteClient`
// needs the scripted `createRecordingDb` instead, so it can assert on the SQL of
// each WHERE clause — which is the whole point of the guards it carries. Two
// incompatible `@/lib/db` doubles cannot share one module mock. Same precedent
// as `galleries/actions.remove.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { assetPicks, flashGalleryClients, galleryClients, users } from "@/lib/db/schema";
import { createRecordingDb } from "@/lib/test/recording-db";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as the flash suite: mock only `@/auth`'s `auth()`, leave
// `requireAdmin()`'s own redirect()/forbidden() logic real, so these tests only
// pass if the action actually calls it.
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// `vi.mock` is hoisted, so the scripted db lives on a holder the factory reads.
let current = createRecordingDb();
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (current.db as Record<string | symbol, unknown>)[prop] }),
}));

const CLIENT_ID = "8a3d2f11-0f6e-4c8f-9f5e-1d2c3b4a5e6f";

const admin = {
  user: { id: "admin-1", role: "admin", email: "a@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;
const clientSession = {
  user: { id: "client-x", role: "client", email: "c@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;

beforeEach(() => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  current = createRecordingDb();
});

/** The four reads `deleteClient` performs, in order: the guarded existence+role
 * select, then the two ACTIVE membership counts, then the distinct-gallery pick
 * count. Every case below overrides only the ones its guard looks at. */
function scriptedReads({
  client = [{ id: CLIENT_ID }] as unknown[],
  galleries = [{ value: 0 }] as unknown[],
  flash = [{ value: 0 }] as unknown[],
  picked = [{ value: 0 }] as unknown[],
} = {}) {
  return { select: [client, galleries, flash, picked] };
}

describe("deleteClient — auth first", () => {
  it("refuses a signed-in CLIENT with a 403 and issues no query", async () => {
    authMock.mockResolvedValue(clientSession);
    const { deleteClient } = await import("./actions");

    await expect(deleteClient(CLIENT_ID)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    expect(current.calls).toHaveLength(0);
  });

  it("redirects to /login with no session and issues no query", async () => {
    authMock.mockResolvedValue(null);
    const { deleteClient } = await import("./actions");

    await expect(deleteClient(CLIENT_ID)).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(current.calls).toHaveLength(0);
  });
});

describe("deleteClient — the id is validated in the action", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  // The 42 case is the one that matters: `z.uuid()` would ALSO have rejected it,
  // which is why the assertion is "no query ran", not "a string was refused".
  // A public POST endpoint gets whatever the caller serialized.
  it.each([
    ["an empty string", ""],
    ["a number", 42],
    ["null", null],
  ])("refuses %s without touching the database", async (_label, value) => {
    const { deleteClient } = await import("./actions");

    const result = await deleteClient(value);

    expect(result).toEqual({ ok: false, message: "Cliente inválido." });
    expect(current.calls).toHaveLength(0);
  });
});

describe("deleteClient — guard 1: only a role='client' row is deletable", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  // Acceptance criterion: "Un id de admin, o inexistente, no se borra." The
  // guard lives in SQL, so an admin id posted by hand matches no row — this
  // test proves the clause is there AND that its params are the pair, not just
  // the id, which is what a `where(eq(users.id, id))` regression would leave.
  it("reports an admin or nonexistent id as missing, with zero writes", async () => {
    current = createRecordingDb(scriptedReads({ client: [] }));
    const { deleteClient } = await import("./actions");

    expect(await deleteClient(CLIENT_ID)).toEqual({
      ok: false,
      message: "Ese cliente no existe.",
    });

    const [guard] = current.ofOp("select");
    expect(guard!.table).toBe(users);
    expect(guard!.where!.sql).toContain('"users"."role" = $2');
    expect(guard!.where!.params).toEqual([CLIENT_ID, "client"]);

    expect(current.ofOp("delete")).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("deleteClient — guard 2: active memberships block, and the message counts them", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("blocks with the gallery count and writes nothing", async () => {
    current = createRecordingDb(scriptedReads({ galleries: [{ value: 2 }] }));
    const { deleteClient } = await import("./actions");

    const result = await deleteClient(CLIENT_ID);

    expect(result).toEqual({
      ok: false,
      message:
        "No se puede eliminar: tiene 2 galerías activas. Primero quítale el acceso desde cada una.",
    });
    expect(current.ofOp("delete")).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // A flash membership alone blocks, and the copy says "flash". The list's
  // "Galerías" column counts only `gallery_clients`, so a message that said
  // "1 galería" here would contradict the row it appears in.
  it("blocks on a flash membership too, and names it as flash", async () => {
    current = createRecordingDb(scriptedReads({ flash: [{ value: 1 }] }));
    const { deleteClient } = await import("./actions");

    const result = await deleteClient(CLIENT_ID);

    expect(result).toEqual({
      ok: false,
      message:
        "No se puede eliminar: tiene 1 galería flash activa. Primero quítale el acceso desde cada una.",
    });
    expect(current.ofOp("delete")).toHaveLength(0);
  });

  // The inverse of guard 2's filter. Counting tombstones instead of active
  // memberships would read as option (b) — "refuse when only tombstones remain"
  // — which the approved plan rejected, and it would make delete unreachable
  // for almost every real client.
  it("counts ACTIVE memberships in both tables, not tombstones", async () => {
    current = createRecordingDb(scriptedReads());
    const { deleteClient } = await import("./actions");

    await deleteClient(CLIENT_ID);

    const [guard, galleries, flash] = current.ofOp("select");
    expect(galleries!.table).toBe(galleryClients);
    expect(galleries!.where!.sql).toContain('"gallery_clients"."removed_at" is null');
    expect(galleries!.where!.params).toEqual([CLIENT_ID]);
    expect(flash!.table).toBe(flashGalleryClients);
    expect(flash!.where!.sql).toContain('"flash_gallery_clients"."removed_at" is null');
    expect(flash!.where!.params).toEqual([CLIENT_ID]);
    expect(guard!.table).toBe(users);
  });
});

describe("deleteClient — guard 3: submitted picks hanging off a tombstone block", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  // The narrowing the approved plan adds to the task body (§0, rule 3).
  // `asset_picks_membership_fk` cascades, so purging the tombstone of a client
  // who still holds submitted picks would delete the photographer's own work
  // in silence — the cascade owner decision 2 forbids.
  it("blocks instead of cascading the picks away, and writes nothing", async () => {
    current = createRecordingDb(scriptedReads({ picked: [{ value: 1 }] }));
    const { deleteClient } = await import("./actions");

    const result = await deleteClient(CLIENT_ID);

    expect(result).toEqual({
      ok: false,
      message:
        "No se puede eliminar: conserva fotos pedidas en 1 galería de las que ya se le quitó el acceso. Eliminarlo borraría esos pedidos.",
    });
    expect(current.ofOp("delete")).toHaveLength(0);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // `countDistinct(gallery_id)` vs `count()` is not observable through
  // recording-db — it records the WHERE clause, not the projection — so this
  // only proves the count is scoped to this client. The "galleries, not picks"
  // unit lives in the copy helper and is asserted there (format.test.ts).
  it("scopes the pick count to this client's own rows", async () => {
    current = createRecordingDb(scriptedReads());
    const { deleteClient } = await import("./actions");

    await deleteClient(CLIENT_ID);

    const picks = current.ofOp("select")[3];
    expect(picks!.table).toBe(assetPicks);
    expect(picks!.where!.params).toEqual([CLIENT_ID]);
    expect(picks!.where!.sql).toContain('"asset_picks"."user_id"');
  });
});

describe("deleteClient — the happy path: one transaction, tombstones first, user last", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("purges REMOVED memberships in both tables and then deletes the client", async () => {
    current = createRecordingDb({
      ...scriptedReads(),
      delete: [[], [], [{ id: CLIENT_ID }]],
    });
    const { deleteClient } = await import("./actions");

    expect(await deleteClient(CLIENT_ID)).toEqual({ ok: true });

    const [galleries, flash, user] = current.ofOp("delete");
    // The purge is tombstone-only. Without `removed_at is not null` this
    // statement would reach an active membership and break the FK guarantee
    // guard 2 exists to give.
    expect(galleries!.table).toBe(galleryClients);
    expect(galleries!.where!.sql).toContain('"gallery_clients"."removed_at" is not null');
    expect(galleries!.where!.params).toEqual([CLIENT_ID]);
    expect(flash!.table).toBe(flashGalleryClients);
    expect(flash!.where!.sql).toContain('"flash_gallery_clients"."removed_at" is not null');
    expect(flash!.where!.params).toEqual([CLIENT_ID]);
    // The user delete repeats the role clause instead of trusting guard 1.
    expect(user!.table).toBe(users);
    expect(user!.where!.sql).toContain('"users"."role" = $2');
    expect(user!.where!.params).toEqual([CLIENT_ID, "client"]);

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/clients");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("runs every read and write inside ONE transaction", async () => {
    current = createRecordingDb({
      ...scriptedReads(),
      delete: [[], [], [{ id: CLIENT_ID }]],
    });
    // Recording-db's `transaction` runs its callback against the same object, so
    // a counter is enough to prove the call went through it: `begin` = the
    // recorded-call count before, `end` = after. If any statement ran outside,
    // the count inside would be lower than the total.
    let insideCalls = 0;
    const realTransaction = current.db.transaction;
    current.db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = current.calls.length;
      const result = await realTransaction(fn);
      insideCalls += current.calls.length - before;
      return result;
    };
    const { deleteClient } = await import("./actions");

    expect(await deleteClient(CLIENT_ID)).toEqual({ ok: true });

    expect(insideCalls).toBe(current.calls.length);
    expect(insideCalls).toBe(7); // 4 reads + 3 writes
  });

  it("reports a concurrent delete as 'no existe' instead of a success", async () => {
    // Guard 1 matched, but W3's `returning` came back empty: the row vanished
    // in between. Nothing that matters was purged (guard 2 proved no active
    // membership), so the honest answer is the same one guard 1 gives.
    current = createRecordingDb({ ...scriptedReads(), delete: [[], [], []] });
    const { deleteClient } = await import("./actions");

    expect(await deleteClient(CLIENT_ID)).toEqual({
      ok: false,
      message: "Ese cliente no existe.",
    });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("deleteClient — the 23503 race, and what is NOT swallowed", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  /** Makes the `users` delete throw the shape drizzle really delivers: a
   * `DrizzleQueryError` whose `.cause` is a real `postgres.PostgresError` with
   * the given SQLSTATE — not a bare PostgresError, which drizzle never lets
   * escape (same construction the flash suite uses at :256-262). */
  async function throwOnUserDelete(code: string) {
    const { DrizzleQueryError } = await import("drizzle-orm");
    const { PostgresError } = await import("postgres");
    const realDelete = current.db.delete;
    current.db.delete = (table: unknown) => {
      if (table === users) {
        const cause = Object.assign(new PostgresError("fk violation"), { code });
        throw new DrizzleQueryError("delete from users", [], cause);
      }
      return realDelete(table);
    };
  }

  it("returns the race copy when a membership was re-attached mid-transaction", async () => {
    current = createRecordingDb(scriptedReads());
    await throwOnUserDelete("23503");
    const { deleteClient } = await import("./actions");

    expect(await deleteClient(CLIENT_ID)).toEqual({
      ok: false,
      message:
        "No se pudo eliminar: el cliente tiene galerías asignadas. Recarga la página para ver el estado actual.",
    });
    // A rolled-back transaction wrote nothing and the list is not stale.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // Negative control: only 23503 means "blocked". Reporting an outage as a
  // blocked delete would hide a real failure behind copy that tells the
  // photographer to do something they cannot do.
  it("rethrows any other SQLSTATE instead of reporting it as blocked", async () => {
    current = createRecordingDb(scriptedReads());
    await throwOnUserDelete("53300");
    const { deleteClient } = await import("./actions");

    await expect(deleteClient(CLIENT_ID)).rejects.toMatchObject({ cause: { code: "53300" } });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
