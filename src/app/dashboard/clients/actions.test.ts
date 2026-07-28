import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/page.test.ts: mock only `@/auth`'s
// `auth()`, leave `requireAdmin()`'s own redirect()/forbidden() logic real,
// so a test only passes if this action actually calls requireAdmin().
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// `revalidatePath` throws "Invariant: static generation store missing"
// outside a real Next.js request (verified directly before writing this
// mock) — stub it so the action's own logic, not Next's internals, is what
// this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db`'s `db` — not a mock
// that returns a fixed response regardless of input. `insert().values()`
// really stores rows and, on a duplicate email, throws the SAME shape
// drizzle-orm 0.45's `PgPreparedQuery.queryWithCache` actually delivers in
// production: a `DrizzleQueryError` whose `.cause` is the real
// `postgres.PostgresError` (both imported for real, not faked) with the
// real SQLSTATE ("23505") — NOT a bare `PostgresError`, which drizzle never
// lets escape (verified against real `drizzle()` + this schema before
// writing this; see the review note this fixes). `createClient()`'s catch
// block is exercised against the actual wrapped shape it has to unwrap in
// production, not a shape that only looks similar. `select().from().where()
// .limit()` really filters by the column/value encoded in the `eq()`
// condition it's given (duck-typed off drizzle's SQL chunks — a PgColumn-
// like chunk has `.name` + `.table`, a Param-like chunk has `.value` +
// `.encoder`; verified against the real shape with a throwaway script
// before writing this).
// Task #47's negative-control sentinel — see the `@/lib/db` mock factory
// below for what it triggers. Declared with `const` (not `vi.hoisted`)
// because it is only read INSIDE the (also hoisted) `vi.mock("@/lib/db", ...)`
// factory at call time, never at module-eval time — Vitest only requires
// `vi.hoisted()` for values a hoisted factory needs during its own
// evaluation, not values read later when an inner function actually runs.
const OTHER_SQLSTATE_TRIGGER_EMAIL = "overloaded@example.com";

type Row = Record<string, unknown>;

function eqColumnAndValue(condition: unknown): { column?: string; value?: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  let column: string | undefined;
  let value: unknown;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) column = (chunk as { name: string }).name;
      if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
    }
  }
  return { column, value };
}

