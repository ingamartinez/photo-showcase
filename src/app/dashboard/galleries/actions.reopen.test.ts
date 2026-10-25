// Task #287 — reopening a DELIVERED gallery, end to end.
//
// This suite runs the REAL `reopenDeliveredGallery` action against the shared
// in-memory db double, the REAL client PATCH route
// (`src/app/api/assets/[assetId]/selection/route.ts`) for the self-service
// journey the owner required, the REAL final gate
// (`src/lib/final-access.ts`) and the REAL archive-size consumer. Only the
// external boundaries are mocked: auth/magic links, Next's cache, the NOTIFY
// transport, the admin notification email, and R2 (through a fake
// `Bun.S3Client` that keeps an actual object set, so a delete is observable).
//
// WHAT IT DOES NOT PROVE, stated rather than implied: the db double models
// neither row locks nor rollback (see src/test-support/fake-db.ts), so the
// "lock first" assertions prove ORDER inside the transaction, not PostgreSQL
// isolation, and a DB rollback of the reset was NOT exercised against a real
// server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

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

const notifySelectionChangedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: (...args: [string]) => notifySelectionChangedMock(...args),
}));

// The PATCH route's ownership gate has its own mutation-tested suite; here the
// session is simply trusted, so the reopen journey is not entangled with it.
vi.mock("@/lib/gallery-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gallery-access")>();
  return { ...actual, isGalleryOwner: async () => true };
});

const sendSubmissionNotificationEmailMock = vi.fn();
vi.mock("@/lib/admin-notification-email", () => ({
  sendSubmissionNotificationEmail: (...args: unknown[]) =>
    sendSubmissionNotificationEmailMock(...args),
  notifyAdminOfMissingFinal: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  authEnv: () => ({ AUTH_URL: "http://localhost:3000" }),
  resendEnv: () => ({ RESEND_API_KEY: "test-key", EMAIL_FROM: "hola@example.com" }),
  r2Env: () => ({
    R2_ACCOUNT_ID: "test-account",
    R2_ACCESS_KEY_ID: "test-key-id",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_BUCKET: "test-bucket",
    R2_ENDPOINT: "https://example.com",
  }),
}));

// --- the fake bucket -------------------------------------------------------
// Real keys, really removed: the C4 mutation (deleting the drainer's
// `deleteObject` call) must leave observable bytes behind.
const objects = new Set<string>();
const deleteObjectCalls: string[] = [];
const listCalls: { prefix?: string; continuationToken?: string }[] = [];
const listFailures = { remaining: 0 };
const deleteFailures = { remaining: 0 };

class FakeS3Client {
  write = vi.fn().mockResolvedValue(0);
  presign = vi.fn().mockReturnValue("https://example.com/presigned");
  delete = vi.fn(async (key: string) => {
    if (deleteFailures.remaining > 0) {
      deleteFailures.remaining -= 1;
      throw new Error("r2 down");
    }
    deleteObjectCalls.push(key);
    objects.delete(key);
  });
  file = vi.fn().mockReturnValue({ stream: () => "stream" });
  size = vi.fn().mockResolvedValue(1024);
  exists = vi.fn(async (key: string) => objects.has(key));
  list = vi.fn(async (input: { prefix?: string; continuationToken?: string }) => {
    listCalls.push(input);
    if (listFailures.remaining > 0) {
      listFailures.remaining -= 1;
      throw new Error("r2 list failed");
    }
    const keys = [...objects].filter((key) => key.startsWith(input.prefix ?? ""));
    return { contents: keys.map((key) => ({ key })), isTruncated: false };
  });
}

/** Flattens `and(eq(col, value), isNull(col))` into named leaves. Same
 * leaf-aware parser the sibling action suites use; anything else THROWS rather
 * than being silently mis-modelled. */
