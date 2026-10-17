import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Task #244 — `updateRollingDelivery`: the flag flip AND the migration of
// members who submitted under the classic (#239) flow, against the strict
// in-memory db double (it throws on any condition shape it does not model).
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

vi.mock("@/lib/db", async () => {
  const { assets, galleries, galleryClients, users } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, galleryClients, assets, users]);
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assets: fake.__tables.get(assets)!,
        users: fake.__tables.get(users)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;
type Rows = { galleries: Row[]; galleryClients: Row[]; assets: Row[]; users: Row[] };

async function rows(): Promise<Rows> {
  const { db } = (await import("@/lib/db")) as unknown as { db: { __rows: Rows } };
  return db.__rows;
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
const SUBMITTER = "client-submitted";
const ADMIN_LOCKED = "client-adminlocked";
const OPEN = "client-open";
const REMOVED = "client-removed";
const SUBMITTED_AT = new Date("2026-10-10T10:00:00Z");
const ADMIN_LOCKED_AT = new Date("2026-10-11T10:00:00Z");
const EARLIER_ORDER = new Date("2026-10-05T10:00:00Z");

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}
const toggle = (value: string, galleryId = GALLERY_ID) =>
  formDataWith({ galleryId, rollingDelivery: value });

function member(userId: string, overrides: Row = {}, galleryId = GALLERY_ID): Row {
  return {
    galleryId,
    userId,
    removedAt: null,
    selectionLockedAt: null,
    selectionSubmittedAt: null,
    ...overrides,
  };
}

function pick(id: string, selectedBy: string | null, overrides: Row = {}): Row {
  return {
    id,
    galleryId: GALLERY_ID,
    isSelected: selectedBy !== null,
    selectedBy,
    requestedAt: null,
    ...overrides,
  };
}

async function seed(status = "proofing") {
  const r = await rows();
  for (const list of Object.values(r)) list.length = 0;
  r.galleries.push(
    {
      id: GALLERY_ID,
      status,
      publicSlug: "abc123",
      rollingDelivery: false,
      selectionSubmittedAt: null,
    },
    {
      id: OTHER_GALLERY_ID,
      status: "proofing",
      publicSlug: "other",
      rollingDelivery: false,
      selectionSubmittedAt: null,
    },
  );
  r.galleryClients.push(
    // Submitted under #239: locked AND submitted.
    member(SUBMITTER, {
      selectionLockedAt: SUBMITTED_AT,
      selectionSubmittedAt: SUBMITTED_AT,
      selectionLockedBy: "client",
    }),
    // Locked by the photographer: locked, never submitted.
    member(ADMIN_LOCKED, { selectionLockedAt: ADMIN_LOCKED_AT, selectionLockedBy: "admin" }),
    member(OPEN),
    // A removed member who had submitted: not an active member, never touched.
    member(REMOVED, {
      selectionLockedAt: SUBMITTED_AT,
      selectionSubmittedAt: SUBMITTED_AT,
      selectionLockedBy: "client",
      removedAt: new Date("2026-10-12"),
    }),
    // The SAME user in ANOTHER gallery, also submitted: must never move.
    member(
      SUBMITTER,
      {
        selectionLockedAt: SUBMITTED_AT,
        selectionSubmittedAt: SUBMITTED_AT,
        selectionLockedBy: "client",
      },
      OTHER_GALLERY_ID,
    ),
  );
  // DISJOINT picks per member (a uniform fixture cannot tell whose picks got
  // stamped).
  r.assets.push(
    pick("s1", SUBMITTER),
    pick("s2", SUBMITTER),
    pick("s3", SUBMITTER, { requestedAt: EARLIER_ORDER }),
    pick("l1", ADMIN_LOCKED),
    pick("o1", OPEN),
    pick("r1", REMOVED),
    pick("free", null),
    pick("x1", SUBMITTER, { galleryId: OTHER_GALLERY_ID }),
  );
}

const byId = async (id: string) => (await rows()).assets.find((a) => a.id === id)!;
const membership = async (userId: string, galleryId = GALLERY_ID) =>
  (await rows()).galleryClients.find((m) => m.userId === userId && m.galleryId === galleryId)!;

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  revalidatePathMock.mockReset();
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  await seed();
});

