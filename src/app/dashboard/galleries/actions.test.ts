import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/clients/actions.test.ts: mock only
// `@/auth`'s `auth()`, leave `requireAdmin()`'s own redirect()/forbidden()
// logic real, so a test only passes if this action actually calls
// requireAdmin().
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// `revalidatePath` throws outside a real Next.js request — stub it so the
// action's own logic, not Next's internals, is what this suite exercises.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

// Forcing `generateGallerySlug()` to a fixed value is the only way to make a
// slug COLLISION happen on demand in a test — real entropy (128 bits) makes
// one practically unreachable otherwise. Left un-mocked (real randomness) for
// every test except the one that specifically needs a forced collision.
const generateGallerySlugMock = vi.fn();
vi.mock("@/lib/slug", async () => {
  const actual = await vi.importActual<typeof import("@/lib/slug")>("@/lib/slug");
  return {
    ...actual,
    generateGallerySlug: () => generateGallerySlugMock(),
  };
});

// A minimal, genuinely-behaving double for `@/lib/db` — not a mock that
// returns a fixed response regardless of input. `insert(galleries).values()`
// really enforces the same constraints Postgres does (a FK to a client that
// doesn't exist, a duplicate public_slug) by throwing the SAME shape
// drizzle-orm 0.45 actually delivers in production: a `DrizzleQueryError`
// whose `.cause` is the real `postgres.PostgresError` (both imported for
// real, not faked) with the real SQLSTATE — same pattern as
// src/app/dashboard/clients/actions.test.ts. `select().from(packages)
// .where().limit()` really filters by the column/value encoded in the
// `eq()` condition it's given (duck-typed off drizzle's SQL chunks, verified
// against the real shape before writing this).
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
  const { packages, galleries } = await import("@/lib/db/schema");

  const packageRows: Row[] = [];
  const userRows: Row[] = [];
  const galleryRows: Row[] = [];

  function throwWrapped(message: string, code: string): never {
    const pgError = Object.assign(new PostgresError(message), { code });
    throw new DrizzleQueryError("insert into galleries ...", [], pgError);
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => ({
            limit: async (n: number) => {
              const rows = table === packages ? packageRows : [];
              const { column, value } = eqColumnAndValue(condition);
              if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
              return rows.filter((r) => r[column] === value).slice(0, n);
            },
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (row: Row) => {
          if (table !== galleries) throw new Error("this fake only supports inserting galleries");
          if (!userRows.some((u) => u.id === row.clientId)) {
            throwWrapped(
              'insert or update on table "galleries" violates foreign key constraint "galleries_client_id_users_id_fk"',
              "23503",
            );
          }
          if (galleryRows.some((g) => g.publicSlug === row.publicSlug)) {
            throwWrapped(
              'duplicate key value violates unique constraint "galleries_public_slug_idx"',
              "23505",
            );
          }
          const stored: Row = { id: crypto.randomUUID(), createdAt: new Date(), ...row };
          galleryRows.push(stored);
          return [stored];
        },
      }),
      // Only what src/lib/galleries.ts's getGalleriesWithDetails() needs:
      // real joins against the SAME userRows/packageRows arrays `insert`
      // above reads/mutates, so a test that mutates a package row after
      // creating a gallery is read back through a genuinely live join, not a
      // second, disconnected fixture.
      query: {
        galleries: {
          findMany: async () =>
            [...galleryRows]
              .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
              .map((g) => ({
                ...g,
                client: userRows.find((u) => u.id === g.clientId),
                package: packageRows.find((p) => p.id === g.packageId),
                assets: [],
              })),
        },
      },
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: { packages: packageRows, users: userRows, galleries: galleryRows },
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

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { packages: Row[]; users: Row[]; galleries: Row[] } };
  };
  return db;
}

const ESTANDAR_PACKAGE: Row = {
  id: 1,
  name: "Estándar",
  priceCop: 100_000,
  includedPhotos: 13,
  extraPhotoPriceCop: 5_000,
  durationLabel: "1.5–2 h",
  active: true,
  sortOrder: 1,
};

const RETIRED_PACKAGE: Row = {
  id: 2,
  name: "Básico (viejo)",
  priceCop: 50_000,
  includedPhotos: 5,
  extraPhotoPriceCop: 4_000,
  durationLabel: "1 h",
  active: false,
  sortOrder: 2,
};

const CLIENT_ROW: Row = { id: "client-1", name: "Ana Pérez", email: "ana@example.com" };

let slugCounter = 0;

beforeEach(async () => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  generateGallerySlugMock.mockReset();
  slugCounter = 0;
  generateGallerySlugMock.mockImplementation(() => `slug-${++slugCounter}`);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.packages.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleries.length = 0;
  db.__rows.packages.push({ ...ESTANDAR_PACKAGE }, { ...RETIRED_PACKAGE });
  db.__rows.users.push({ ...CLIENT_ROW });
});