function leavesOf(condition: unknown): { name: string; op: "eq" | "isNull"; value?: unknown }[] {
  const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) throw new Error("fake db: not a drizzle condition");
  const leaves: { name: string; op: "eq" | "isNull"; value?: unknown }[] = [];
  let name: string | undefined;
  let value: unknown;
  let hasValue = false;
  let isNull = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      const candidate = chunk as {
        name?: string;
        table?: unknown;
        value?: unknown;
        encoder?: unknown;
        queryChunks?: unknown[];
      };
      if (candidate.queryChunks) leaves.push(...leavesOf(chunk));
      if ("name" in candidate && "table" in candidate) name = candidate.name;
      if ("value" in candidate && "encoder" in candidate) {
        value = candidate.value;
        hasValue = true;
      }
      if (Array.isArray(candidate.value) && candidate.value.join("").includes("is null")) {
        isNull = true;
      }
    }
  }
  if (name) {
    if (isNull) leaves.push({ name, op: "isNull" });
    else if (hasValue) leaves.push({ name, op: "eq", value });
  }
  return leaves;
}

vi.mock("@/lib/db", async () => {
  const { assets, assetPicks, galleries, galleryClients, galleryFinalCleanup, users } =
    await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([
    galleries,
    galleryClients,
    assets,
    assetPicks,
    users,
    galleryFinalCleanup,
  ]);
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assets: fake.__tables.get(assets)!,
        assetPicks: fake.__tables.get(assetPicks)!,
        users: fake.__tables.get(users)!,
        galleryFinalCleanup: fake.__tables.get(galleryFinalCleanup)!,
      },
      // `getGalleryClients` (src/lib/galleries.ts) reads through the relational
      // API; this mirrors its real `where` (gallery + `removedAt IS NULL`) off
      // the fake's own rows instead of handing back a canned recipient list.
      query: {
        galleryClients: {
          findMany: async (args: { where: unknown }) => {
            const conditions = leavesOf(args.where);
            const galleryId = conditions.find((leaf) => leaf.name === "gallery_id");
            if (!galleryId || galleryId.op !== "eq") {
              throw new Error("fake db: expected a where on galleryClients.galleryId");
            }
            if (!conditions.some((leaf) => leaf.name === "removed_at" && leaf.op === "isNull")) {
              throw new Error("fake db: expected getGalleryClients to filter removedAt IS NULL");
            }
            return fake.__tables
              .get(galleryClients)!
              .filter((row) => row.galleryId === galleryId.value && row.removedAt == null)
              .map((row) => ({
                user: fake.__tables.get(users)!.find((user) => user.id === row.userId),
              }));
          },
        },
      },
    }),
  };
});

type Row = Record<string, unknown>;
type Rows = {
  galleries: Row[];
  galleryClients: Row[];
  assets: Row[];
  assetPicks: Row[];
  users: Row[];
  galleryFinalCleanup: Row[];
};

async function db() {
  const loaded = (await import("@/lib/db")) as unknown as {
    db: { __rows: Rows; __log: string[] };
  };
  return loaded.db;
}

// `eq()` conditions are matched by the fake; these helpers read the ROWS.
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const A = "client-a";
const B = "client-b";
const REMOVED = "client-removed";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const A3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const A4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const A5 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const OTHER_ASSET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const T0 = new Date("2026-10-01T10:00:00.000Z"); // previous unlock
const T1 = new Date("2026-10-20T10:00:00.000Z"); // delivery
const SUBMITTED = new Date("2026-10-15T09:00:00.000Z");
const LISTED = new Date("2026-10-18T09:00:00.000Z");

const finalOf = (assetId: string, ext = "jpg") => `galleries/${G1}/finals/${assetId}.${ext}`;
const displayOf = (assetId: string) => `galleries/${G1}/display/${assetId}.webp`;
const proofOf = (assetId: string) => `galleries/${G1}/proofs/${assetId}.webp`;

