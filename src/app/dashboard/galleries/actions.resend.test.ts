import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import type { Session } from "next-auth";
import { galleryAccessResendLimiter } from "@/lib/gallery-access-rate-limiters";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// `@/auth` is mocked wholesale here — BOTH exports this file's transitive
// imports actually need: `auth()` (via requireAdmin()) and `signIn()`
// (called directly by resendGalleryAccessEmail, the SAME provider call every
// other gallery-access send in actions.ts already makes). Same shape as
// actions.attach.test.ts's own mock.
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

// `revalidatePath` is NOT called by this action (it writes nothing to the
// database — see actions.ts's own header comment on this action), but
// `next/cache` is still imported transitively by actions.ts for the
// sibling actions in the same file, so it must still resolve under Vitest.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering via a
// leaf-condition parser understanding `eq()` and `isNull()`, plus a fake
// `innerJoin` that this action's own membership lookup uses (something no
// sibling actions.*.test.ts fake needed yet). Duplicated per this codebase's
// own per-file test-double convention rather than shared — see
// actions.attach.test.ts's identical parser for the version this extends.
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
    if (c.op === "isNull") return row[jsKey] == null;
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

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          // The action's ONE query that joins two tables: `galleryClients`
          // joined to `users` on `users.id = galleryClients.userId`, to read
          // the active member's own email/name in one round trip. A minimal
          // fake — hardcoded to that exact join shape, since this action is
          // the only caller in this file that ever joins at all.
          const joined = {
            innerJoin: (joinTable: unknown, _on: unknown) => ({
              where: (condition: unknown) => {
                const leftRows = rowsFor(table).filter((row) =>
                  matchesRow(row, tableShapeFor(table), condition),
                );
                const rightRows = rowsFor(joinTable);
                const combined = leftRows
                  .map((left) => {
                    const right = rightRows.find(
                      (r) => r.id === (left as { userId?: unknown }).userId,
                    );
                    return right ? { ...right, ...left } : undefined;
                  })
                  .filter((row): row is Row => row !== undefined);
                const project = (row: Row) => {
                  if (!columns) return { ...row };
                  const projected: Row = {};
                  for (const key of Object.keys(columns)) projected[key] = row[key];
                  return projected;
                };
                const projected = combined.map(project);
                const promise = Promise.resolve(projected) as Promise<Row[]> & {
                  limit: (n: number) => Promise<Row[]>;
                };
                promise.limit = async (n: number) => projected.slice(0, n);
                return promise;
              },
            }),
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
          };
          return joined;
        },
      }),
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { galleries: galleryRows, users: userRows, galleryClients: galleryClientRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; users: Row[]; galleryClients: Row[] } };
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
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";
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

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    data.set(key, value);
  }
  return data;
}

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.users.push({ id: CLIENT_A, name: "Ana Pérez", email: CLIENT_A_EMAIL });
  db.__rows.users.push({ id: CLIENT_B, name: "Beto Ruiz", email: CLIENT_B_EMAIL });
  db.__rows.galleryClients.push({
    galleryId: GALLERY_ID,
    userId: CLIENT_A,
    removedAt: null,
    createdAt: new Date("2026-07-02"),
  });

  // THE THROTTLE TEST is the AC most likely to be faked, and the task body
  // says so explicitly. This is the REAL, module-scope singleton limiter —
  // never `vi.mock`ed — so every test gets its own clean budget. Without
  // this `reset()`, every test in this file would silently share ONE budget
  // with every test that ran before it (see rate-limit.ts's own `reset()`
  // doc comment and login-rate-limiters.ts's header for the same warning).
  galleryAccessResendLimiter.reset();
});

describe("resendGalleryAccessEmail authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without emailing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { resendGalleryAccessEmail } = await import("./actions");

    await expect(
      resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(signInMock).not.toHaveBeenCalled();
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { resendGalleryAccessEmail } = await import("./actions");

    await expect(
      resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });

    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("resendGalleryAccessEmail validation and guards", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  it("rejects a request missing clientId", async () => {
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a gallery id that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
    expect(signInMock).not.toHaveBeenCalled();
  });

  // Trap A from the DECIDED record: a `draft` gallery has nothing a client
  // could view yet — a resend must never mail a working magic link for one,
  // regardless of the client's own membership state.
  it("refuses a draft gallery without ever calling signIn", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "draft";
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("refuses an archived gallery without ever calling signIn", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "archived";
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("refuses a client who is not an active member of this gallery (never attached)", async () => {
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_B }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Ese cliente ya no está activo en esta galería.",
    });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("refuses a client who was attached and then removed", async () => {
    const db = await seededDb();
    db.__rows.galleryClients[0]!.removedAt = new Date("2026-07-15T10:00:00.000Z");
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Ese cliente ya no está activo en esta galería.",
    });
    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("resendGalleryAccessEmail success", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  it.each(["proofing", "selected", "delivered"])(
    "resends and names the address for a %s gallery",
    async (status) => {
      const db = await seededDb();
      db.__rows.galleries[0]!.status = status;
      const { resendGalleryAccessEmail } = await import("./actions");

      const result = await resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      );

      expect(result.status).toBe("resent");
      expect(result.message).toContain(CLIENT_A_EMAIL);
      expect(signInMock).toHaveBeenCalledWith("gallery-access", {
        email: CLIENT_A_EMAIL,
        redirect: false,
        redirectTo: "/galleries/abc123",
      });
    },
  );

  // Every magic link is single-use (publishGallery's own header comment,
  // referenced by this task's DECIDED record) — a repeated resend must
  // succeed again, not be treated as already-done.
  it("succeeds on a REPEATED resend to the same client", async () => {
    const { resendGalleryAccessEmail } = await import("./actions");

    const first = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );
    const second = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(first.status).toBe("resent");
    expect(second.status).toBe("resent");
    expect(signInMock).toHaveBeenCalledTimes(2);
  });
});