describe("updateRollingDelivery authorization", () => {
  it("refuses a signed-in CLIENT with a 403, without writing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { updateRollingDelivery } = await import("./actions");
    const before = JSON.stringify(await rows());

    await expect(updateRollingDelivery({ status: "idle" }, toggle("true"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });

    expect(JSON.stringify(await rows())).toBe(before);
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const { updateRollingDelivery } = await import("./actions");

    await expect(updateRollingDelivery({ status: "idle" }, toggle("true"))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });
});

describe("updateRollingDelivery validation", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  it.each(["yes", "1", "", "TRUE"])("rejects %j as the flag value", async (value) => {
    const { updateRollingDelivery } = await import("./actions");

    const result = await updateRollingDelivery({ status: "idle" }, toggle(value));

    expect(result.status).toBe("error");
    expect((await rows()).galleries[0]).toMatchObject({ rollingDelivery: false });
  });

  it("rejects a gallery id that does not exist", async () => {
    const r = await rows();
    r.galleries.length = 0;
    const { updateRollingDelivery } = await import("./actions");

    const result = await updateRollingDelivery({ status: "idle" }, toggle("true"));

    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });
});

describe("updateRollingDelivery success", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  it.each(["draft", "proofing", "selected", "delivered", "archived"])(
    "persists the flag on a %s gallery (changeable at any status) and revalidates both surfaces",
    async (status) => {
      await seed(status);
      const { updateRollingDelivery } = await import("./actions");

      const result = await updateRollingDelivery({ status: "idle" }, toggle("true"));

      expect(result).toEqual({ status: "updated" });
      expect((await rows()).galleries[0]).toMatchObject({ rollingDelivery: true });
      expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${GALLERY_ID}`);
      expect(revalidatePathMock).toHaveBeenCalledWith("/galleries/abc123");
    },
  );
});

describe("updateRollingDelivery — migrating classic submissions when turned ON", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  it("stamps the submitted member's OWN unrequested picks with THEIR submitted_at and unlocks them, keeping submitted_at", async () => {
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("true"));

    expect((await byId("s1")).requestedAt).toBe(SUBMITTED_AT);
    expect((await byId("s2")).requestedAt).toBe(SUBMITTED_AT);
    // An earlier order keeps its ORIGINAL stamp.
    expect((await byId("s3")).requestedAt).toBe(EARLIER_ORDER);
    expect(await membership(SUBMITTER)).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: SUBMITTED_AT,
      selectionLockedBy: null,
    });
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("leaves the admin-locked member, the open member, the removed member and everyone else's picks untouched", async () => {
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("true"));

    // Admin-locked: still locked (the photographer's call), never submitted.
    expect(await membership(ADMIN_LOCKED)).toMatchObject({
      selectionLockedAt: ADMIN_LOCKED_AT,
      selectionSubmittedAt: null,
    });
    expect(await membership(OPEN)).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: null,
    });
    // Removed: not an active member.
    expect(await membership(REMOVED)).toMatchObject({ selectionLockedAt: SUBMITTED_AT });
    for (const id of ["l1", "o1", "r1", "free"]) expect((await byId(id)).requestedAt).toBeNull();
    // The same user in ANOTHER gallery: nothing moves.
    expect(await membership(SUBMITTER, OTHER_GALLERY_ID)).toMatchObject({
      selectionLockedAt: SUBMITTED_AT,
    });
    expect((await byId("x1")).requestedAt).toBeNull();
    expect((await rows()).galleries[1]).toMatchObject({ rollingDelivery: false });
  });

  it("returns a gallery that was 'selected' only because everyone submitted back to 'proofing'", async () => {
    await seed("selected");
    const r = await rows();
    // Everyone ACTIVE submitted: close the open and admin-locked members too.
    for (const m of r.galleryClients) {
      if (m.galleryId === GALLERY_ID && m.removedAt === null) {
        m.selectionLockedAt = SUBMITTED_AT;
        m.selectionSubmittedAt = SUBMITTED_AT;
        m.selectionLockedBy = "client";
      }
    }
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("true"));

    expect(r.galleries[0]).toMatchObject({ status: "proofing", rollingDelivery: true });
    expect(
      r.galleryClients.filter((m) => m.galleryId === GALLERY_ID && m.removedAt === null),
    ).toSatisfy((list: Row[]) => list.every((m) => m.selectionLockedAt === null));
  });

  it("a 'selected' gallery whose members are all ADMIN-locked stays 'selected'", async () => {
    await seed("selected");
    const r = await rows();
    for (const m of r.galleryClients) {
      if (m.galleryId === GALLERY_ID && m.removedAt === null) {
        m.selectionLockedAt = ADMIN_LOCKED_AT;
        m.selectionSubmittedAt = null;
        m.selectionLockedBy = "admin";
      }
    }
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("true"));

    expect(r.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("turning the flag OFF changes no data beyond the flag itself", async () => {
    const r = await rows();
    r.galleries[0]!.rollingDelivery = true;
    const before = JSON.stringify({ ...r, galleries: undefined });
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("false"));

    expect(r.galleries[0]).toMatchObject({ rollingDelivery: false, status: "proofing" });
    expect(JSON.stringify({ ...r, galleries: undefined })).toBe(before);
    expect(notifySelectionChangedMock).not.toHaveBeenCalled();
  });
});

// Task #244 (review 3) — the lock SOURCE is explicit, and the migration is a
// one-time false -> true transition.
describe("updateRollingDelivery — lock source and one-time transition", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  const ORDERED_AT = new Date("2026-10-12T09:00:00Z");
  const LOCKED_LATER_AT = new Date("2026-10-13T09:00:00Z");

  // A member who ORDERED under the flag (submitted_at set) and was LATER
  // locked by the photographer: both columns set, like a classic submit.
  async function seedOrderedThenAdminLocked() {
    const r = await rows();
    r.galleries[0]!.rollingDelivery = true;
    const mine = r.galleryClients.find((m) => m.userId === OPEN && m.galleryId === GALLERY_ID)!;
    mine.selectionSubmittedAt = ORDERED_AT;
    mine.selectionLockedAt = LOCKED_LATER_AT;
    mine.selectionLockedBy = "admin";
    (await byId("o1")).requestedAt = ORDERED_AT;
  }

  it("toggling OFF then ON keeps a member who ordered and was then locked by the photographer LOCKED, and stamps nothing", async () => {
    await seedOrderedThenAdminLocked();
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("false"));
    await updateRollingDelivery({ status: "idle" }, toggle("true"));

    expect(await membership(OPEN)).toMatchObject({
      selectionLockedAt: LOCKED_LATER_AT,
      selectionSubmittedAt: ORDERED_AT,
      selectionLockedBy: "admin",
    });
    expect((await byId("o1")).requestedAt).toBe(ORDERED_AT);
  });

  it("turning the flag OFF leaves EVERY member and asset row unchanged (locked, submitted, ordered, admin-locked)", async () => {
    await seedOrderedThenAdminLocked();
    const r = await rows();
    r.galleries[0]!.status = "selected";
    (await byId("s1")).requestedAt = ORDERED_AT;
    const before = JSON.stringify({ ...r, galleries: undefined });
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("false"));

    expect(JSON.stringify({ ...r, galleries: undefined })).toBe(before);
    expect(r.galleries[0]).toMatchObject({ rollingDelivery: false, status: "selected" });
  });

  it("re-sending true on a gallery whose flag is ALREADY on (a stale tab) changes nothing", async () => {
    const r = await rows();
    r.galleries[0]!.rollingDelivery = true;
    const before = JSON.stringify({ ...r, galleries: undefined });
    const { updateRollingDelivery } = await import("./actions");

    await updateRollingDelivery({ status: "idle" }, toggle("true"));

    expect(JSON.stringify({ ...r, galleries: undefined })).toBe(before);
    expect(notifySelectionChangedMock).not.toHaveBeenCalled();
  });

  it.each(["draft", "delivered", "archived"])(
    "enabling on a %s gallery sets the flag but migrates nobody",
    async (status) => {
      await seed(status);
      const r = await rows();
      const before = JSON.stringify({ ...r, galleries: undefined });
      const { updateRollingDelivery } = await import("./actions");

      await updateRollingDelivery({ status: "idle" }, toggle("true"));

      expect(r.galleries[0]).toMatchObject({ rollingDelivery: true });
      expect(JSON.stringify({ ...r, galleries: undefined })).toBe(before);
    },
  );
});