function session(userId: string, role: "admin" | "client", email: string): Session {
  return {
    user: { id: userId, role, email },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}
const adminSession = () => session("admin-1", "admin", "photographer@example.com");
const clientASession = () => session(A, "client", "ana@example.com");
const clientBSession = () => session(B, "client", "beto@example.com");

function gallery(id: string, overrides: Row = {}): Row {
  return {
    id,
    packageId: 1,
    title: "SOFA día 2",
    sessionDate: "2026-09-30",
    status: "delivered",
    publicSlug: id === G1 ? "sofa-dia-2" : "otra-galeria",
    includedPhotosSnapshot: 2,
    extraPhotoPriceCopSnapshot: 5_000,
    extraPhotoPriceTiersSnapshot: null,
    originalPhotoPriceCopSnapshot: 2_000,
    allowsOriginalSelection: true,
    rollingDelivery: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    selectionSubmittedAt: SUBMITTED,
    deliveredAt: T1,
    unlockedAt: T0,
    unlockedByEmail: "photographer@example.com",
    unlockReason: "primera reapertura",
    ...overrides,
  };
}

function asset(id: string, overrides: Row = {}): Row {
  return {
    id,
    galleryId: G1,
    originalFilename: `${id}.JPG`,
    proofKey: proofOf(id),
    finalKey: null,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    selectedAt: null,
    requestedAt: null,
    billedTo: null,
    billedAt: null,
    selectionKind: "edited",
    isExtra: false,
    deliveredFor: null,
    isEdited: false,
    sortOrder: 0,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  };
}

function pick(assetId: string, userId: string, overrides: Row = {}): Row {
  return {
    assetId,
    galleryId: G1,
    userId,
    kind: "edited",
    pickedAt: LISTED,
    submittedAt: null,
    ...overrides,
  };
}

function member(userId: string, overrides: Row = {}): Row {
  return {
    galleryId: G1,
    userId,
    removedAt: null,
    selectionLockedAt: null,
    selectionSubmittedAt: null,
    selectionLockedBy: null,
    ...overrides,
  };
}

function rows() {
  return db().then((fake) => fake.__rows);
}

function formData(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

/** Admin A has a submitted pick on a1 (a final exists), B never submitted but
 * carries an admin lock and an unsent pick on a2, a removed membership keeps
 * stale stamps, a2 is a legacy unit with no holder, a3 is an unselected gift,
 * a4 is a discarded photo with a final, a5 is shared by both people. The other
 * gallery is a full duplicate that must come out byte-identical. */
async function seed() {
  const r = await rows();
  for (const list of Object.values(r)) list.length = 0;
  for (const key of [...objects]) objects.delete(key);
  deleteObjectCalls.length = 0;
  listCalls.length = 0;
  listFailures.remaining = 0;
  deleteFailures.remaining = 0;
  (await db()).__log.length = 0;

  r.users.push(
    { id: "admin-1", name: "Alejo", email: "photographer@example.com", role: "admin" },
    { id: A, name: "Ana", email: "ana@example.com", role: "client" },
    { id: B, name: "Beto", email: "beto@example.com", role: "client" },
    { id: REMOVED, name: "Caro", email: "caro@example.com", role: "client" },
  );
  r.galleries.push(gallery(G1), gallery(G2, { publicSlug: "otra-galeria" }));
  r.galleryClients.push(
    member(A, {
      selectionLockedAt: new Date("2026-10-14T00:00:00.000Z"),
      selectionSubmittedAt: SUBMITTED,
      selectionLockedBy: "client",
    }),
    member(B, {
      selectionLockedAt: new Date("2026-10-16T00:00:00.000Z"),
      selectionSubmittedAt: null,
      selectionLockedBy: "admin",
    }),
    member(REMOVED, {
      removedAt: new Date("2026-10-10T00:00:00.000Z"),
      selectionLockedAt: new Date("2026-10-09T00:00:00.000Z"),
      selectionSubmittedAt: new Date("2026-10-09T00:00:00.000Z"),
      selectionLockedBy: "admin",
    }),
    // The other gallery, untouched: same people, same shape.
    member(A, { galleryId: G2, selectionLockedAt: new Date("2026-10-14T00:00:00.000Z") }),
  );

  r.assets.push(
    asset(A1, {
      isSelected: true,
      selectionKind: "original",
      billedTo: A,
      billedAt: LISTED,
      selectedAt: LISTED,
      requestedAt: LISTED,
      finalKey: finalOf(A1, "jpg"),
      isEdited: true,
    }),
    asset(A2, { isSelected: true, billedTo: null, billedAt: null }),
    asset(A3, {
      finalKey: finalOf(A3, "png"),
      isEdited: true,
      isExtra: true,
      deliveredFor: A,
    }),
    asset(A4, { finalKey: finalOf(A4, "jpg"), isEdited: true }),
    asset(A5, {
      isSelected: true,
      billedTo: B,
      billedAt: new Date("2026-10-18T10:00:00.000Z"),
      selectedAt: LISTED,
      requestedAt: LISTED,
      finalKey: finalOf(A5, "png"),
      isEdited: true,
    }),
    asset(OTHER_ASSET, {
      galleryId: G2,
      isSelected: true,
      billedTo: A,
      billedAt: LISTED,
      finalKey: `galleries/${G2}/finals/${OTHER_ASSET}.jpg`,
      isEdited: true,
    }),
  );

  r.assetPicks.push(
    pick(A1, A, { kind: "original", submittedAt: SUBMITTED }),
    pick(A2, B),
    pick(A4, B),
    pick(A5, B, { submittedAt: SUBMITTED }),
    pick(A5, A, { submittedAt: SUBMITTED }),
    pick(OTHER_ASSET, A, { galleryId: G2, submittedAt: SUBMITTED }),
  );

  // Object store: both extension variants for a1 (a format-changing cleanup
  // failure left the jpg behind), the display-only object of a4, and the
  // objects of the other gallery plus a proof.
  objects.add(finalOf(A1, "jpg"));
  objects.add(finalOf(A1, "png"));
  objects.add(displayOf(A1));
  objects.add(finalOf(A3, "png"));
  objects.add(displayOf(A3));
  objects.add(finalOf(A4, "jpg"));
  objects.add(displayOf(A4));
  objects.add(finalOf(A5, "png"));
  objects.add(displayOf(A5));
  objects.add(proofOf(A1));
  objects.add(`galleries/${G2}/finals/${OTHER_ASSET}.jpg`);
  objects.add(`galleries/${G2}/display/${OTHER_ASSET}.webp`);
}

async function reopen(fields: Record<string, string | undefined> = {}) {
  const { reopenDeliveredGallery } = await import("./actions");
  return reopenDeliveredGallery({ status: "idle" }, formData({ galleryId: G1, ...fields }));
}

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  revalidatePathMock.mockReset();
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
  sendSubmissionNotificationEmailMock.mockReset();
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  vi.stubGlobal("Bun", { S3Client: FakeS3Client });
  authMock.mockResolvedValue(adminSession());
  signInMock.mockResolvedValue("http://localhost/api/auth/verify-request");
  await seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("reopenDeliveredGallery — authorization and state (C1)", () => {
  it("refuses a signed-in CLIENT without a single write or email", async () => {
    authMock.mockResolvedValue(clientASession());

    await expect(reopen()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    const r = await rows();
    expect(r.galleries[0]!.status).toBe("delivered");
    expect(r.galleryFinalCleanup).toEqual([]);
    expect(signInMock).not.toHaveBeenCalled();
    expect(deleteObjectCalls).toEqual([]);
  });

  it("redirects to /login with no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(reopen()).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });

    expect((await rows()).galleries[0]!.status).toBe("delivered");
  });

  it("rejects a malformed id and a missing gallery without touching anything", async () => {
    const invalid = await reopen({ galleryId: "nope" });
    expect(invalid.status).toBe("error");

    const missing = await reopen({ galleryId: "33333333-3333-4333-8333-333333333333" });
    expect(missing).toEqual({ status: "error", message: "La galería no existe." });
    expect(deleteObjectCalls).toEqual([]);
  });

  it.each(["draft", "proofing", "selected", "archived"])(
    "refuses a %s gallery: only a delivered one has a delivery to reopen",
    async (status) => {
      const r = await rows();
      r.galleries[0]!.status = status;

      const result = await reopen();

      expect(result.status).toBe("error");
      expect(r.galleries[0]!.status).toBe(status);
      expect(
        r.galleryClients.every(
          (row) =>
            row.galleryId !== G1 ||
            row.selectionLockedAt === null ||
            row.userId !== A ||
            row.selectionLockedBy === "client",
        ),
      ).toBe(true);
      expect(signInMock).not.toHaveBeenCalled();
    },
  );

  it("reopens ONCE: a second sequential call loses the delivered CAS", async () => {
    expect((await reopen()).status).toBe("reopened");
    signInMock.mockClear();

    const second = await reopen();

    expect(second.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
    const r = await rows();
    expect(r.galleryFinalCleanup).toEqual([]);
  });

  it("does not let a stale preflight win the transition (the CAS is the guard)", async () => {
    // Force the exact race the CAS exists for: the preflight above read
    // `delivered`, and another tab flips the gallery to `proofing` before this
    // call's own UPDATE runs. Deleting the `status = 'delivered'` predicate
    // from the CAS makes the reopen succeed here — the named red of mutation C1.
    const fake = await db();
    const realUpdate = (fake as unknown as { update: unknown }).update as (
      table: unknown,
    ) => unknown;
    let flipped = false;
    const { galleries } = await import("@/lib/db/schema");
    (fake as unknown as { update: unknown }).update = (table: unknown) => {
      const statement = realUpdate(table) as {
        set: (patch: Row) => { where: (condition: unknown) => unknown };
      };
      if (table !== galleries) return statement;
      return {
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            if (!flipped) {
              flipped = true;
              (fake as unknown as { __rows: Rows }).__rows.galleries[0]!.status = "proofing";
            }
            return statement.set(patch).where(condition);
          },
        }),
      };
    };
    try {
      const result = await reopen();
      expect(result.status).toBe("error");
    } finally {
      (fake as unknown as { update: unknown }).update = realUpdate;
    }

    const r = await rows();
    expect(r.galleryFinalCleanup).toEqual([]);
    expect(r.galleryClients.find((row) => row.userId === A)!.selectionLockedBy).toBe("client");
    expect(deleteObjectCalls).toEqual([]);
  });
});

