import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { users } from "@/lib/db/schema";
import type { FakeDb } from "@/test-support/fake-db";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/clients/actions.test.ts: mock only
// `@/auth`'s `auth()`, leave `requireAdmin()`'s own redirect()/forbidden()
// logic real, so a test only passes if this action actually calls it.
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// `revalidatePath` throws outside a real Next.js request — stub it so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// Task #279: a NEW file rather than an addition to actions.test.ts. That
// file's `@/lib/db` double only models `insert` and a single-`eq` select
// (`eqColumnAndValue` cannot read `and(...)`, it throws), while this action is
// an `UPDATE ... WHERE and(eq(id), eq(role)) RETURNING id`. Splitting by
// action is the same move galleries/actions.remove.test.ts already makes.
//
// The shared in-memory double (src/test-support/fake-db.ts) is used as-is —
// extended HERE, in a thin wrapper, never in that file: it already filters
// `and(eq, eq)` for real and supports `update().set().where().returning()`.
// The wrapper adds the one thing the fake deliberately does not model:
// `users_email_idx` on UPDATE.
//
// What it models, and why it is not a blanket mock: Postgres evaluates a
// unique index only for the rows an UPDATE actually writes. So a statement
// that hits ZERO rows (an admin's id, an unknown id) can never raise 23505 —
// it returns `update:0`, and the action must report "El cliente no existe."
// rather than a bogus duplicate. A statement that hits a row while ANOTHER
// row already holds the new email raises 23505, delivered in the same shape
// production sees: a `DrizzleQueryError` whose `.cause` is the real
// `postgres.PostgresError` (both imported for real, not faked), exactly like
// actions.test.ts's insert double.
type Row = Record<string, unknown>;

vi.mock("@/lib/db", async () => {
  const { PostgresError } = await import("postgres");
  const { DrizzleQueryError } = await import("drizzle-orm");
  const { users: usersTable } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");

  const fake = createFakeDb([usersTable]);
  const rows = fake.__tables.get(usersTable)!;
  // Captured BEFORE the override below, so the wrapper can delegate to the
  // real `update` implementation instead of re-implementing it.
  const baseUpdate = fake.update as (table: unknown) => {
    set: (patch: Row) => {
      where: (condition: unknown) => Promise<Row[]> & {
        returning: (columns?: Record<string, unknown>) => Promise<Row[]>;
      };
    };
  };
  // Every patch passed to `.set()`, so a test can prove which COLUMNS this
  // action writes — not just which values ended up in the row.
  const patches: Row[] = [];

  // Same reason as `baseUpdate`: the fake's public types are structural, and
  // this suite only needs the one shape it actually calls.
  const baseSelect = fake.select as (columns: Record<string, unknown>) => {
    from: (table: unknown) => { where: (condition: unknown) => Promise<Row[]> };
  };

  const db = Object.assign(fake, {
    __patches: patches,
    update: (table: unknown) => ({
      set: (patch: Row) => {
        patches.push(patch);
        return {
          where: (condition: unknown) => {
            const run = async (columns?: Record<string, unknown>) => {
              if (table === usersTable && patch.email !== undefined) {
                // The fake's own real filtering — the same `and(eq, eq)` the
                // statement carries — not a hand-rolled row scan.
                const hit = await baseSelect({ id: usersTable.id })
                  .from(usersTable)
                  .where(condition);
                if (hit.length > 0) {
                  const hitIds = new Set(hit.map((row) => row.id));
                  const clash = rows.some(
                    (row) => !hitIds.has(row.id) && row.email === patch.email,
                  );
                  if (clash) {
                    const pgError = Object.assign(
                      new PostgresError(
                        'duplicate key value violates unique constraint "users_email_idx"',
                      ),
                      { code: "23505" },
                    );
                    throw new DrizzleQueryError("update users ...", [], pgError);
                  }
                }
              }
              return baseUpdate(table).set(patch).where(condition).returning(columns);
            };
            const promise = {
              returning: (columns?: Record<string, unknown>) => run(columns),
              then: (
                onfulfilled?: ((rows: Row[]) => unknown) | null,
                onrejected?: ((reason: unknown) => unknown) | null,
              ) => run(undefined).then(onfulfilled, onrejected),
            };
            return promise;
          },
        };
      },
    }),
  });

  return { db };
});

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BETO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// A syntactically valid UUID that no row in the fake carries.
const GHOST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type DbHandle = FakeDb & { __patches: Row[] };

async function fakeState() {
  const { db } = (await import("@/lib/db")) as unknown as { db: DbHandle };
  return {
    rows: db.__tables.get(users)!,
    log: db.__log,
    patches: db.__patches,
  };
}