vi.mock("@/lib/db", async () => {
  const { PostgresError } = await import("postgres");
  const { DrizzleQueryError } = await import("drizzle-orm");
  const rows: Row[] = [];

  return {
    db: {
      insert: () => ({
        values: async (row: Row) => {
          // Task #47's negative control: a SENTINEL email that simulates a
          // `DrizzleQueryError` wrapping a `PostgresError` with a DIFFERENT
          // SQLSTATE (53300 too_many_connections, not 23505 unique_violation)
          // — a real `PostgresError` either way (see the comment below on
          // why that matters for `instanceof`), so the only thing that can
          // tell the two apart is the `.code` narrowing `isUniqueViolation`
          // carries. This must escape `createClient()` as a rethrow, not be
          // reported as "ya existe un cliente...".
          if (row.email === OTHER_SQLSTATE_TRIGGER_EMAIL) {
            const pgError = Object.assign(new PostgresError("sorry, too many clients already"), {
              code: "53300",
            });
            throw new DrizzleQueryError("insert into users ...", [], pgError);
          }
          if (rows.some((r) => r.email === row.email)) {
            // The public .d.ts only exposes Error's own (message, options)
            // constructor for PostgresError — the object-shaped constructor
            // postgres.js's own internals use (see node_modules/postgres/
            // cjs/src/errors.js) isn't part of the published types. Building
            // the same shape via Object.assign keeps this a real
            // `PostgresError` (so `instanceof`/cause-chain walks in the
            // production code still hold) without fighting the types.
            const pgError = Object.assign(
              new PostgresError('duplicate key value violates unique constraint "users_email_idx"'),
              { code: "23505" },
            );
            // The shape drizzle-orm 0.45 actually throws (see the file
            // header above): the driver's own error demoted to `.cause`,
            // wrapped in a `DrizzleQueryError`. This is what
            // `createClient()` has to survive in production — a bare
            // `PostgresError` here would let the buggy, un-fixed version of
            // the catch block pass too.
            throw new DrizzleQueryError("insert into users ...", [], pgError);
          }
          const stored: Row = { id: crypto.randomUUID(), createdAt: new Date(), ...row };
          rows.push(stored);
          return [stored];
        },
      }),
      select: () => ({
        from: () => ({
          where: (condition: unknown) => ({
            limit: async (n: number) => {
              const { column, value } = eqColumnAndValue(condition);
              if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
              return rows.filter((r) => r[column] === value).slice(0, n);
            },
          }),
        }),
      }),
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: rows,
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

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

describe("createClient authorization", () => {
  // Acceptance-adjacent: this is an admin-only surface, checked here at the
  // data-access path itself (src/lib/auth-guards.ts's whole reason to
  // exist), not only by the page above it.
  it("refuses a signed-in CLIENT with a 403, without inserting anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { createClient } = await import("./actions");

    await expect(
      createClient({ status: "idle" }, formDataWith({ name: "Ana", email: "ana@example.com" })),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { createClient } = await import("./actions");

    await expect(
      createClient({ status: "idle" }, formDataWith({ name: "Ana", email: "ana@example.com" })),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("createClient validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects an empty name", async () => {
    const { createClient } = await import("./actions");

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "  ", email: "ana@example.com" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects an invalid email", async () => {
    const { createClient } = await import("./actions");

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Ana", email: "not-an-email" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });
});

describe("createClient success + normalization", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("creates a client, normalizing the email to lowercase and trimmed", async () => {
    const { createClient } = await import("./actions");
    const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Row[] } };

    const result = await createClient(
      { status: "idle" },
      formDataWith({
        name: "  Ana Pérez  ",
        email: "  Ana@Example.com  ",
        phone: " +57 300 0000 ",
      }),
    );

    expect(result).toEqual({ status: "created" });
    // `rows` is module-scoped inside the `@/lib/db` mock factory and shared
    // across every test in this file (not reset between them) — an earlier
    // describe block may already have inserted rows before this one runs,
    // so find this test's own row by its email instead of assuming it's the
    // first (or only) one, same as the sibling tests below already do.
    const stored = db.__rows.find((r) => r.email === "ana@example.com");
    expect(stored).toMatchObject({
      name: "Ana Pérez",
      email: "ana@example.com",
      phone: "+57 300 0000",
      role: "client",
    });
  });

  it("stores no phone (null, not empty string) when the field is left blank", async () => {
    const { createClient } = await import("./actions");
    const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Row[] } };

    await createClient(
      { status: "idle" },
      formDataWith({ name: "Beto", email: "beto@example.com", phone: "" }),
    );

    const stored = db.__rows.find((r) => r.email === "beto@example.com");
    expect(stored?.phone).toBeNull();
  });

  it("revalidates the clients list after a successful create", async () => {
    const { createClient } = await import("./actions");

    await createClient(
      { status: "idle" },
      formDataWith({ name: "Carla", email: "carla@example.com" }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/clients");
  });

  // Acceptance criterion: nothing in this action can create or promote an
  // admin. There is no `role` field in the schema this action parses, so
  // even a request crafted to include one is discarded — proven by actually
  // asserting on the STORED row's role, not on the absence of a form field.
  it('always stores role "client", even if the request smuggles a role field', async () => {
    const { createClient } = await import("./actions");
    const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Row[] } };

    const data = formDataWith({ name: "Dana", email: "dana@example.com" });
    data.set("role", "admin");
    await createClient({ status: "idle" }, data);

    const stored = db.__rows.find((r) => r.email === "dana@example.com");
    expect(stored?.role).toBe("client");
  });
});

describe("createClient duplicate email", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Acceptance criterion: a duplicate email is rejected clearly, not a 500.
  it("returns a friendly error instead of throwing when the email already exists", async () => {
    const { createClient } = await import("./actions");

    const first = await createClient(
      { status: "idle" },
      formDataWith({ name: "Erika", email: "erika@example.com" }),
    );
    expect(first.status).toBe("created");

    const second = await createClient(
      { status: "idle" },
      formDataWith({ name: "Erika (again)", email: "erika@example.com" }),
    );

    expect(second.status).toBe("error");
    expect(second.message).toBe("Ya existe un cliente con ese correo electrónico.");
  });

  it("catches the duplicate even when case/whitespace differ from the stored address", async () => {
    const { createClient } = await import("./actions");

    await createClient(
      { status: "idle" },
      formDataWith({ name: "Fede", email: "fede@example.com" }),
    );
    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Fede (again)", email: "  Fede@Example.com  " }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ya existe un cliente con ese correo electrónico.");
  });
});

describe("createClient — non-unique-violation errors are not swallowed (task #47)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  // Pins `isUniqueViolation`'s `e.code === UNIQUE_VIOLATION` narrowing: a
  // `DrizzleQueryError` wrapping a REAL `PostgresError` (same `instanceof`
  // shape as the duplicate-email case above) but carrying a DIFFERENT
  // SQLSTATE must rethrow, not be reported as "ya existe un cliente...".
  // Dropping the narrowing to a bare `e instanceof postgres.PostgresError`
  // check — the exact regression task #47 calls out — would make this
  // error resolve to `{ status: "error" }` instead of rejecting, failing
  // this assertion.
  it("rethrows a PostgresError carrying a different SQLSTATE instead of reporting a duplicate", async () => {
    const { createClient } = await import("./actions");

    await expect(
      createClient(
        { status: "idle" },
        formDataWith({ name: "Hugo", email: OTHER_SQLSTATE_TRIGGER_EMAIL }),
      ),
    ).rejects.toMatchObject({ cause: { code: "53300" } });
  });
});

// Acceptance criterion: "A created client can immediately request a magic
// link and get in." src/auth.ts's `signIn` callback decides whether to
// send/accept a magic link by running exactly
// `db.select({ id: users.id }).from(users).where(eq(users.email, address)).limit(1)`
// against the SAME `users` table this action inserts into (see auth.ts
// around the `signIn({ user })` callback). This test proves the seam
// without re-implementing NextAuth: it runs the real createClient() action,
// then re-runs that identical lookup against the fake db double above (which
// filters genuinely by column + value, not a canned response) and asserts
// the row is found — plus a negative control proving the double isn't just
// always truthy.
describe("the seam createClient shares with auth.ts's signIn callback", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("makes a freshly created client immediately findable by the exact lookup the signIn callback runs", async () => {
    const { createClient } = await import("./actions");
    const { db } = (await import("@/lib/db")) as unknown as {
      db: {
        select: (...args: unknown[]) => {
          from: (...args: unknown[]) => {
            where: (...args: unknown[]) => { limit: (n: number) => Promise<Row[]> };
          };
        };
      };
    };

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Gala", email: "  Gala@Example.com  " }),
    );
    expect(result.status).toBe("created");

    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "gala@example.com"))
      .limit(1);
    expect(found).toHaveLength(1);

    // Negative control: the identical lookup for an address nobody created
    // finds nothing — if the double's filtering were broken (e.g. always
    // returning every row), this would wrongly pass too.
    const notFound = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "nobody@example.com"))
      .limit(1);
    expect(notFound).toHaveLength(0);
  });
});