describe("reopenDeliveredGallery — the transaction and the reset (C2)", () => {
  it("locks the gallery row before any write inside the transaction", async () => {
    await reopen();

    const log = (await db()).__log;
    const lockIndex = log.indexOf("for:update");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    // Two locks total: this action's reset, and the post-commit drainer's own
    // transaction. Nothing that writes may precede the FIRST one.
    expect(log.filter((entry) => entry === "for:update")).toHaveLength(2);
    expect(
      log.findIndex((entry) => entry.startsWith("update:") || entry.startsWith("insert:")),
    ).toBeGreaterThan(lockIndex);
    // The drainer runs strictly after the reset's writes committed.
    expect(log.lastIndexOf("for:update")).toBeGreaterThan(log.lastIndexOf("update:1"));
  });

  it("flips the status, clears deliveredAt, and advances the unlock audit strictly", async () => {
    const before = structuredClone((await rows()).galleries[0]!);

    const result = await reopen({ reason: "ojos cerrados" });

    expect(result.status).toBe("reopened");
    const after = (await rows()).galleries[0]!;
    expect(after.status).toBe("proofing");
    expect(after.deliveredAt).toBeNull();
    expect(after.unlockedByEmail).toBe("photographer@example.com");
    expect(after.unlockReason).toBe("ojos cerrados");
    expect((after.unlockedAt as Date).getTime()).toBeGreaterThan(
      (before.unlockedAt as Date).getTime(),
    );
    // The list-order sort key (#75) is preserved at reopen.
    expect(after.selectionSubmittedAt).toEqual(SUBMITTED);
  });

  it("resets all three lock fields on EVERY membership, removed rows included", async () => {
    await reopen();

    const r = await rows();
    for (const userId of [A, B, REMOVED]) {
      const row = r.galleryClients.find((candidate) => candidate.userId === userId)!;
      expect(row).toMatchObject({
        selectionLockedAt: null,
        selectionSubmittedAt: null,
        selectionLockedBy: null,
      });
    }
    // Removal is not undone and the other gallery is untouched.
    expect(r.galleryClients.find((row) => row.userId === REMOVED)!.removedAt).not.toBeNull();
    expect(r.galleryClients.find((row) => row.galleryId === G2)!.selectionLockedAt).toEqual(
      new Date("2026-10-14T00:00:00.000Z"),
    );
    expect(r.galleries.find((row) => row.id === G2)!.status).toBe("delivered");
  });

  it("detaches EVERY final, its edit/gift attribution, and cancels every claim", async () => {
    await reopen();

    const r = await rows();
    for (const row of r.assets.filter((candidate) => candidate.galleryId === G1)) {
      expect(row).toMatchObject({
        finalKey: null,
        isEdited: false,
        isExtra: false,
        deliveredFor: null,
        isSelected: false,
        billedTo: null,
        billedAt: null,
      });
      // Proofs and dimensions are NOT part of the delivered cycle.
      expect(row.proofKey).toBe(proofOf(row.id as string));
    }
    // Every retained pick is a cart, with its owner, kind and pick time intact.
    for (const row of r.assetPicks.filter((candidate) => candidate.galleryId === G1)) {
      expect(row.submittedAt).toBeNull();
    }
    expect(r.assetPicks.find((row) => row.assetId === A1 && row.userId === A)).toMatchObject({
      kind: "original",
      pickedAt: LISTED,
    });
    // The other gallery keeps its final, its claim and its submitted pick.
    expect(r.assets.find((row) => row.galleryId === G2)).toMatchObject({
      isSelected: true,
      billedTo: A,
      finalKey: `galleries/${G2}/finals/${OTHER_ASSET}.jpg`,
    });
  });

  it("records the cleanup obligation before detaching and removes the old bytes", async () => {
    await reopen();

    // Every old final/display variant is gone, the alternate extension too.
    expect([...objects].sort()).toEqual(
      [
        proofOf(A1),
        `galleries/${G2}/finals/${OTHER_ASSET}.jpg`,
        `galleries/${G2}/display/${OTHER_ASSET}.webp`,
      ].sort(),
    );
    // No proof object was ever deleted.
    expect(deleteObjectCalls).not.toContain(proofOf(A1));
    // LIST is scoped to this gallery's two prefixes only.
    expect(listCalls.every((call) => call.prefix!.startsWith(`galleries/${G1}/`))).toBe(true);
    expect(listCalls.map((call) => call.prefix).sort()).toEqual([
      `galleries/${G1}/display/`,
      `galleries/${G1}/finals/`,
    ]);
    // A clean drain leaves no obligation behind.
    expect((await rows()).galleryFinalCleanup).toEqual([]);
  });

  it("consumers see no deliverable after the reopen, whatever the delivery mode", async () => {
    await reopen();
    const { canReadFinalDeliverable, areFinalsOpenToClient } = await import("@/lib/final-access");
    const { getGalleryArchiveSize } = await import("@/lib/gallery-archive-size");

    const r = await rows();
    const gallery = r.galleries[0]!;
    const reopenedAssets = r.assets.filter((row) => row.galleryId === G1);

    for (const row of reopenedAssets) {
      const view = row as unknown as {
        isSelected: boolean;
        isEdited: boolean;
        isExtra: boolean;
        finalKey: string | null;
      };
      expect(canReadFinalDeliverable(view, gallery as never, clientASession() as never)).toBe(
        false,
      );
      expect(canReadFinalDeliverable(view, gallery as never, adminSession() as never)).toBe(false);
    }
    // The gallery-level rolling gate is untouched and still open in proofing —
    // what refuses the download is the per-asset absence, not a new gate.
    expect(areFinalsOpenToClient({ status: "proofing", rollingDelivery: true })).toBe(true);
    // Archive-size hint: nothing deliverable, so no HEAD is even attempted.
    expect(
      await getGalleryArchiveSize(
        reopenedAssets as unknown as {
          finalKey: string | null;
          isSelected: boolean;
          isEdited: boolean;
        }[],
      ),
    ).toBeNull();
  });

  it("refuses delivery again until every selected photo is re-uploaded", async () => {
    await reopen();
    const { deliverGallery } = await import("./actions");

    // While proofing there is nothing submitted to deliver.
    expect((await deliverGallery({ status: "idle" }, formData({ galleryId: G1 }))).status).toBe(
      "error",
    );

    // Once the new cycle closes (`selected`) with a chosen photo, delivery
    // refuses again because the detached finals are gone: the reopen restored
    // no old key, so re-uploading is mandatory even for an unchanged choice.
    const r = await rows();
    r.galleries[0]!.status = "selected";
    r.assets.find((row) => row.id === A1)!.isSelected = true;
    const refused = await deliverGallery({ status: "idle" }, formData({ galleryId: G1 }));

    expect(refused.status).toBe("error");
    expect(refused.message).toMatch(/Falta 1 final/);
    expect(r.galleries[0]!.status).toBe("selected");
  });
});