function adminSession(): Session {
  return {
    user: { id: ADMIN_ID, role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientSession(): Session {
  return {
    user: { id: ANA_ID, role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

/** The three fields the dialog always sends, plus the row selector. */
function updateFormData(fields: {
  userId?: string;
  name?: string;
  email?: string;
  phone?: string;
}) {
  return formDataWith({
    userId: fields.userId ?? ANA_ID,
    name: fields.name ?? "Ana Pérez",
    email: fields.email ?? "ana@example.com",
    phone: fields.phone,
  });
}

function storedRow(rows: Row[], id: string): Row | undefined {
  return rows.find((row) => row.id === id);
}

// Seed rows directly on the double's backing store (the same escape hatch
// galleries/actions.remove.test.ts uses) instead of going through an insert:
// the fake's insert refuses `users` on purpose, because it cannot enforce
// `users_email_idx`, and that refusal is a feature this suite relies on.
beforeEach(async () => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const { rows, log, patches } = await fakeState();
  // Cleared, not shared: unlike actions.test.ts's module-scoped rows, every
  // case here starts from the same three fixtures, so "the other row is
  // unchanged" is a claim about THIS test's initial state.
  rows.length = 0;
  log.length = 0;
  patches.length = 0;

  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  rows.push(
    {
      id: ADMIN_ID,
      name: "Fotógrafa",
      email: "photographer@example.com",
      phone: null,
      emailVerified: null,
      image: null,
      role: "admin",
      createdAt,
    },
    {
      id: ANA_ID,
      name: "Ana Pérez",
      email: "ana@example.com",
      phone: "+57 300 111 1111",
      emailVerified: null,
      image: null,
      role: "client",
      createdAt,
    },
    {
      id: BETO_ID,
      name: "Beto Ruiz",
      email: "beto@example.com",
      phone: null,
      emailVerified: null,
      image: null,
      role: "client",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  );
});

describe("updateClient authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without updating anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { updateClient } = await import("./actions");
    const { rows, log } = await fakeState();

    await expect(
      updateClient({ status: "idle" }, updateFormData({ name: "Cambiada" })),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(log.some((entry) => entry.startsWith("update:"))).toBe(false);
    expect(storedRow(rows, ANA_ID)?.name).toBe("Ana Pérez");
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { updateClient } = await import("./actions");

    await expect(
      updateClient({ status: "idle" }, updateFormData({ name: "Cambiada" })),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("updateClient success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("corrects name, email and phone, and reports the update", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ name: "Ana María Pérez", email: "ana.nueva@example.com", phone: "+57 1" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(storedRow(rows, ANA_ID)).toMatchObject({
      name: "Ana María Pérez",
      email: "ana.nueva@example.com",
      phone: "+57 1",
      role: "client",
    });
    // The OTHER client is untouched — the statement's WHERE is not "all rows".
    expect(storedRow(rows, BETO_ID)?.email).toBe("beto@example.com");
  });

  it("stores the email trimmed and lowercased, the same normalization create uses", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ email: "  Ana.Nueva@Example.COM  " }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(storedRow(rows, ANA_ID)?.email).toBe("ana.nueva@example.com");
  });

  // The NFKC half of the shared chain (#48): fullwidth Latin letters must land
  // on their ASCII compatibility forms, or the address stored here and the
  // address Auth.js looks up after normalizing differ, splitting identity.
  // Without `.normalize("NFKC")` these letters lowercase into fullwidth forms
  // that `z.email()` then rejects — so dropping it turns this into an error
  // and leaves the stored email unchanged.
  it("stores a fullwidth address in its NFKC-normalized ASCII form", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      // A domain the row does not already hold, so the assertion below is
      // about the normalization and not about a no-op write of the old value.
      updateFormData({ email: "ＡＮＡ@ｎｆｋｃ.ｅｘａｍｐｌｅ.com" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(storedRow(rows, ANA_ID)?.email).toBe("ana@nfkc.example.com");
  });

  // Epic decision 3's consequence, proven through the REAL lookup auth.ts's
  // `signIn` callback delegates to: after the edit, a magic link to the new
  // address resolves to this row, and one to the old address resolves to
  // nobody (so the old address cannot mint a second account).
  it("moves the login seam with the new email", async () => {
    const { updateClient } = await import("./actions");
    const { findUserIdByEmail } = await import("@/lib/users");

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ email: "ana.nueva@example.com" }),
    );
    expect(result).toEqual({ status: "updated" });

    await expect(findUserIdByEmail("ana.nueva@example.com")).resolves.toBe(ANA_ID);
    await expect(findUserIdByEmail("ana@example.com")).resolves.toBeUndefined();
  });

  // `phone: ?? null`, never `undefined`: drizzle DROPS `undefined` keys from
  // the SET clause, so an emptied field would silently keep the old number.
  it("clears the phone when the field is submitted blank", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient({ status: "idle" }, updateFormData({ phone: "" }));

    expect(result).toEqual({ status: "updated" });
    expect(storedRow(rows, ANA_ID)?.phone).toBeNull();
  });

  // A self-collision would make every plain save fail: Postgres compares the
  // unique index against OTHER rows, so writing back the row's own address is
  // not a violation.
  it("succeeds when the email is saved unchanged", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ name: "Ana P.", email: "ana@example.com" }),
    );

    expect(result).toEqual({ status: "updated" });
    expect(storedRow(rows, ANA_ID)).toMatchObject({ name: "Ana P.", email: "ana@example.com" });
  });

  // Task #279's trap: the edit must not re-issue the account. Written
  // columns are asserted from the recorded `.set()` patch, so reintroducing
  // `role` (or `createdAt`) fails here even if the value happens to match.
  it("writes only name, email and phone, ignoring a smuggled role field", async () => {
    const { updateClient } = await import("./actions");
    const { rows, patches } = await fakeState();

    const data = updateFormData({ name: "Ana Pérez" });
    data.set("role", "admin");
    data.set("createdAt", "1999-01-01T00:00:00.000Z");
    const result = await updateClient({ status: "idle" }, data);

    expect(result).toEqual({ status: "updated" });
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]).sort()).toEqual(["email", "name", "phone"]);
    expect(storedRow(rows, ANA_ID)?.role).toBe("client");
    expect(storedRow(rows, ANA_ID)?.createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("revalidates every surface that renders a client's identity", async () => {
    const { updateClient } = await import("./actions");

    await updateClient({ status: "idle" }, updateFormData({}));

    expect(revalidatePathMock.mock.calls).toEqual([
      ["/dashboard/clients"],
      ["/dashboard/galleries"],
      ["/dashboard/galleries/[galleryId]", "page"],
      ["/dashboard/flash/[flashId]", "page"],
      ["/galleries"],
      ["/galleries/[publicSlug]", "page"],
    ]);
  });
});

