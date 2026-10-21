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
// Both spellings of the same key space are recorded so a suite can assert WHICH
// gallery id the derived display key was built from.
const displayKeyArgs: string[] = [];
vi.mock("@/lib/r2", () => ({
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
  storedKey: (key: string) => key,
  displayKey: (galleryId: string, assetId: string) => {
    displayKeyArgs.push(galleryId);
    return `galleries/${galleryId}/display/${assetId}.webp`;
  },
}));

vi.mock("@/lib/db", async () => {
  const { assets, galleries, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, galleryClients, assets]);
  type Fake = ReturnType<typeof createFakeDb>;

  // PostgreSQL compares `uuid` values in canonical form, so `ABCDEF…` and
  // `abcdef…` are the same row. The shared double compares strings with `===`,
  // and `src/test-support/fake-db.ts` is outside this slice's edit surface, so
  // the equivalence is modelled here: every uuid-shaped string PARAMETER of a
  // SELECT is matched in canonical lowercase form. A spelling that is already
  // canonical takes this path unchanged. Writes (the DELETE and its WHERE) are
  // deliberately left strict: PostgreSQL would mask a delete scoped by the
  // caller's spelling, and a double that hid that divergence too would be
  // useless.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const canonicalise = (condition: unknown): unknown => {
    const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks;
    for (const chunk of chunks ?? []) {
      const candidate = chunk as { value?: unknown; queryChunks?: unknown[] };
      if (Array.isArray(candidate.queryChunks)) {
        canonicalise(chunk);
      } else if (typeof candidate.value === "string" && UUID.test(candidate.value)) {
        candidate.value = candidate.value.toLowerCase();
      }
    }
    return condition;
  };
  const select = fake.select as (columns?: Record<string, unknown>) => unknown;
  type Statement = { from: (table: unknown) => { where: (condition: unknown) => unknown } };
  fake.select = (columns) => {
    const statement = select(columns) as Statement;
    return {
      from: (table: unknown) => {
        const scoped = statement.from(table);
        return { where: (condition: unknown) => scoped.where(canonicalise(condition)) };
      },
    };
  };

  // Transaction lifecycle. The double runs the callback against itself and
  // models no rollback, so "the callback returned" IS the commit here. The
  // suites use this to prove no R2 delete starts before that point: R2 work
  // inside the transaction would turn a later rollback into a live row
  // pointing at a deleted object.
  const lifecycle = { finished: false };
  const transaction: Fake["transaction"] = fake.transaction;
  fake.transaction = async <T>(fn: (tx: Fake) => Promise<T>): Promise<T> => {
    lifecycle.finished = false;
    const result = await transaction(fn);
    lifecycle.finished = true;
    return result;
  };

  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assets: fake.__tables.get(assets)!,
      },
      __lifecycle: lifecycle,
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

async function transactionLifecycle(): Promise<{ finished: boolean }> {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __lifecycle: { finished: boolean } };
  };
  return db.__lifecycle;
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

// Alphabetic hex digits on purpose: an all-numeric id cannot expose a
// case-sensitivity bug, because its uppercase spelling is itself.
const GALLERY_ID = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_WITH_FINAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_NO_FINAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FINAL_KEY = `galleries/${GALLERY_ID}/finals/${ASSET_WITH_FINAL}.png`;
const PROOF_A = `galleries/${GALLERY_ID}/proofs/${ASSET_WITH_FINAL}.webp`;
const PROOF_B = `galleries/${GALLERY_ID}/proofs/${ASSET_NO_FINAL}.webp`;
const DISPLAY_A = `galleries/${GALLERY_ID}/display/${ASSET_WITH_FINAL}.webp`;
// An asset id that appears in BOTH galleries: it is what makes an unscoped
// asset read visible in the keys the action deletes.
const OTHER_PROOF_A = `galleries/${OTHER_GALLERY_ID}/proofs/${ASSET_WITH_FINAL}.webp`;

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
  displayKeyArgs.length = 0;
  (await transactionLifecycle()).finished = false;
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

  it("never touches another gallery's assets, even one that shares an asset id", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    // The asset read is scoped by the LOCKED row's id. A row of the other
    // gallery carrying the SAME asset id is the case a scope on `assets.id`
    // alone would let through, and its stored proof key differs from A's.
    r.assets.push({
      id: ASSET_WITH_FINAL,
      galleryId: OTHER_GALLERY_ID,
      proofKey: OTHER_PROOF_A,
      finalKey: null,
    });
    const { deleteGallery } = await import("./actions");

    await deleteGallery(GALLERY_ID);

    const otherKeys = calledKeys().filter((key) => key.includes(OTHER_GALLERY_ID));
    expect(otherKeys).toEqual([]);
    expect(r.assets.some((row) => row.id === OTHER_ASSET)).toBe(true);
    expect(calledKeys().sort()).toEqual([DISPLAY_A, FINAL_KEY, PROOF_A, PROOF_B].sort());
  });
});