describe("reopenDeliveredGallery — the client's own journey (C3)", () => {
  async function patch(
    assetId: string,
    body: Record<string, unknown>,
    activeSession: Session = clientASession(),
  ) {
    authMock.mockResolvedValue(activeSession);
    const { PATCH } = await import("@/app/api/assets/[assetId]/selection/route");
    return PATCH(
      new NextRequest(`http://localhost/api/assets/${assetId}/selection`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ assetId }) },
    );
  }

  it("lets the client remove the photo they already sent, pick another and resubmit", async () => {
    // Before the reopen a delivered gallery is closed to edits.
    const refused = await patch(A1, { selected: false });
    expect(refused.status).toBe(409);

    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened");

    const removed = await patch(A1, { selected: false });
    expect(removed.status).toBe(200);
    // A had also asked for the shared photo; drop that too so the cart under
    // test is exactly the replacement.
    expect((await patch(A5, { selected: false })).status).toBe(200);
    let r = await rows();
    expect(r.assetPicks.find((row) => row.assetId === A1 && row.userId === A)).toBeUndefined();
    expect(r.assets.find((row) => row.id === A1)).toMatchObject({ isSelected: false });

    // The replacement is a normal cart pick, then the client's own submit
    // resolves exactly one new unit.
    const added = await patch(A2, { selected: true, selectionKind: "edited" }, clientASession());
    expect(added.status).toBe(200);
    r = await rows();
    expect(r.assetPicks.find((row) => row.assetId === A2 && row.userId === A)).toMatchObject({
      submittedAt: null,
    });

    const { claimCart } = await import("@/lib/pick-claims");
    const { lockGalleryRow } = await import("@/lib/gallery-client-locks");
    const now = new Date("2026-10-26T10:00:00.000Z");
    await inTransaction(async (tx) => {
      const locked = await lockGalleryRow(tx as never, G1);
      await claimCart(tx as never, locked!, A, now);
    });

    r = await rows();
    expect(
      r.assetPicks.filter(
        (row) => row.userId === A && row.galleryId === G1 && row.submittedAt !== null,
      ),
    ).toEqual([expect.objectContaining({ assetId: A2 })]);
    expect(r.assets.find((row) => row.id === A2)).toMatchObject({
      isSelected: true,
      billedTo: A,
      billedAt: now,
    });
    // No ghost unit on the removed photo, and nobody else's pick was stolen.
    expect(r.assets.find((row) => row.id === A1)).toMatchObject({ isSelected: false });
    expect(r.assets.find((row) => row.id === A5)).toMatchObject({ isSelected: false });
    expect(r.assetPicks.find((row) => row.assetId === A5 && row.userId === B)!.submittedAt).toBe(
      null,
    );
  });

  it("keeps a shared photo's genuine collaboration intact after the reset", async () => {
    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened");

    // Both carts coexist until somebody submits.
    let r = await rows();
    expect(r.assetPicks.filter((row) => row.assetId === A5)).toHaveLength(2);

    const { claimCart } = await import("@/lib/pick-claims");
    const { lockGalleryRow } = await import("@/lib/gallery-client-locks");
    const now = new Date("2026-10-26T11:00:00.000Z");
    await inTransaction(async (tx) => {
      const locked = await lockGalleryRow(tx as never, G1);
      await claimCart(tx as never, locked!, A, now);
    });

    r = await rows();
    expect(r.assets.find((row) => row.id === A5)).toMatchObject({ billedTo: A, billedAt: now });

    // B's stale cart on the same photo is now legitimately degraded, and B can
    // remove it without touching A's new claim.
    const removed = await patch(A5, { selected: false }, clientBSession());
    expect(removed.status).toBe(200);
    r = await rows();
    expect(r.assetPicks.find((row) => row.assetId === A5 && row.userId === B)).toBeUndefined();
    expect(r.assets.find((row) => row.id === A5)).toMatchObject({
      isSelected: true,
      billedTo: A,
      billedAt: now,
    });
  });
});

