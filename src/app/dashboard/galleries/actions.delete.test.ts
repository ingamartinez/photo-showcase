import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";

// Task #282 — `deleteGallery`: the destructive slice of epic #278. Runs against
// the strict in-memory db double (it throws on any condition shape it does not
// model) plus a mocked `@/lib/r2`.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: vi.fn().mockResolvedValue(undefined),
}));

const deleteObjectMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
  storedKey: (key: string) => key,
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
}));

vi.mock("@/lib/db", async () => {
  const { assets, galleries, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, galleryClients, assets]);
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assets: fake.__tables.get(assets)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;
type Rows = { galleries: Row[]; galleryClients: Row[]; assets: Row[] };

async function rows(): Promise<Rows> {
  const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Rows } };
  return db.__rows;
}

async function log(): Promise<string[]> {
  const { db } = (await import("@/lib/db")) as unknown as { db: { __log: string[] } };
  return db.__log;
}

const adminSession = (): Session =>
  ({
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  }) as Session;
const clientSession = (): Session =>
  ({
    user: { id: "client-x", role: "client", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  }) as Session;

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_WITH_FINAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_NO_FINAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FINAL_KEY = `galleries/${GALLERY_ID}/finals/${ASSET_WITH_FINAL}.png`;
const PROOF_A = `galleries/${GALLERY_ID}/proofs/${ASSET_WITH_FINAL}.webp`;
const PROOF_B = `galleries/${GALLERY_ID}/proofs/${ASSET_NO_FINAL}.webp`;
const DISPLAY_A = `galleries/${GALLERY_ID}/display/${ASSET_WITH_FINAL}.webp`;

function gallery(id: string, overrides: Row = {}): Row {
  return { id, status: "proofing", publicSlug: `${id.slice(0, 4)}-slug`, ...overrides };
}

function asset(id: string, overrides: Row = {}, galleryId = GALLERY_ID): Row {
  return {
    id,
    galleryId,
    proofKey: `galleries/${galleryId}/proofs/${id}.webp`,
    finalKey: null,
    ...overrides,
  };
}

async function seed() {
  const r = await rows();
  for (const list of Object.values(r)) list.length = 0;
  // One fake db lives for the whole file (module scope), so the call log is
  // cleared alongside the rows — otherwise "no db call happened" assertions
  // see previous tests' entries.
  (await log()).length = 0;
  r.galleries.push(gallery(GALLERY_ID), gallery(OTHER_GALLERY_ID));
  r.galleryClients.push(
    { galleryId: GALLERY_ID, userId: "client-a", removedAt: null },
    { galleryId: OTHER_GALLERY_ID, userId: "client-b", removedAt: null },
  );
  r.assets.push(
    asset(ASSET_WITH_FINAL, { finalKey: FINAL_KEY }),
    asset(ASSET_NO_FINAL),
    asset(OTHER_ASSET, {}, OTHER_GALLERY_ID),
  );
}

function calledKeys(): string[] {
  return deleteObjectMock.mock.calls.map(([key]) => key as string);
}

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  revalidatePathMock.mockReset();
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  await seed();
});

describe("deleteGallery — allowed in every status (owner decision 1)", () => {
  // A status gate creeping back in is the most likely future regression: the
  // archive policy (#42) is the obvious excuse to add one.
  it.each(["draft", "proofing", "selected", "delivered", "archived"])(
    "deletes a %s gallery and reports a clean R2 delete",
    async (status) => {
      authMock.mockResolvedValue(adminSession());
      const r = await rows();
      r.galleries[0]!.status = status;
      const { deleteGallery } = await import("./actions");

      const result = await deleteGallery(GALLERY_ID);

      expect(result).toEqual({ ok: true, r2Failures: 0 });
      expect(r.galleries.some((row) => row.id === GALLERY_ID)).toBe(false);
    },
  );

  it("an ARCHIVED gallery is deleted too — archived is not a status filter", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    r.galleries[0]!.status = "archived";
    const { deleteGallery } = await import("./actions");

    await deleteGallery(GALLERY_ID);

    // The row is gone, not merely moved: this is not a soft archive.
    expect(r.galleries.map((row) => row.id)).toEqual([OTHER_GALLERY_ID]);
  });
});

describe("deleteGallery — the R2 keys it deletes", () => {
  it("deletes proof, STORED final and display for an asset with a final, and only the proof for one without", async () => {
    authMock.mockResolvedValue(adminSession());
    const { deleteGallery } = await import("./actions");

    await deleteGallery(GALLERY_ID);

    // Exactly four, in any order: A's proof, A's stored final (`.png`, proving
    // the row's value is used rather than a rebuilt `.jpg`), A's derived
    // display, and B's proof. Nothing for B's final or display, because B has
    // no final for either to exist beside.
    expect(calledKeys().sort()).toEqual([DISPLAY_A, FINAL_KEY, PROOF_A, PROOF_B].sort());
  });

  it("never touches another gallery's assets", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    const { deleteGallery } = await import("./actions");

    await deleteGallery(GALLERY_ID);

    const otherKeys = calledKeys().filter((key) => key.includes(OTHER_GALLERY_ID));
    expect(otherKeys).toEqual([]);
    expect(r.assets.some((row) => row.id === OTHER_ASSET)).toBe(true);
  });
});

