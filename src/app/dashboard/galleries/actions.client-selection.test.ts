import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Epic #239 / task #242 — the three admin per-client selection actions
// (lock, unlock, remove picks) against the strict in-memory db double.
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

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const A = "client-a";
const B = "client-b";
const C = "client-c";
const T0 = new Date("2026-07-10T10:00:00Z");

function formDataWith(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}
const form = (clientId: string, galleryId = G1) => formDataWith({ galleryId, clientId });

function member(galleryId: string, userId: string, overrides: Row = {}): Row {
  return {
    galleryId,
    userId,
    removedAt: null,
    selectionLockedAt: null,
    selectionSubmittedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

function asset(id: string, galleryId: string, billedTo: string | null, kind = "edited"): Row {
  return {
    id,
    galleryId,
    isSelected: billedTo !== null,
    billedTo,
    selectedAt: billedTo ? T0 : null,
    selectionKind: kind,
  };
}

function gallery(id: string, overrides: Row = {}): Row {
  return {
    id,
    status: "proofing",
    publicSlug: `slug-${id.slice(0, 4)}`,
    selectionSubmittedAt: null,
    ...overrides,
  };
}

async function seed(opts: { g1Status?: string } = {}) {
  const r = await rows();
  for (const list of Object.values(r)) list.length = 0;
  // Gallery 1: three clients A (2 picks, one of them an `original`), B (1 pick), C (none).
  r.galleries.push(gallery(G1, { status: opts.g1Status ?? "proofing" }), gallery(G2));
  r.galleryClients.push(
    member(G1, A),
    member(G1, B),
    member(G1, C),
    // Gallery 2: the SAME user ids, with their own state that must never move.
    member(G2, A, { selectionLockedAt: T0, selectionSubmittedAt: T0 }),
    member(G2, B),
  );
  r.assets.push(
    asset("a1", G1, A),
    asset("a2", G1, A, "original"),
    asset("b1", G1, B),
    asset("free", G1, null),
    asset("x-a", G2, A),
    asset("x-b", G2, B),
  );
  r.users.push({ id: A, email: "a@example.com" }, { id: B, email: "b@example.com" });
}

const snapshot = async () => JSON.stringify(await rows());

beforeEach(async () => {
  authMock.mockReset();
  signInMock.mockReset();
  signInMock.mockResolvedValue(undefined);
  revalidatePathMock.mockReset();
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  await seed();
});

const ACTIONS = [
  "lockGalleryClientSelection",
  "unlockGalleryClientSelection",
  "removeGalleryClientPicks",
] as const;

async function actionByName(name: (typeof ACTIONS)[number]) {
  return (await import("./actions"))[name];
}

describe.each(ACTIONS)("%s — refusals", (name) => {
  // For each action, a state in which its OWN precondition holds, so the
  // refusal under test is the guard and not the precondition.
  async function prepare() {
    const r = await rows();
    if (name === "unlockGalleryClientSelection") {
      Object.assign(
        r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!,
        {
          selectionLockedAt: T0,
          selectionSubmittedAt: T0,
        },
      );
    }
  }

  it("refuses a signed-in CLIENT (403) and writes nothing", async () => {
    await prepare();
    authMock.mockResolvedValue(clientSession());
    const before = await snapshot();
    const action = await actionByName(name);

    await expect(action({ status: "idle" }, form(A))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    expect(await snapshot()).toBe(before);
    expect(signInMock).not.toHaveBeenCalled();
    expect(notifySelectionChangedMock).not.toHaveBeenCalled();
  });

  it("redirects to /login without a session", async () => {
    authMock.mockResolvedValue(null);
    const action = await actionByName(name);
    await expect(action({ status: "idle" }, form(A))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });

  it("rejects a malformed galleryId and an empty clientId", async () => {
    authMock.mockResolvedValue(adminSession());
    const action = await actionByName(name);
    expect((await action({ status: "idle" }, form(A, "not-a-uuid"))).status).toBe("error");
    expect((await action({ status: "idle" }, form("  "))).status).toBe("error");
  });

  it("refuses a gallery that does not exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const action = await actionByName(name);
    const result = await action(
      { status: "idle" },
      form(A, "33333333-3333-4333-8333-333333333333"),
    );
    expect(result).toEqual({ status: "error", message: "La galería no existe." });
  });

  it.each(["draft", "delivered", "archived"])(
    "refuses a %s gallery and writes nothing",
    async (status) => {
      await prepare();
      const r = await rows();
      r.galleries.find((g) => g.id === G1)!.status = status;
      authMock.mockResolvedValue(adminSession());
      const before = await snapshot();
      const action = await actionByName(name);

      const result = await action({ status: "idle" }, form(A));

      expect(result.status).toBe("error");
      expect(await snapshot()).toBe(before);
      expect(signInMock).not.toHaveBeenCalled();
      expect(notifySelectionChangedMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a REMOVED client and a user never attached, writing nothing", async () => {
    await prepare();
    const r = await rows();
    r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!.removedAt = T0;
    authMock.mockResolvedValue(adminSession());
    const before = await snapshot();
    const action = await actionByName(name);

    for (const clientId of [A, "never-attached"]) {
      const result = await action({ status: "idle" }, form(clientId));
      expect(result).toEqual({
        status: "error",
        message: "Ese cliente ya no está activo en esta galería.",
      });
    }
    expect(await snapshot()).toBe(before);
  });

  it("refuses a client active on ANOTHER gallery only (membership is per gallery)", async () => {
    const r = await rows();
    r.galleryClients.length = 0;
    r.galleryClients.push(member(G1, B), member(G2, A));
    authMock.mockResolvedValue(adminSession());
    const before = await snapshot();
    const action = await actionByName(name);

    const result = await action({ status: "idle" }, form(A, G1));

    expect(result.status).toBe("error");
    expect(await snapshot()).toBe(before);
  });
});

describe("lockGalleryClientSelection", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  it("locks only that client: lock set, submitted NULL, gallery stays proofing, others untouched", async () => {
    const { lockGalleryClientSelection } = await import("./actions");
    const result = await lockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    const r = await rows();
    const mine = r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!;
    expect(mine.selectionLockedAt).toBeInstanceOf(Date);
    expect(mine.selectionSubmittedAt).toBeNull();
    expect(r.galleryClients.find((m) => m.galleryId === G1 && m.userId === B)!).toMatchObject({
      selectionLockedAt: null,
    });
    // Same user on the other gallery keeps its own state.
    expect(r.galleryClients.find((m) => m.galleryId === G2 && m.userId === A)!).toMatchObject({
      selectionLockedAt: T0,
      selectionSubmittedAt: T0,
    });
    expect(r.galleries.find((g) => g.id === G1)!.status).toBe("proofing");
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(G1);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/galleries/${G1}`);
  });

  // Task #244 — the lock SOURCE is written explicitly. A member who ordered
  // (submitted_at set, locked_at null under rolling delivery) and is then
  // locked by the photographer must read 'admin', not look like a client submit.
  it("records WHO locked: 'admin', even for a member who already has a submitted_at", async () => {
    const r = await rows();
    const mine = r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!;
    mine.selectionSubmittedAt = T0;
    const { lockGalleryClientSelection } = await import("./actions");

    await lockGalleryClientSelection({ status: "idle" }, form(A));

    expect(mine).toMatchObject({ selectionSubmittedAt: T0, selectionLockedBy: "admin" });
    expect(mine.selectionLockedAt).toBeInstanceOf(Date);
  });

  it("locking the LAST open client moves the gallery to selected", async () => {
    const r = await rows();
    for (const id of [A, B]) {
      Object.assign(
        r.galleryClients.find((m) => m.galleryId === G1 && m.userId === id)!,
        {
          selectionLockedAt: T0,
          selectionSubmittedAt: T0,
        },
      );
    }
    const { lockGalleryClientSelection } = await import("./actions");

    await lockGalleryClientSelection({ status: "idle" }, form(C));

    const g1 = r.galleries.find((g) => g.id === G1)!;
    expect(g1.status).toBe("selected");
    expect(g1.selectionSubmittedAt).toBeInstanceOf(Date);
    // The other gallery is not settled by this action.
    expect(r.galleries.find((g) => g.id === G2)!.status).toBe("proofing");
  });

  it("refuses an already-locked client and leaves its submitted stamp alone", async () => {
    const r = await rows();
    Object.assign(
      r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!,
      {
        selectionLockedAt: T0,
        selectionSubmittedAt: T0,
      },
    );
    const before = await snapshot();
    const { lockGalleryClientSelection } = await import("./actions");

    const result = await lockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("error");
    expect(await snapshot()).toBe(before);
  });

  it("takes the gallery row lock before reading anything else in the transaction", async () => {
    const { db } = (await import("@/lib/db")) as unknown as { db: { __log: string[] } };
    db.__log.length = 0;
    const { lockGalleryClientSelection } = await import("./actions");

    await lockGalleryClientSelection({ status: "idle" }, form(A));

    expect(db.__log[0]).toBe("for:update");
  });
});

describe("unlockGalleryClientSelection", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  function lockedA(r: Rows, submitted: boolean) {
    Object.assign(
      r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!,
      {
        selectionLockedAt: T0,
        selectionSubmittedAt: submitted ? T0 : null,
      },
    );
  }

  it("clears selection_locked_by together with the lock", async () => {
    const r = await rows();
    lockedA(r, true);
    const mine = r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!;
    mine.selectionLockedBy = "admin";
    const { unlockGalleryClientSelection } = await import("./actions");

    await unlockGalleryClientSelection({ status: "idle" }, form(A));

    expect(mine).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: null,
      selectionLockedBy: null,
    });
  });

  it("clears BOTH columns of that client only and emails THAT client", async () => {
    const r = await rows();
    lockedA(r, true);
    Object.assign(
      r.galleryClients.find((m) => m.galleryId === G1 && m.userId === B)!,
      {
        selectionLockedAt: T0,
        selectionSubmittedAt: T0,
      },
    );
    const { unlockGalleryClientSelection } = await import("./actions");

    const result = await unlockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: null,
    });
    expect(r.galleryClients.find((m) => m.galleryId === G1 && m.userId === B)!).toMatchObject({
      selectionLockedAt: T0,
      selectionSubmittedAt: T0,
    });
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith("gallery-unlock", {
      email: "a@example.com",
      redirect: false,
      redirectTo: "/galleries/slug-1111",
    });
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(G1);
  });

  it("emails the client being unlocked even when another client sorts first in users", async () => {
    // `users` lists A before B, and A is locked too: a lookup that is not
    // scoped to the unlocked client's id would pick A's address.
    const r = await rows();
    lockedA(r, true);
    Object.assign(
      r.galleryClients.find((m) => m.galleryId === G1 && m.userId === B)!,
      {
        selectionLockedAt: T0,
        selectionSubmittedAt: T0,
      },
    );
    const { unlockGalleryClientSelection } = await import("./actions");

    await unlockGalleryClientSelection({ status: "idle" }, form(B));

    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock.mock.calls[0]![1]).toMatchObject({ email: "b@example.com" });
  });

  it("unlocking one client of a selected gallery moves it back to proofing", async () => {
    const r = await rows();
    r.galleries.find((g) => g.id === G1)!.status = "selected";
    for (const id of [A, B, C]) {
      Object.assign(
        r.galleryClients.find((m) => m.galleryId === G1 && m.userId === id)!,
        {
          selectionLockedAt: T0,
          selectionSubmittedAt: T0,
        },
      );
    }
    const { unlockGalleryClientSelection } = await import("./actions");

    await unlockGalleryClientSelection({ status: "idle" }, form(B));

    expect(r.galleries.find((g) => g.id === G1)!.status).toBe("proofing");
    expect(
      r.galleryClients.filter((m) => m.galleryId === G1 && m.selectionLockedAt !== null),
    ).toHaveLength(2);
  });

  it("unlocks an admin-locked client (submitted NULL) too", async () => {
    const r = await rows();
    lockedA(r, false);
    const { unlockGalleryClientSelection } = await import("./actions");

    const result = await unlockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a client that is not locked, without emailing", async () => {
    const before = await snapshot();
    const { unlockGalleryClientSelection } = await import("./actions");

    const result = await unlockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("error");
    expect(await snapshot()).toBe(before);
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("reports a failed email as done_email_failed and keeps the unlock", async () => {
    const r = await rows();
    lockedA(r, true);
    const { AuthError } = await import("next-auth");
    signInMock.mockRejectedValue(new AuthError("resend down"));
    const { unlockGalleryClientSelection } = await import("./actions");

    const result = await unlockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("done_email_failed");
    expect(result.message).toContain("a@example.com");
    expect(r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!).toMatchObject({
      selectionLockedAt: null,
    });
  });
});

describe("removeGalleryClientPicks", () => {
  beforeEach(() => authMock.mockResolvedValue(adminSession()));

  it("deselects ONLY that client's assets of THIS gallery and resets them like a deselect", async () => {
    const { removeGalleryClientPicks } = await import("./actions");

    const result = await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(result.message).toContain("2 fotos");
    const r = await rows();
    const byId = (id: string) => r.assets.find((a) => a.id === id)!;
    for (const id of ["a1", "a2"]) {
      expect(byId(id)).toMatchObject({
        isSelected: false,
        selectedAt: null,
        billedTo: null,
        selectionKind: "edited",
      });
    }
    // Another client's pick on the same gallery: untouched.
    expect(byId("b1")).toMatchObject({ isSelected: true, billedTo: B, selectedAt: T0 });
    // The SAME users' picks on another gallery: untouched.
    expect(byId("x-a")).toMatchObject({ isSelected: true, billedTo: A });
    expect(byId("x-b")).toMatchObject({ isSelected: true, billedTo: B });
    expect(byId("free")).toMatchObject({ isSelected: false, billedTo: null });
  });

  it("clears requestedAt on the removed picks (task #244 lockstep) and leaves other people's orders alone", async () => {
    const r = await rows();
    const ORDERED = new Date("2026-10-16T09:00:00.000Z");
    for (const id of ["a1", "b1"]) r.assets.find((a) => a.id === id)!.requestedAt = ORDERED;
    const { removeGalleryClientPicks } = await import("./actions");

    await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(r.assets.find((a) => a.id === "a1")!.requestedAt).toBeNull();
    expect(r.assets.find((a) => a.id === "b1")!.requestedAt).toBe(ORDERED);
  });

  it("clears both lock columns of that client only (other client and other gallery keep theirs)", async () => {
    const r = await rows();
    for (const id of [A, B]) {
      Object.assign(
        r.galleryClients.find((m) => m.galleryId === G1 && m.userId === id)!,
        {
          selectionLockedAt: T0,
          selectionSubmittedAt: T0,
        },
      );
    }
    const { removeGalleryClientPicks } = await import("./actions");

    await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: null,
    });
    expect(r.galleryClients.find((m) => m.galleryId === G1 && m.userId === B)!).toMatchObject({
      selectionLockedAt: T0,
    });
    expect(r.galleryClients.find((m) => m.galleryId === G2 && m.userId === A)!).toMatchObject({
      selectionLockedAt: T0,
      selectionSubmittedAt: T0,
    });
  });

  it("reopens a selected gallery (selected -> proofing) and never emails", async () => {
    const r = await rows();
    r.galleries.find((g) => g.id === G1)!.status = "selected";
    for (const id of [A, B, C]) {
      Object.assign(
        r.galleryClients.find((m) => m.galleryId === G1 && m.userId === id)!,
        {
          selectionLockedAt: T0,
          selectionSubmittedAt: T0,
        },
      );
    }
    const { removeGalleryClientPicks } = await import("./actions");

    await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(r.galleries.find((g) => g.id === G1)!.status).toBe("proofing");
    expect(signInMock).not.toHaveBeenCalled();
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(G1);
  });

  it("does not touch a removed client's picks of the same gallery id", async () => {
    // B removed from G1: B's attribution stays historical; acting on A must not matter,
    // and acting on B is refused (covered above) — here A's run leaves B's pick intact.
    const r = await rows();
    r.galleryClients.find((m) => m.galleryId === G1 && m.userId === B)!.removedAt = T0;
    const { removeGalleryClientPicks } = await import("./actions");

    await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(r.assets.find((a) => a.id === "b1")).toMatchObject({ isSelected: true, billedTo: B });
  });

  it("with zero picks still succeeds and says 0 fotos", async () => {
    const { removeGalleryClientPicks } = await import("./actions");
    const result = await removeGalleryClientPicks({ status: "idle" }, form(C));
    expect(result.status).toBe("done");
    expect(result.message).toContain("0 fotos");
  });
});
describe.each(ACTIONS)("%s — lock order", (name) => {
  it("its FIRST db operation is the gallery row lock, before any membership read", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await rows();
    // Unlock needs a locked client; harmless for the other two.
    Object.assign(
      r.galleryClients.find((m) => m.galleryId === G1 && m.userId === A)!,
      {
        selectionLockedAt: name === "lockGalleryClientSelection" ? null : T0,
        selectionSubmittedAt: name === "lockGalleryClientSelection" ? null : T0,
      },
    );
    const { db } = (await import("@/lib/db")) as unknown as { db: { __log: string[] } };
    db.__log.length = 0;
    const action = await actionByName(name);

    const result = await action({ status: "idle" }, form(A));

    expect(result.status).not.toBe("error");
    expect(db.__log[0]).toBe("for:update");
  });
});