describe("createGallery authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without inserting anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { createGallery } = await import("./actions");

    await expect(
      createGallery(
        { status: "idle" },
        formDataWith({
          clientId: "client-1",
          packageId: "1",
          title: "Boda",
          sessionDate: "2026-08-01",
        }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const db = await seededDb();
    expect(db.__rows.galleries).toHaveLength(0);
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { createGallery } = await import("./actions");

    await expect(
      createGallery(
        { status: "idle" },
        formDataWith({
          clientId: "client-1",
          packageId: "1",
          title: "Boda",
          sessionDate: "2026-08-01",
        }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
  });
});

describe("createGallery validation", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a missing client", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({ packageId: "1", title: "Boda", sessionDate: "2026-08-01" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects a non-numeric package id", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "not-a-number",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects an empty title", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "1",
        title: "  ",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });

  it("rejects a malformed session date", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "1",
        title: "Boda",
        sessionDate: "08/01/2026",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });
});

describe("createGallery package resolution", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("rejects a package id that does not exist", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "999",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Elegí un paquete válido.");
  });

  // Acceptance criterion: only active packages appear in the picker — and a
  // crafted request posting a retired package's id directly must ALSO be
  // refused, not just filtered out of the <select> client-side.
  it("rejects a retired (inactive) package even when its id is posted directly", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "2",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Ese paquete ya no está disponible.");
    const db = await seededDb();
    expect(db.__rows.galleries).toHaveLength(0);
  });
});

describe("createGallery success + frozen terms", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(adminSession());
  });

  it("creates a gallery, revalidates the list, and returns created", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result).toEqual({ status: "created" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
  });

  it("writes snapshot columns that exactly match the chosen package at creation time", async () => {
    const { createGallery } = await import("./actions");
    const db = await seededDb();

    await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );

    const stored = db.__rows.galleries.find((g) => g.title === "Boda Ana y Beto");
    expect(stored).toMatchObject({
      clientId: "client-1",
      packageId: 1,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });
    // `status` isn't written by this action at all — the DB column default
    // ("draft", schema.ts) is what puts a new gallery there, not this insert.
    expect(stored).not.toHaveProperty("status");
  });

  // THE highest-value test in this slice (per the task): prove the snapshot
  // is frozen, not derived live. This actually MUTATES the live package row
  // after the gallery is created and re-reads the gallery through the real
  // read-side query (getGalleriesWithDetails) — not a stub of either side.
  it("keeps a gallery's displayed terms unmoved after the bound package's price/quota are edited afterward", async () => {
    const { createGallery } = await import("./actions");
    const { getGalleriesWithDetails } = await import("@/lib/galleries");
    const db = await seededDb();

    const created = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "1",
        title: "Boda Ana y Beto",
        sessionDate: "2026-08-01",
      }),
    );
    expect(created.status).toBe("created");

    // A real price/quota increase to the seeded offer, made to the SAME row
    // object the fake db's `select` reads from — genuinely mutated, not a
    // second, disconnected fixture.
    const livePackage = db.__rows.packages.find((p) => p.id === 1)!;
    livePackage.priceCop = 500_000;
    livePackage.includedPhotos = 1;
    livePackage.extraPhotoPriceCop = 999_999;

    // Negative control: prove the mutation actually took effect on the live
    // row, so this test would fail for the right reason if the read-side
    // were (bug) reading the live package instead of the snapshot.
    expect(livePackage.includedPhotos).toBe(1);

    const galleriesList = await getGalleriesWithDetails();
    const gallery = galleriesList.find((g) => g.title === "Boda Ana y Beto");

    expect(gallery).toBeDefined();
    expect(gallery?.includedPhotosSnapshot).toBe(13);
    expect(gallery?.extraPhotoPriceCopSnapshot).toBe(5_000);
  });

  it("rejects a client id that does not exist (foreign key violation), with a friendly message", async () => {
    const { createGallery } = await import("./actions");

    const result = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "does-not-exist",
        packageId: "1",
        title: "Boda",
        sessionDate: "2026-08-01",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Elegí un cliente válido.");
  });

  // Acceptance criterion: two galleries never share a slug. Forces a
  // collision (real entropy makes this practically unreachable otherwise)
  // and proves the DB-level unique constraint actually stops the second
  // insert — the action does not swallow or silently retry past it.
  it("does not let two galleries share a public_slug", async () => {
    generateGallerySlugMock.mockReturnValue("forced-collision");
    const { createGallery } = await import("./actions");
    const db = await seededDb();
    db.__rows.users.push({ id: "client-2", name: "Beto Ruiz", email: "beto@example.com" });

    const first = await createGallery(
      { status: "idle" },
      formDataWith({
        clientId: "client-1",
        packageId: "1",
        title: "Primera",
        sessionDate: "2026-08-01",
      }),
    );
    expect(first.status).toBe("created");

    await expect(
      createGallery(
        { status: "idle" },
        formDataWith({
          clientId: "client-2",
          packageId: "1",
          title: "Segunda",
          sessionDate: "2026-08-02",
        }),
      ),
    ).rejects.toThrow();

    expect(db.__rows.galleries.filter((g) => g.publicSlug === "forced-collision")).toHaveLength(1);
  });
});