describe("deleteGallery — DB first, R2 second, best-effort", () => {
  it("the gallery row is already gone when every R2 delete is attempted", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    // Evaluated INSIDE the mock: the ordering guarantee is about the state at
    // the moment of each call, not the final state.
    deleteObjectMock.mockImplementation(async () => {
      expect(r.galleries.some((row) => row.id === GALLERY_ID)).toBe(false);
    });
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery(GALLERY_ID);

    expect(result).toEqual({ ok: true, r2Failures: 0 });
    expect(deleteObjectMock).toHaveBeenCalledTimes(4);
  });

  it("tolerates a rejected R2 delete: counts it, keeps going, still reports ok", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    deleteObjectMock.mockImplementation(async (key: string) => {
      if (key === FINAL_KEY) throw new Error("R2 said no");
    });
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery(GALLERY_ID);

    expect(result).toEqual({ ok: true, r2Failures: 1 });
    // Every other key was still attempted — no abort on the first failure.
    expect(calledKeys().sort()).toEqual([DISPLAY_A, FINAL_KEY, PROOF_A, PROOF_B].sort());
    expect(r.galleries.some((row) => row.id === GALLERY_ID)).toBe(false);
  });
});

describe("deleteGallery — refusals", () => {
  it("returns a readable error for a uuid that matches no gallery, touching neither R2 nor revalidation", async () => {
    authMock.mockResolvedValue(adminSession());
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery("33333333-3333-4333-8333-333333333333");

    expect(result).toEqual({ ok: false, message: "La galería no existe." });
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
    expect((await log()).filter((entry) => entry.startsWith("delete:"))).toEqual([]);
  });

  it("rejects a non-uuid before any db call (validation lives in the action)", async () => {
    authMock.mockResolvedValue(adminSession());
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery("not-a-uuid");

    expect(result).toEqual({ ok: false, message: "Galería no válida." });
    expect(await log()).toEqual([]);
  });
});

describe("deleteGallery — authorization comes first", () => {
  it("refuses a signed-in CLIENT with a 403, deleting nothing", async () => {
    authMock.mockResolvedValue(clientSession());
    const r = await rows();
    const { deleteGallery } = await import("./actions");

    await expect(deleteGallery(GALLERY_ID)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });

    expect(r.galleries.some((row) => row.id === GALLERY_ID)).toBe(true);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("redirects to /login with no session at all", async () => {
    authMock.mockResolvedValue(null);
    const r = await rows();
    const { deleteGallery } = await import("./actions");

    await expect(deleteGallery(GALLERY_ID)).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });

    expect(r.galleries.some((row) => row.id === GALLERY_ID)).toBe(true);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("deleteGallery — the reader surfaces it revalidates", () => {
  it("revalidates the list, the detail, the public page and the dashboard home", async () => {
    authMock.mockResolvedValue(adminSession());
    const { deleteGallery } = await import("./actions");

    await deleteGallery(GALLERY_ID);

    expect(revalidatePathMock).toHaveBeenCalledTimes(4);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/galleries");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/1111-slug");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });
});

describe("deleteGallery — the cascades it depends on", () => {
  // The fake db deliberately does not model FKs or cascades (see its header),
  // so the "gallery_clients rows disappear" half of the acceptance criteria is
  // guarded STRUCTURALLY: this fails the day a table references `galleries`
  // with `restrict` (or no action), which is exactly the case a delete would
  // hit in production and no unit test could.
  const DRIZZLE_NAME = Symbol.for("drizzle:Name");

  function drizzleName(table: PgTable): string {
    return (table as unknown as Record<symbol, string>)[DRIZZLE_NAME];
  }

  function tables(): [string, PgTable][] {
    // Built by hand rather than with a type predicate: each table's
    // `PgTableWithColumns<…>` carries its literal name in its config type, so
    // no single predicate signature covers them all.
    const found: [string, PgTable][] = [];
    for (const [exportName, value] of Object.entries(schema)) {
      if (is(value, PgTable)) found.push([exportName, value as PgTable]);
    }
    return found;
  }

  it("only assets and gallery_clients reference galleries, and both cascade", () => {
    const referrers = tables()
      .flatMap(([exportName, table]) =>
        getTableConfig(table)
          .foreignKeys.filter(
            (fk) => drizzleName(fk.reference().foreignTable as PgTable) === "galleries",
          )
          .map((fk) => ({ exportName, onDelete: fk.onDelete })),
      )
      .sort((a, b) => a.exportName.localeCompare(b.exportName));

    expect(referrers).toEqual([
      { exportName: "assets", onDelete: "cascade" },
      { exportName: "galleryClients", onDelete: "cascade" },
    ]);
  });

  it("both asset_picks composites cascade, so picks cannot outlive their asset or membership", () => {
    const picks = getTableConfig(schema.assetPicks as unknown as PgTable).foreignKeys;

    expect(picks.map((fk) => fk.onDelete).sort()).toEqual(["cascade", "cascade"]);
  });

  it("the schema scan itself sees every table — a renamed PgTable import cannot silently shrink it", () => {
    const names = tables().map(([exportName]) => exportName);

    expect(names).toContain("assets");
    expect(names).toContain("galleryClients");
    expect(names).toContain("assetPicks");
  });
});