describe("deleteGallery — the transaction it runs", () => {
  it("locks the gallery row, then reads its assets, then deletes it — in that order", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery(GALLERY_ID);

    expect(result).toEqual({ ok: true, r2Failures: 0 });
    // `for:update` REPLACES the select it locks, so the log reads as the three
    // statements in order: the row lock, the asset read, and one gallery row
    // deleted. Dropping `.for("update")` turns the first entry into `select`,
    // which is the mutation this line exists to catch — the proof-upload
    // snapshot race reopens silently without it. The double logs query kinds
    // and affected counts, not conditions: `delete:1` is what shows the DELETE
    // stayed on the single locked row (the sibling suite proves the asset read
    // is gallery-scoped).
    expect(await log()).toEqual(["for:update", "select", "delete:1"]);
    expect(calledKeys().sort()).toEqual([DISPLAY_A, FINAL_KEY, PROOF_A, PROOF_B].sort());
    expect(r.galleries.map((row) => row.id)).toEqual([OTHER_GALLERY_ID]);
  });

  it("does no R2 work until the transaction has finished", async () => {
    authMock.mockResolvedValue(adminSession());
    const lifecycle = await transactionLifecycle();
    // Read INSIDE the mock, at call time: the flag must already be true when
    // the first delete goes out, not merely by the end of the action. R2 work
    // before the commit would let a later rollback leave live rows pointing at
    // deleted objects; a post-DELETE row check cannot tell those apart.
    const finishedAtCall: boolean[] = [];
    deleteObjectMock.mockImplementation(async () => {
      finishedAtCall.push(lifecycle.finished);
    });
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery(GALLERY_ID);

    expect(result).toEqual({ ok: true, r2Failures: 0 });
    expect(finishedAtCall).toEqual([true, true, true, true]);
  });
});

describe("deleteGallery — the canonical id, not the caller's spelling", () => {
  it("an uppercase uuid still deletes the DISPLAY object of the row it resolves to", async () => {
    authMock.mockResolvedValue(adminSession());
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery(GALLERY_ID.toUpperCase());

    // Postgres resolves the uppercase spelling to the same row; R2 keys are
    // case-sensitive and deleting an ABSENT key does not reject, so a display
    // key built from the argument leaves the object in the bucket while the
    // action still reports a clean delete.
    expect(result).toEqual({ ok: true, r2Failures: 0 });
    expect(displayKeyArgs).toEqual([GALLERY_ID]);
    expect(calledKeys().sort()).toEqual([DISPLAY_A, FINAL_KEY, PROOF_A, PROOF_B].sort());
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
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

  it("counts rejected CALLS, not photos: two failures on one photo both count", async () => {
    authMock.mockResolvedValue(adminSession());
    // Two keys of the SAME photo (its proof and its display). A count of photos
    // that had a failure would report 1 and hide the second object still in the
    // bucket; `r2Failures` is the number of rejected deletes.
    deleteObjectMock.mockImplementation(async (key: string) => {
      if (key === PROOF_A || key === DISPLAY_A) throw new Error("R2 said no");
    });
    const { deleteGallery } = await import("./actions");

    const result = await deleteGallery(GALLERY_ID);

    expect(result).toEqual({ ok: true, r2Failures: 2 });
    // The later photo was still cleaned up, despite the earlier photo failing.
    expect(calledKeys()).toContain(PROOF_B);
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
    expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abcd-slug");
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