describe("resendGalleryAccessEmail send failure", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("reports resend_email_failed, naming the address, on an AuthError", async () => {
    signInMock.mockRejectedValue(new AuthError("Resend error (500): boom"));
    const { resendGalleryAccessEmail } = await import("./actions");

    const result = await resendGalleryAccessEmail(
      { status: "idle" },
      formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
    );

    expect(result.status).toBe("resend_email_failed");
    expect(result.message).toContain(CLIENT_A_EMAIL);
  });

  it("re-throws a non-AuthError failure from signIn instead of reporting it as a form error", async () => {
    signInMock.mockRejectedValue(new Error("totally unrelated bug"));
    const { resendGalleryAccessEmail } = await import("./actions");

    await expect(
      resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      ),
    ).rejects.toThrow("totally unrelated bug");
  });
});

// THE THROTTLE — exercised against the REAL `galleryAccessResendLimiter`
// (never `vi.mock`ed; imported directly at the top of this file), reset in
// the top-level `beforeEach` above. A test that mocked the limiter and
// asserted the action honours the mock would prove wiring, not throttling.
describe("resendGalleryAccessEmail throttle (task #101's own DECIDED record)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
    signInMock.mockResolvedValue(
      "http://localhost/api/auth/verify-request?provider=gallery-access",
    );
  });

  it("allows 3 resends in the window and refuses the 4th, without calling signIn a 4th time", async () => {
    const { resendGalleryAccessEmail } = await import("./actions");
    const send = () =>
      resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      );

    const first = await send();
    const second = await send();
    const third = await send();
    const fourth = await send();

    expect(first.status).toBe("resent");
    expect(second.status).toBe("resent");
    expect(third.status).toBe("resent");
    expect(fourth.status).toBe("throttled");
    expect(signInMock).toHaveBeenCalledTimes(3);
  });

  // The bucket key is (galleryId, CLIENT id) — see
  // gallery-access-rate-limiters.ts's own header comment for why. Resending
  // to client A three times must not spend client B's own, separate budget
  // on the SAME gallery.
  it("keeps a separate throttle budget per CLIENT on the same gallery", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: CLIENT_B,
      removedAt: null,
      createdAt: new Date("2026-07-02"),
    });
    const { resendGalleryAccessEmail } = await import("./actions");
    const sendTo = (clientId: string) =>
      resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId }),
      );

    await sendTo(CLIENT_A);
    await sendTo(CLIENT_A);
    await sendTo(CLIENT_A);
    const clientAFourth = await sendTo(CLIENT_A);
    // CLIENT_A is now throttled; CLIENT_B, on the SAME gallery, is not.
    const clientBFirst = await sendTo(CLIENT_B);

    expect(clientAFourth.status).toBe("throttled");
    expect(clientBFirst.status).toBe("resent");
  });

  // Same bucket key axis, the other half: the same client on a DIFFERENT
  // gallery must not share CLIENT_A's budget on GALLERY_ID either.
  it("keeps a separate throttle budget per GALLERY for the same client", async () => {
    const db = await seededDb();
    db.__rows.galleries.push(
      galleryRow({ id: OTHER_GALLERY_ID, publicSlug: "xyz789", status: "proofing" }),
    );
    db.__rows.galleryClients.push({
      galleryId: OTHER_GALLERY_ID,
      userId: CLIENT_A,
      removedAt: null,
      createdAt: new Date("2026-07-02"),
    });
    const { resendGalleryAccessEmail } = await import("./actions");
    const sendFor = (galleryId: string) =>
      resendGalleryAccessEmail({ status: "idle" }, formDataWith({ galleryId, clientId: CLIENT_A }));

    await sendFor(GALLERY_ID);
    await sendFor(GALLERY_ID);
    await sendFor(GALLERY_ID);
    const sameGalleryFourth = await sendFor(GALLERY_ID);
    const otherGalleryFirst = await sendFor(OTHER_GALLERY_ID);

    expect(sameGalleryFourth.status).toBe("throttled");
    expect(otherGalleryFirst.status).toBe("resent");
  });

  // Ordering proof: the visibility check (draft/archived refusal) runs
  // BEFORE the throttle, so a refused draft attempt must not spend any of
  // the client's throttle budget — a legitimate resend later in the same
  // window must still have its full 3 available.
  it("does not spend throttle budget on a draft-refused attempt", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "draft";
    const { resendGalleryAccessEmail } = await import("./actions");
    const send = () =>
      resendGalleryAccessEmail(
        { status: "idle" },
        formDataWith({ galleryId: GALLERY_ID, clientId: CLIENT_A }),
      );

    // Three refused draft attempts — if these consumed throttle budget, the
    // legitimate resend below (after the gallery is published) would be the
    // 4th call and get throttled instead of sent.
    await send();
    await send();
    await send();
    expect(signInMock).not.toHaveBeenCalled();

    db.__rows.galleries[0]!.status = "proofing";
    const result = await send();

    expect(result.status).toBe("resent");
    expect(signInMock).toHaveBeenCalledTimes(1);
  });
});
