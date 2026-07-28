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

vi.mock("@/lib/db", async () => {
  const { assets, galleries, users } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const assetRows: Row[] = [];
  const userRows: Row[] = [];
  let failNextUpdate = false;

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
      update: (table: unknown) => ({
        set: (values: Row) => ({
          where: async (condition: unknown) => {
            if (table !== galleries) throw new Error("fake db: unsupported table in update()");
            if (failNextUpdate) {
              failNextUpdate = false;
              throw new Error("simulated update failure");
            }
            const { column, value } = eqColumnAndValue(condition);
            if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
            const row = galleryRows.find((r) => r[column] === value);
            if (row) Object.assign(row, values);
          },
        }),
      }),
      // Test-only escape hatches, not part of the real `db` shape.
      __rows: { galleries: galleryRows, assets: assetRows, users: userRows },
      __failNextUpdate: () => {
        failNextUpdate = true;
      },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: { galleries: Row[]; assets: Row[]; users: Row[] };
      __failNextUpdate: () => void;
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
    clientId: CLIENT_ID,
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
  db.__rows.galleries.push(galleryRow());
  db.__rows.users.push({ id: CLIENT_ID, name: "Ana Pérez", email: CLIENT_EMAIL });
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
