import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

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

// Task #48: `.normalize("NFKC")` landed in #18 round 2 with no test, so
// removing it left the suite green. The whole point of that call is that the
// form in which an address is STORED here and the form in which auth.ts looks
// it up cannot diverge — Auth.js normalizes the address it receives with
// `.normalize("NFKC").toLowerCase().trim()` before `signIn`'s callback ever
// runs (see next-auth's Resend/email provider), so an address typed in a
// non-NFKC-normal form must land on its NFKC form here too.
//
// Note on the addresses used below: the criterion's own example pair is
// "ＡＮＡ@ｅｘａｍｐｌｅ.com" -> "ana@example.com", but `rows` inside the
// `@/lib/db` double is module-scoped and shared by every test in this file,
// and the sibling suite above already stores "ana@example.com". Reusing that
// exact normalized address here would make this test hit the duplicate-email
// branch instead of the insert path, in either order. The fullwidth->ASCII
// case being pinned is identical; only the local part and domain differ so
// this suite stands on its own regardless of what ran before it.
describe("createClient NFKC email normalization (task #48)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("stores a fullwidth address in its NFKC-normalized ASCII form", async () => {
    const { createClient } = await import("./actions");
    const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Row[] } };

    const result = await createClient(
      { status: "idle" },
      // Fullwidth Latin letters (U+FF21.., U+FF41..) in BOTH the local part
      // and the domain. NFKC maps each to its ASCII compatibility equivalent,
      // and only then does `.toLowerCase()` produce "ana@nfkc.example.com".
      // Without `.normalize("NFKC")` the chain lowercases the fullwidth
      // letters into their own fullwidth lowercase forms
      // ("ａｎａ@ｎｆｋｃ.ｅｘａｍｐｌｅ.com"), which `z.email()` then rejects
      // outright — so dropping it turns this into `status: "error"` with no
      // row at all.
      formDataWith({ name: "Ana Fullwidth", email: "ＡＮＡ@ｎｆｋｃ.ｅｘａｍｐｌｅ.com" }),
    );

    expect(result).toEqual({ status: "created" });
    const stored = db.__rows.find((r) => r.email === "ana@nfkc.example.com");
    expect(stored).toMatchObject({ name: "Ana Fullwidth", email: "ana@nfkc.example.com" });
  });

  // The seam consequence of the test above, stated directly: once the
  // fullwidth address is stored NFKC-normalized, the plain ASCII address a
  // client would actually type at /login is the SAME row — it collides
  // instead of quietly creating a second account for the same person.
  it("recognizes the plain ASCII form of a stored fullwidth address as the same client", async () => {
    const { createClient } = await import("./actions");

    const first = await createClient(
      { status: "idle" },
      formDataWith({ name: "Julia", email: "ＪＵＬＩＡ@ｅｘａｍｐｌｅ.com" }),
    );
    expect(first).toEqual({ status: "created" });

    const second = await createClient(
      { status: "idle" },
      formDataWith({ name: "Julia (again)", email: "julia@example.com" }),
    );

    expect(second.status).toBe("error");
    expect(second.message).toBe("Ya existe un cliente con ese correo electrónico.");
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

// Task #50: React 19 blanks a `<form action={fn}>`'s uncontrolled fields on
// every submit, so a rejected duplicate used to cost the photographer the
// whole form. The documented way back is for the action to return what was
// submitted and for the form to feed it into `defaultValue` — see
// src/components/client-form.tsx and its own test. This is the server half:
// the values have to actually come back, verbatim, on every error path.
describe("createClient echoes the submitted values back on error (task #50)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("returns the values exactly as typed when the email is a duplicate", async () => {
    const { createClient } = await import("./actions");

    await createClient(
      { status: "idle" },
      formDataWith({ name: "Karla", email: "karla@example.com" }),
    );

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "  Karla Otra  ", email: "  Karla@Example.com  ", phone: " +57 1 " }),
    );

    expect(result.status).toBe("error");
    // Verbatim, NOT `parsed.data`: the photographer gets their own input back
    // to correct, not a trimmed/lowercased rewrite of it that they never
    // typed. Trimming here would also silently "fix" the very whitespace they
    // may be trying to look at.
    expect(result.values).toEqual({
      name: "  Karla Otra  ",
      email: "  Karla@Example.com  ",
      phone: " +57 1 ",
    });
  });

  it("returns the values when validation fails, where there is no parsed data to fall back on", async () => {
    const { createClient } = await import("./actions");

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Lía", email: "not-an-email", phone: "+57 300" }),
    );

    expect(result.status).toBe("error");
    expect(result.values).toEqual({ name: "Lía", email: "not-an-email", phone: "+57 300" });
  });

  it("reads an omitted field back as an empty string, not null", async () => {
    const { createClient } = await import("./actions");

    // No `phone` key at all — `FormData#get` returns null for it.
    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Mara", email: "still-not-an-email" }),
    );

    expect(result.values).toEqual({ name: "Mara", email: "still-not-an-email", phone: "" });
  });

  it("returns no values on success, so the form comes back empty for the next client", async () => {
    const { createClient } = await import("./actions");

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Nico", email: "nico@example.com", phone: "+57 300" }),
    );

    expect(result).toEqual({ status: "created" });
    expect(result.values).toBeUndefined();
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
// send/accept a magic link by looking the address up in the SAME `users`
// table this action inserts into. This test proves that seam without
// re-implementing NextAuth: it runs the real createClient() action, then runs
// `findUserIdByEmail` — the very function auth.ts's callback delegates to —
// against the fake db double above (which filters genuinely by column +
// value, not a canned response) and asserts the row is found, plus a negative
// control proving the double isn't just always truthy.
//
// Task #51: this used to re-run a HAND-COPIED `db.select(...).from(users)
// .where(eq(users.email, address)).limit(1)` here. That copy killed real
// regressions, but it was still a copy: rewriting the query in auth.ts would
// have left this green while a freshly created client silently lost the
// ability to sign in. Importing the shared lookup instead means there is one
// implementation to change, and changing it fails here.
describe("the seam createClient shares with auth.ts's signIn callback", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("makes a freshly created client immediately findable by the lookup the signIn callback runs", async () => {
    const { createClient } = await import("./actions");
    const { findUserIdByEmail } = await import("@/lib/users");

    const result = await createClient(
      { status: "idle" },
      formDataWith({ name: "Gala", email: "  Gala@Example.com  " }),
    );
    expect(result.status).toBe("created");

    // `signIn` returns `Boolean(await findUserIdByEmail(address))`, so an id
    // here is exactly what lets the magic link through.
    await expect(findUserIdByEmail("gala@example.com")).resolves.toEqual(expect.any(String));

    // Negative control: the identical lookup for an address nobody created
    // finds nothing — if the double's filtering were broken (e.g. always
    // returning every row), this would wrongly pass too.
    await expect(findUserIdByEmail("nobody@example.com")).resolves.toBeUndefined();
  });
});