describe("updateClient validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects an emptied name with zod's own message and nothing written", async () => {
    const { updateClient } = await import("./actions");
    const { rows, log } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ name: "   ", email: "ana.nueva@example.com" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ingresa un nombre.");
    // Raw echo, not a trimmed rewrite: see CreateClientState.values.
    expect(result.values).toEqual({ name: "   ", email: "ana.nueva@example.com", phone: "" });
    expect(log.some((entry) => entry.startsWith("update:"))).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(storedRow(rows, ANA_ID)?.email).toBe("ana@example.com");
  });

  it("rejects an invalid email with zod's own message and nothing written", async () => {
    const { updateClient } = await import("./actions");
    const { rows, log } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ name: "Ana Pérez", email: "no-es-un-correo" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ingresa un correo electrónico válido.");
    expect(result.values).toEqual({
      name: "Ana Pérez",
      email: "no-es-un-correo",
      phone: "",
    });
    expect(log.some((entry) => entry.startsWith("update:"))).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect(storedRow(rows, ANA_ID)?.email).toBe("ana@example.com");
  });

  // `z.uuid()` on the hidden selector: a tampered id is rejected before any
  // SQL runs, so it cannot even reach the zero-row branch.
  it("rejects an id that is not a UUID before touching the database", async () => {
    const { updateClient } = await import("./actions");
    const { log } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ userId: "not-a-uuid", name: "Ana Pérez" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Cliente no válido.");
    expect(log.some((entry) => entry.startsWith("update:"))).toBe(false);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("updateClient duplicate email", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("reports the duplicate clearly and preserves what was typed", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({
        name: "Ana Pérez",
        email: "beto@example.com",
        phone: "+57 300 111 1111",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ya existe un cliente con ese correo electrónico.");
    expect(result.values).toEqual({
      name: "Ana Pérez",
      email: "beto@example.com",
      phone: "+57 300 111 1111",
    });
    // Neither row changed — the statement never ran.
    expect(storedRow(rows, ANA_ID)).toMatchObject({
      name: "Ana Pérez",
      email: "ana@example.com",
    });
    expect(storedRow(rows, BETO_ID)?.email).toBe("beto@example.com");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // Normalization happens BEFORE the write, so case and whitespace cannot be
  // used to dodge the index and split the same person into two rows.
  it("catches the duplicate even when case and whitespace differ", async () => {
    const { updateClient } = await import("./actions");
    const { rows } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ email: "  BETO@Example.com " }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ya existe un cliente con ese correo electrónico.");
    // Echoed as typed, not normalized.
    expect(result.values?.email).toBe("  BETO@Example.com ");
    expect(storedRow(rows, ANA_ID)?.email).toBe("ana@example.com");
  });
});

describe("updateClient row selection", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Epic #278's rule: `role = 'client'` rides in the WHERE. Drop it and this
  // test goes green-to-red — the admin row would be edited.
  it("refuses to edit an ADMIN's row and reports it as a missing client", async () => {
    const { updateClient } = await import("./actions");
    const { rows, log } = await fakeState();
    const before = { ...storedRow(rows, ADMIN_ID)! };

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ userId: ADMIN_ID, email: "photographer@example.com" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "El cliente no existe.",
      values: { name: "Ana Pérez", email: "photographer@example.com", phone: "" },
    });
    // The statement ran and matched nothing — not "it never tried".
    expect(log).toContain("update:0");
    expect(storedRow(rows, ADMIN_ID)).toEqual(before);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("reports an unknown id as a missing client instead of a silent success", async () => {
    const { updateClient } = await import("./actions");
    const { log } = await fakeState();

    const result = await updateClient(
      { status: "idle" },
      updateFormData({ userId: GHOST_ID, name: "Nadie" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("El cliente no existe.");
    expect(log).toContain("update:0");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
