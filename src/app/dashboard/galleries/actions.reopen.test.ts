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
// Task #287 review — the consumer HTTP tests assert that a reopened gallery
// reaches NO storage operation at all: no presign, no HEAD (`exists`/`size`),
// no stream open. Counters rather than `vi.fn` instances because `getClient()`
// may hand back a different instance than the one a test could reach.
const presignCalls: string[] = [];
const existsCalls: string[] = [];
const sizeCalls: string[] = [];
const streamCalls: string[] = [];

class FakeS3Client {
  write = vi.fn().mockResolvedValue(0);
  presign = vi.fn((key: string) => {
    presignCalls.push(key);
    return "https://example.com/presigned";
  });
  delete = vi.fn(async (key: string) => {
    if (deleteFailures.remaining > 0) {
      deleteFailures.remaining -= 1;
      throw new Error("r2 down");
    }
    deleteObjectCalls.push(key);
    objects.delete(key);
  });
  file = vi.fn((key: string) => {
    streamCalls.push(key);
    return { stream: () => "stream" };
  });
  size = vi.fn(async (key: string) => {
    sizeCalls.push(key);
    return 1024;
  });
  exists = vi.fn(async (key: string) => {
    existsCalls.push(key);
    return objects.has(key);
  });
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
  presignCalls.length = 0;
  existsCalls.length = 0;
  sizeCalls.length = 0;
  streamCalls.length = 0;
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

/** The REAL client submit route — `POST /api/galleries/[galleryId]/submit-selection`.
 * `claimCart` called directly (which an earlier version of this suite did) skips
 * the membership stamping, the claim resolution's route-level gates, the quota
 * re-read and `settleGalleryLockStatus`, so it could never prove the client's own
 * journey end to end. */
/** The REAL client PATCH — `PATCH /api/assets/[assetId]/selection`. */
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

async function submitSelection(activeSession: Session = clientASession()) {
  authMock.mockResolvedValue(activeSession);
  const { POST } = await import("@/app/api/galleries/[galleryId]/submit-selection/route");
  return POST(
    new NextRequest(`http://localhost/api/galleries/${G1}/submit-selection`, { method: "POST" }),
    { params: Promise.resolve({ galleryId: G1 }) },
  );
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

    // The replacement is a normal cart pick…
    const added = await patch(A2, { selected: true, selectionKind: "edited" }, clientASession());
    expect(added.status).toBe(200);
    r = await rows();
    expect(r.assetPicks.find((row) => row.assetId === A2 && row.userId === A)).toMatchObject({
      submittedAt: null,
    });

    // …and THE REAL SUBMIT resolves it: the client's own POST, which stamps
    // the membership, runs `claimCart` under the gallery lock and re-reads the
    // quota. An earlier version of this test called `claimCart` directly and
    // its comment claimed the real submit path executed; it did not.
    const submitted = await submitSelection(clientASession());
    expect(submitted.status).toBe(200);
    const submittedBody = (await submitted.json()) as {
      status: string;
      quota: { selected: number; selectedEdited: number; extras: number; surchargeCop: number };
      requestedCount: number;
      gallerySelected: boolean;
    };
    expect(submittedBody.status).toBe("submitted");
    expect(submittedBody.requestedCount).toBe(1);
    expect(submittedBody.quota).toMatchObject({
      selected: 1,
      selectedEdited: 1,
      extras: 0,
      surchargeCop: 0,
    });
    // B still holds carts, so this was not the submit that closed the gallery.
    expect(submittedBody.gallerySelected).toBe(false);

    r = await rows();
    // Membership state: the caller's own submission was stamped (never locked).
    expect(r.galleryClients.find((row) => row.userId === A)!.selectionSubmittedAt).toBeInstanceOf(
      Date,
    );
    expect(r.galleryClients.find((row) => row.userId === A)!.selectionLockedAt).toBeNull();
    expect(
      r.assetPicks.filter(
        (row) => row.userId === A && row.galleryId === G1 && row.submittedAt !== null,
      ),
    ).toEqual([expect.objectContaining({ assetId: A2 })]);
    expect(r.assets.find((row) => row.id === A2)).toMatchObject({
      isSelected: true,
      billedTo: A,
    });
    // No ghost unit on the removed photo, and nobody else's pick was stolen.
    expect(r.assets.find((row) => row.id === A1)).toMatchObject({ isSelected: false });
    expect(r.assets.find((row) => row.id === A5)).toMatchObject({ isSelected: false });
    expect(r.assetPicks.find((row) => row.assetId === A5 && row.userId === B)!.submittedAt).toBe(
      null,
    );

    // A newly sent pick freezes again: the reopen's bulk de-submission is not a
    // standing exemption from the submitted-order rule.
    const frozen = await patch(A2, { selected: false }, clientASession());
    expect(frozen.status).toBe(409);
    await expect(frozen.json()).resolves.toEqual({ error: "already_requested" });
  });

  it("keeps a shared photo's genuine collaboration intact after the reset", async () => {
    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened");

    // Both carts coexist until somebody submits.
    let r = await rows();
    expect(r.assetPicks.filter((row) => row.assetId === A5)).toHaveLength(2);

    // A's REAL submit claims the shared photo.
    expect((await submitSelection(clientASession())).status).toBe(200);

    r = await rows();
    const claimedAt = r.assets.find((row) => row.id === A5)!.billedAt as Date;
    expect(r.assets.find((row) => row.id === A5)).toMatchObject({ billedTo: A });
    expect(claimedAt).toBeInstanceOf(Date);

    // B's stale cart on the same photo is now legitimately degraded, and B can
    // remove it without touching A's new claim.
    const removed = await patch(A5, { selected: false }, clientBSession());
    expect(removed.status).toBe(200);
    r = await rows();
    expect(r.assetPicks.find((row) => row.assetId === A5 && row.userId === B)).toBeUndefined();
    expect(r.assets.find((row) => row.id === A5)).toMatchObject({
      isSelected: true,
      billedTo: A,
      billedAt: claimedAt,
    });
  });
});

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

  it("propagates an unexpected non-AuthError after revalidation, keeping the committed reopen", async () => {
    signInMock.mockImplementation(async (_provider: string, options: { email: string }) => {
      if (options.email === "beto@example.com") throw new Error("resend down");
      return "ok";
    });
    // A plain Error is NOT an AuthError, so the action rethrows it (same stance
    // as `unlockSelection`) — the reset stays committed either way. This is the
    // UNEXPECTED branch, deliberately not `reopened_email_failed`.
    await expect(reopen()).rejects.toThrow(/resend down/);

    const r = await rows();
    expect(r.galleries[0]!.status).toBe("proofing");
    expect(r.galleryFinalCleanup).toEqual([]);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${G1}`);
  });

  it("reports a PARTIAL recognized (AuthError) failure distinctly", async () => {
    const { AuthError } = await import("next-auth");
    signInMock.mockImplementation(async (_provider: string, options: { email: string }) => {
      if (options.email === "beto@example.com") throw new AuthError("no such user");
      return "ok";
    });

    const result = await reopen();

    expect(result.status).toBe("reopened_email_failed");
    expect(result.emailFailed).toBe(true);
    expect(result.message).toContain("beto@example.com");
    expect(result.message).not.toContain("ana@example.com");
    // Not rolled back: the reset committed, and the cleanup was clean.
    const r = await rows();
    expect(r.galleries[0]!.status).toBe("proofing");
    expect(r.galleryFinalCleanup).toEqual([]);
  });

  it("reports a TOTAL recognized (AuthError) failure naming every address", async () => {
    const { AuthError } = await import("next-auth");
    signInMock.mockImplementation(async () => {
      throw new AuthError("provider rejected the address");
    });

    const result = await reopen();

    expect(result.status).toBe("reopened_email_failed");
    expect(result.emailFailed).toBe(true);
    expect(result.message).toContain("ana@example.com");
    expect(result.message).toContain("beto@example.com");
    expect((await rows()).galleries[0]!.status).toBe("proofing");
  });

  it("reports zero active recipients without calling the provider", async () => {
    // Both active memberships soft-removed before the reopen: the reset still
    // covers every row, but nobody is left to mail.
    const r = await rows();
    for (const row of r.galleryClients.filter((candidate) => candidate.galleryId === G1)) {
      row.removedAt = new Date("2026-10-19T00:00:00.000Z");
    }

    const result = await reopen();

    expect(result.status).toBe("reopened_email_failed");
    expect(result.emailFailed).toBe(true);
    expect(result.message).toMatch(/no encontramos clientes/);
    expect(signInMock).not.toHaveBeenCalled();
    expect(r.galleries[0]!.status).toBe("proofing");
  });

  it("carries an email failure INDEPENDENTLY of a cleanup failure", async () => {
    const { AuthError } = await import("next-auth");
    signInMock.mockImplementation(async () => {
      throw new AuthError("provider rejected the address");
    });
    deleteFailures.remaining = 1_000;

    const result = await reopen();

    // Cleanup failure takes precedence in `status`, but neither failure is
    // hidden: the email outcome travels as its own field.
    expect(result.status).toBe("reopened_cleanup_failed");
    expect(result.emailFailed).toBe(true);
    expect(result.remainingCleanupKeys).toBeGreaterThan(0);
    // A `pending` drain carries the count, not a message — the recovery notice
    // is UI copy still awaiting owner approval.
    expect(result.message).toBeUndefined();
    const r = await rows();
    expect(r.galleries[0]!.status).toBe("proofing");
    expect(r.galleryFinalCleanup).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// The full SECOND cycle: reset -> real client submissions -> real final POST
// re-uploads -> real delivery with a fresh stamp -> a repeat refusal. This is
// the v2/v3 requirement that the reopen be proven as a cycle, not as a state
// flip (task #287 review, finding 4).
// ---------------------------------------------------------------------------
describe("reopenDeliveredGallery — the full second cycle (C4)", () => {
  /** A real, decodable image — the final POST runs the REAL `processDisplay` in
   * this suite, so a synthetic string would be a 422. Small on purpose: the
   * route's contract under test is storage/publication, not image quality. */
  async function makeJpeg(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
  }

  async function uploadFinal(assetId: string) {
    const bytes = await makeJpeg();
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array(bytes)], `${assetId}.jpg`, { type: "image/jpeg" }),
    );
    const { POST } = await import("@/app/api/assets/[assetId]/final/route");
    return POST(
      new NextRequest(`http://localhost/api/assets/${assetId}/final`, {
        method: "POST",
        body: formData,
      }),
      { params: Promise.resolve({ assetId }) },
    );
  }

  it("requires a re-upload, delivers with a FRESH deliveredAt and refuses a repeat", async () => {
    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened");

    // A swaps the photo they regret (a1 -> a3) and B orders their retained
    // carts; both through the REAL routes.
    expect((await patch(A1, { selected: false })).status).toBe(200);
    expect((await patch(A3, { selected: true, selectionKind: "edited" })).status).toBe(200);
    expect((await submitSelection(clientASession())).status).toBe(200);
    expect((await submitSelection(clientBSession())).status).toBe(200);

    let r = await rows();
    expect(r.galleries[0]!.status).toBe("selected");
    // A: a3 + a5. B: a2 + a4 + a5 (joined on the shared photo).
    expect(
      r.assets
        .filter((row) => row.galleryId === G1 && row.isSelected)
        .map((row) => row.id)
        .sort(),
    ).toEqual([A2, A3, A4, A5].sort());
    // No old reference came back with the reset: every final is still absent.
    expect(r.assets.filter((row) => row.galleryId === G1 && row.finalKey !== null)).toEqual([]);

    const { deliverGallery } = await import("./actions");
    // Delivery is admin-only; the last call above was a client submission.
    authMock.mockResolvedValue(adminSession());
    const refused = await deliverGallery({ status: "idle" }, formData({ galleryId: G1 }));
    expect(refused.status).toBe("error");
    expect(refused.message).toMatch(/Faltan 4 finales/);
    expect(r.galleries[0]!.status).toBe("selected");

    // Every selected photo — including the one A kept UNCHANGED (a5) — must be
    // uploaded again through the real final POST.
    for (const assetId of [A2, A3, A4, A5]) {
      const uploaded = await uploadFinal(assetId);
      expect(uploaded.status).toBe(200);
    }
    r = await rows();
    for (const assetId of [A2, A3, A4, A5]) {
      expect(r.assets.find((row) => row.id === assetId)!.finalKey).toBe(finalOf(assetId, "jpg"));
    }

    signInMock.mockClear();
    authMock.mockResolvedValue(adminSession());
    const delivered = await deliverGallery({ status: "idle" }, formData({ galleryId: G1 }));
    expect(delivered.status).toBe("delivered");
    r = await rows();
    expect(r.galleries[0]!.status).toBe("delivered");
    const deliveredAt = r.galleries[0]!.deliveredAt as Date;
    expect(deliveredAt).toBeInstanceOf(Date);
    // `delivered_at` means the LATEST delivery, not the first.
    expect(deliveredAt.getTime()).toBeGreaterThan(T1.getTime());
    // Exactly ONE fan-out for this cycle, on the delivery provider.
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect(signInMock.mock.calls.map(([provider]) => provider)).toEqual([
      "gallery-delivery",
      "gallery-delivery",
    ]);

    // A repeat delivery in the same cycle is refused and sends nothing.
    const repeat = await deliverGallery({ status: "idle" }, formData({ galleryId: G1 }));
    expect(repeat.status).toBe("error");
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect((await rows()).galleries[0]!.deliveredAt).toEqual(deliveredAt);
  });
});