/** Runs a body against the fake's transaction executor. The double models no
 * isolation or rollback; for this suite it is only the handle `claimCart` and
 * `lockGalleryRow` need, so the REAL submit path executes. */
async function inTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const fake = (await db()) as unknown as { transaction: (body: typeof fn) => Promise<T> };
  return fake.transaction(fn);
}

describe("reopenDeliveredGallery — notification and email (C5)", () => {
  it("notifies once after the reset commits and emails every active client", async () => {
    const result = await reopen();

    expect(result).toEqual({ status: "reopened" });
    expect(notifySelectionChangedMock).toHaveBeenCalledTimes(1);
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(G1);
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect(signInMock.mock.calls.map(([, options]) => options.email).sort()).toEqual([
      "ana@example.com",
      "beto@example.com",
    ]);
    expect(signInMock.mock.calls[0]![0]).toBe("gallery-unlock");
    expect(signInMock.mock.calls[0]![1].redirectTo).toBe("/galleries/sofa-dia-2");
    // The removed membership was reset but is NOT mailed.
    expect(signInMock.mock.calls.map(([, options]) => options.email)).not.toContain(
      "caro@example.com",
    );
  });

  it("reports a partial failure distinctly and keeps the committed reopen", async () => {
    const { AuthError } = await import("next-auth");
    void AuthError;
    signInMock.mockImplementation(async (_provider: string, options: { email: string }) => {
      if (options.email === "beto@example.com") throw new Error("resend down");
      return "ok";
    });
    // A plain Error is NOT an AuthError, so the action rethrows it (same stance
    // as `unlockSelection`) — the reset stays committed either way.
    await expect(reopen()).rejects.toThrow(/resend down/);

    const r = await rows();
    expect(r.galleries[0]!.status).toBe("proofing");
    expect(r.galleryFinalCleanup).toEqual([]);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${G1}`);
  });

  it("swallows a rejected NOTIFY, because the transition already committed", async () => {
    notifySelectionChangedMock.mockRejectedValue(new Error("notify down"));

    expect((await reopen()).status).toBe("reopened");
    expect((await rows()).galleries[0]!.status).toBe("proofing");
  });
});

describe("reopenDeliveredGallery — cleanup failure and retry", () => {
  it("reports the cleanup failure, keeps the reopen, and retries from the manifest", async () => {
    // Every DELETE rejects, as an R2 outage would. Two attempts per key, so a
    // large budget keeps the whole pass failing.
    deleteFailures.remaining = 1_000;

    const failed = await reopen();
    expect(failed.status).toBe("reopened_cleanup_failed");
    expect(failed.remainingCleanupKeys).toBeGreaterThan(0);
    expect((await rows()).galleries[0]!.status).toBe("proofing");
    // The bytes are still there — the reopen did NOT report a clean cycle.
    expect(objects.has(finalOf(A1, "jpg"))).toBe(true);

    const r = await rows();
    const manifest = r.galleryFinalCleanup[0]!;
    expect(manifest.galleryId).toBe(G1);
    expect(manifest.reopenEpoch).toEqual(r.galleries[0]!.unlockedAt);

    deleteFailures.remaining = 0;
    const { retryReopenedFinalCleanup } = await import("./actions");
    const retried = await retryReopenedFinalCleanup(
      { status: "idle" },
      formData({
        galleryId: G1,
        expectedEpoch: (manifest.reopenEpoch as Date).toISOString(),
      }),
    );

    expect(retried).toEqual({ status: "cleaned" });
    expect((await rows()).galleryFinalCleanup).toEqual([]);
    expect(objects.has(finalOf(A1, "jpg"))).toBe(false);
    // The retry sends no second email wave and does not transition anything.
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect((await rows()).galleries[0]!.status).toBe("proofing");
  });

  it("refuses a retry whose epoch no longer matches the pending obligation", async () => {
    const r = await rows();
    r.galleryFinalCleanup.push({ galleryId: G1, reopenEpoch: T1, remainingKeys: [finalOf(A1)] });
    const { retryReopenedFinalCleanup } = await import("./actions");

    const result = await retryReopenedFinalCleanup(
      { status: "idle" },
      formData({ galleryId: G1, expectedEpoch: new Date("2020-01-01").toISOString() }),
    );

    expect(result.status).toBe("error");
    expect(objects.has(finalOf(A1))).toBe(true);
    expect((await rows()).galleryFinalCleanup).toHaveLength(1);
  });

  it("refuses a new reopen while a cleanup is still pending", async () => {
    const r = await rows();
    r.galleryFinalCleanup.push({
      galleryId: G1,
      reopenEpoch: T1,
      remainingKeys: [finalOf(A1)],
    });

    const result = await reopen();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/limpieza/);
    expect(r.galleries[0]!.status).toBe("delivered");
  });
});