// ---------------------------------------------------------------------------
// Money/quota: the reset cancels every resolved unit, and the new cycle is
// recomputed against the FROZEN terms with fresh arrival priority — the policy
// the owner approved. This is the assertion the review said was missing
// ("setting billing fields to null is not the same as exercising the quota
// outputs after the new order"). Task #287 review, finding 4.
// ---------------------------------------------------------------------------
describe("reopenDeliveredGallery — money and quota after the reset", () => {
  function snapshotOf(gallery: Row) {
    return {
      includedPhotosSnapshot: gallery.includedPhotosSnapshot as number,
      extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot as number,
      extraPhotoPriceTiersSnapshot: (gallery.extraPhotoPriceTiersSnapshot ?? null) as never,
      originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot as number,
    };
  }

  function unitsNow(r: Rows) {
    return r.assets
      .filter((row) => row.galleryId === G1 && row.isSelected === true)
      .map((row) => ({
        assetId: row.id as string,
        billedTo: (row.billedTo ?? null) as string | null,
        kind: row.selectionKind as "edited" | "original",
        billedAt: (row.billedAt ?? null) as Date | null,
      }));
  }

  it("zeroes the resolved units, keeps the frozen terms and recomputes the split in the new order", async () => {
    const { attributeQuota, shareFor } = await import("@/lib/quota-attribution");
    const TERMS = snapshotOf((await rows()).galleries[0]!);

    // Pre-reset ledger: the legacy unit (null arrival) and B's a5 take the two
    // included slots, so B pays nothing extra and A pays one ORIGINAL.
    let r = await rows();
    const before = attributeQuota(unitsNow(r), TERMS);
    expect(before.quota).toMatchObject({
      selected: 3,
      selectedEdited: 2,
      selectedOriginal: 1,
      extras: 0,
      surchargeCop: 2_000,
    });
    expect(shareFor(before, A)).toMatchObject({ included: 0, originals: 1, surchargeCop: 2_000 });
    expect(shareFor(before, B)).toMatchObject({ included: 1, extras: 0, surchargeCop: 0 });
    expect(before.unattributed.included).toBe(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-26T09:00:00.000Z"));
      authMock.mockResolvedValue(adminSession());
      expect((await reopen()).status).toBe("reopened");

      // Immediately after the reset: ZERO resolved units and zero surcharge —
      // old billing attribution and arrival priority are gone, not carried.
      r = await rows();
      const afterReset = attributeQuota(unitsNow(r), TERMS);
      expect(afterReset.quota).toMatchObject({
        selected: 0,
        selectedEdited: 0,
        selectedOriginal: 0,
        extras: 0,
        surchargeCop: 0,
      });
      expect(afterReset.people).toEqual([]);
      // The gallery's commercial snapshots are untouched (frozen terms).
      expect(snapshotOf(r.galleries[0]!)).toEqual(TERMS);

      // REVERSED order from the old cycle: B orders first this time.
      expect((await patch(A1, { selected: false })).status).toBe(200);
      expect((await patch(A3, { selected: true, selectionKind: "edited" })).status).toBe(200);

      vi.setSystemTime(new Date("2026-10-26T09:30:00.000Z"));
      expect((await submitSelection(clientBSession())).status).toBe(200);
      vi.setSystemTime(new Date("2026-10-26T10:00:00.000Z"));
      expect((await submitSelection(clientASession())).status).toBe(200);

      r = await rows();
      const after = attributeQuota(unitsNow(r), TERMS);
      expect(after.quota).toMatchObject({ selected: 4, extras: 2, surchargeCop: 10_000 });
      // B ordered FIRST this time: B's two exclusive photos take both included
      // slots, and B's shared claim plus A's replacement are the extras.
      expect(shareFor(after, B)).toMatchObject({
        included: 2,
        extras: 1,
        extrasSurchargeCop: 5_000,
        surchargeCop: 5_000,
      });
      // A — who paid an ORIGINAL charge (2 000) in the old cycle — now pays one
      // EXTRA (5 000), because the earlier arrival belongs to B. Nothing carried
      // the old attribution or priority across the reopen.
      expect(shareFor(after, A)).toMatchObject({
        included: 0,
        originals: 0,
        extras: 1,
        extrasSurchargeCop: 5_000,
        surchargeCop: 5_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Reset-originated HTTP consumers: the review's finding 4 asked specifically
// for the REAL routes, in both delivery modes, over a gallery reset by the
// REAL action — not for a gate helper called by hand. Task #287 review.
// ---------------------------------------------------------------------------
describe("reopenDeliveredGallery — reset-originated HTTP consumers (C4)", () => {
  async function finalGet(assetId: string, activeSession: Session) {
    authMock.mockResolvedValue(activeSession);
    const { GET } = await import("@/app/api/assets/[assetId]/final/route");
    return GET(new NextRequest(`http://localhost/api/assets/${assetId}/final`), {
      params: Promise.resolve({ assetId }),
    });
  }

  async function displayGet(assetId: string, activeSession: Session) {
    authMock.mockResolvedValue(activeSession);
    const { GET } = await import("@/app/api/assets/[assetId]/display/route");
    return GET(new NextRequest(`http://localhost/api/assets/${assetId}/display`), {
      params: Promise.resolve({ assetId }),
    });
  }

  async function downloadAll(activeSession: Session) {
    authMock.mockResolvedValue(activeSession);
    const { GET } = await import("@/app/api/galleries/[galleryId]/download-all/route");
    return GET(new NextRequest(`http://localhost/api/galleries/${G1}/download-all`), {
      params: Promise.resolve({ galleryId: G1 }),
    });
  }

  function resetStorageCounters() {
    presignCalls.length = 0;
    existsCalls.length = 0;
    sizeCalls.length = 0;
    streamCalls.length = 0;
  }

  it("denies final, display and ZIP from a nonrolling reset without touching storage", async () => {
    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened");
    resetStorageCounters();

    const clientFinal = await finalGet(A5, clientASession());
    expect(clientFinal.status).toBe(404);
    await expect(clientFinal.json()).resolves.toEqual({ error: "final_not_available" });

    // The admin carve-out is about the delivered leg, not about a final that
    // no longer exists.
    const adminFinal = await finalGet(A5, adminSession());
    expect(adminFinal.status).toBe(404);
    await expect(adminFinal.json()).resolves.toEqual({ error: "final_not_available" });

    const display = await displayGet(A5, clientASession());
    expect(display.status).toBe(404);
    await expect(display.json()).resolves.toEqual({ error: "display_not_available" });

    // Nonrolling: the gallery is `proofing`, so the ZIP is refused at the
    // gallery gate, before any per-asset work.
    const zip = await downloadAll(clientASession());
    expect(zip.status).toBe(404);
    await expect(zip.json()).resolves.toEqual({ error: "gallery_not_delivered" });

    // No presign, no HEAD, no stream was ever attempted for the detached old
    // objects — the denial is the DB state, not a failed probe.
    expect(presignCalls).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(sizeCalls).toEqual([]);
    expect(streamCalls).toEqual([]);
  });

  it("denies the same consumers from a ROLLING reset, with the ZIP's own empty-set error", async () => {
    const r = await rows();
    r.galleries[0]!.rollingDelivery = true;
    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened");
    resetStorageCounters();

    expect((await finalGet(A5, clientASession())).status).toBe(404);
    expect((await displayGet(A5, clientASession())).status).toBe(404);

    // Rolling keeps the gallery-level gate open in proofing, so the ZIP reaches
    // the per-asset filter and refuses because there is nothing to include —
    // the OTHER error, exactly as the approved plan distinguishes them.
    const zip = await downloadAll(clientASession());
    expect(zip.status).toBe(404);
    await expect(zip.json()).resolves.toEqual({ error: "no_finals_available" });
    expect(sizeCalls).toEqual([]);
    expect(streamCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A drainer-level exception (its own transaction failing, or the epoch
// invariant throwing) must NOT skip the email wave or the recovery result.
// Task #287 review, finding 2.
// ---------------------------------------------------------------------------
describe("reopenDeliveredGallery — a drainer-level exception is recovery state (finding 2)", () => {
  type FakeDbHandle = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    __rows: Rows;
  };

  function failTransactionAt(index: number) {
    let calls = 0;
    let real: FakeDbHandle["transaction"] | null = null;
    const install = async () => {
      const fake = (await db()) as unknown as FakeDbHandle;
      real = fake.transaction.bind(fake);
      fake.transaction = async (fn) => {
        calls += 1;
        if (calls === index) throw new Error("drain transaction failure");
        return real!(fn);
      };
    };
    const restore = async () => {
      const fake = (await db()) as unknown as FakeDbHandle;
      if (real) fake.transaction = real;
    };
    return { install, restore, calls: () => calls };
  }

  it("reports reopened_cleanup_failed, keeps the manifest and STILL emails every client", async () => {
    // Transaction #1 is the reset; #2 is the drain.
    const seam = failTransactionAt(2);
    await seam.install();
    let result;
    try {
      result = await reopen();
    } finally {
      await seam.restore();
    }
    expect(seam.calls()).toBeGreaterThanOrEqual(2);

    expect(result.status).toBe("reopened_cleanup_failed");
    expect(result.emailFailed).toBe(false);
    expect(result.message).toMatch(/no pudimos terminar de borrar/);
    const r = await rows();
    // The reset committed; the obligation is intact and still owed.
    expect(r.galleries[0]!.status).toBe("proofing");
    expect(r.galleryFinalCleanup).toHaveLength(1);
    const manifest = r.galleryFinalCleanup[0]!;
    expect((manifest.remainingKeys as string[]).length).toBe(result.remainingCleanupKeys);
    expect(objects.has(finalOf(A1, "jpg"))).toBe(true);
    // The fan-out was NOT skipped by the drain failure.
    expect(signInMock).toHaveBeenCalledTimes(2);
    expect(notifySelectionChangedMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${G1}`);
  });

  it("keeps a conservative durable remainder when the manifest write fails after the deletes", async () => {
    // The storage half SUCCEEDS and the database half then fails: the drainer
    // deletes the objects, then cannot remove the manifest row. The obligation
    // must survive as a CONSERVATIVE overestimate (all captured keys), never as
    // a clean result — retrying absent keys is safe.
    const fake = (await db()) as unknown as { delete: (table: unknown) => unknown };
    const realDelete = fake.delete.bind(fake);
    const { galleryFinalCleanup } = await import("@/lib/db/schema");
    let failedOnce = false;
    fake.delete = (table: unknown) => {
      const statement = realDelete(table) as { where: (condition: unknown) => unknown };
      if (table !== galleryFinalCleanup || failedOnce) return statement;
      return {
        where: () => {
          failedOnce = true;
          throw new Error("manifest delete failed");
        },
      };
    };
    let result;
    try {
      result = await reopen();
    } finally {
      fake.delete = realDelete;
    }
    expect(failedOnce).toBe(true);

    expect(result.status).toBe("reopened_cleanup_failed");
    const r = await rows();
    const manifest = r.galleryFinalCleanup[0]!;
    expect(manifest).toBeDefined();
    // Every captured key is still listed (an overestimate)…
    expect(result.remainingCleanupKeys).toBe((manifest.remainingKeys as string[]).length);
    // …even though the bytes are already gone, which is exactly why the retry
    // must tolerate absent objects.
    expect(objects.has(finalOf(A1, "jpg"))).toBe(false);

    // The retry resumes from that durable remainder and finishes.
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
  });

  it("reports the retry's own cleanup_failed state and revalidates", async () => {
    // First create a real pending obligation.
    deleteFailures.remaining = 1_000;
    expect((await reopen()).status).toBe("reopened_cleanup_failed");
    const r = await rows();
    const manifest = r.galleryFinalCleanup[0]!;
    deleteFailures.remaining = 0;
    revalidatePathMock.mockClear();

    // Now the retry's own transaction fails.
    const seam = failTransactionAt(1);
    await seam.install();
    const { retryReopenedFinalCleanup } = await import("./actions");
    let retried;
    try {
      retried = await retryReopenedFinalCleanup(
        { status: "idle" },
        formData({
          galleryId: G1,
          expectedEpoch: (manifest.reopenEpoch as Date).toISOString(),
        }),
      );
    } finally {
      await seam.restore();
    }

    expect(retried.status).toBe("cleanup_failed");
    expect(retried.message).toMatch(/No pudimos terminar la limpieza/);
    expect(retried.remainingCleanupKeys).toBe((manifest.remainingKeys as string[]).length);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${G1}`);
    // Nothing swept, nothing lost.
    expect((await rows()).galleryFinalCleanup).toHaveLength(1);
    expect(objects.has(finalOf(A1, "jpg"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `changed` is NOT clean. Task #287 review, finding 5.
// ---------------------------------------------------------------------------
describe("reopenDeliveredGallery — a superseded manifest is never reported clean", () => {
  it("reports reopened_cleanup_failed when the manifest belongs to another epoch", async () => {
    // Seam on the drain's own transaction: a different obligation is now the
    // pending one, so the drainer answers `changed` and deletes NOTHING.
    const fake = (await db()) as unknown as {
      transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      __rows: Rows;
    };
    const real = fake.transaction.bind(fake);
    let calls = 0;
    fake.transaction = async (fn) => {
      calls += 1;
      if (calls === 2) {
        fake.__rows.galleryFinalCleanup[0]!.reopenEpoch = new Date("2020-01-01T00:00:00.000Z");
      }
      return real(fn);
    };
    let result;
    try {
      authMock.mockResolvedValue(adminSession());
      result = await reopen();
    } finally {
      fake.transaction = real;
    }
    expect(calls).toBe(2);

    expect(result.status).toBe("reopened_cleanup_failed");
    expect(result.message).toMatch(/ya no coincide con esta reapertura/);
    const r = await rows();
    // The durable obligation is still there, with a truthful count, and not a
    // single byte was swept by a call that could not match it.
    expect(r.galleryFinalCleanup).toHaveLength(1);
    expect(result.remainingCleanupKeys).toBe(
      (r.galleryFinalCleanup[0]!.remainingKeys as string[]).length,
    );
    expect(objects.has(finalOf(A1, "jpg"))).toBe(true);
    expect(deleteObjectCalls).toEqual([]);
    expect(signInMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The reviewer's finding-1 regression, end to end: reopen with failing R2 ->
// both clients submit for real -> an ordinary unlock is refused because the
// manifest is still pending -> after R2 recovers the retry cleans -> the
// ordinary unlock now works.
// ---------------------------------------------------------------------------
describe("reopenDeliveredGallery — pending cleanup never strands the recovery path", () => {
  it("keeps ordinary unlock usable once the durable cleanup is retried", async () => {
    // 1. Reopen while every DELETE fails.
    deleteFailures.remaining = 1_000;
    authMock.mockResolvedValue(adminSession());
    expect((await reopen()).status).toBe("reopened_cleanup_failed");

    // 2. BOTH clients submit through the REAL submit route.
    expect((await submitSelection(clientASession())).status).toBe(200);
    expect((await submitSelection(clientBSession())).status).toBe(200);
    let r = await rows();
    expect(r.galleries[0]!.status).toBe("selected");
    const manifestEpoch = r.galleryFinalCleanup[0]!.reopenEpoch as Date;
    expect(manifestEpoch).toEqual(r.galleries[0]!.unlockedAt);

    // 3. An ordinary selected->proofing unlock is REFUSED: it would advance the
    // epoch the pending manifest depends on.
    authMock.mockResolvedValue(adminSession());
    const { unlockSelection, retryReopenedFinalCleanup } = await import("./actions");
    const refused = await unlockSelection({ status: "idle" }, formData({ galleryId: G1 }));
    expect(refused.status).toBe("error");
    expect(refused.message).toMatch(/limpieza de finales pendiente/);
    expect(r.galleries[0]!.unlockedAt).toEqual(manifestEpoch);

    // 4. R2 recovers; the retry cleans from the durable manifest.
    deleteFailures.remaining = 0;
    const retried = await retryReopenedFinalCleanup(
      { status: "idle" },
      formData({ galleryId: G1, expectedEpoch: manifestEpoch.toISOString() }),
    );
    expect(retried).toEqual({ status: "cleaned" });
    r = await rows();
    expect(r.galleryFinalCleanup).toEqual([]);
    expect(objects.has(finalOf(A1, "jpg"))).toBe(false);

    // 5. …and the ordinary unlock now works.
    const unlocked = await unlockSelection({ status: "idle" }, formData({ galleryId: G1 }));
    expect(unlocked.status).toBe("unlocked");
    r = await rows();
    expect(r.galleries[0]!.status).toBe("proofing");
  });
});
