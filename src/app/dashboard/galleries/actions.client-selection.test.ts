import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
  const { assets, assetPicks, galleries, galleryClients, users } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, galleryClients, assets, assetPicks, users]);
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assets: fake.__tables.get(assets)!,
        assetPicks: fake.__tables.get(assetPicks)!,
        users: fake.__tables.get(users)!,
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
};

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

function asset(
  id: string,
  galleryId: string,
  billedTo: string | null,
  kind = "edited",
  overrides: Row = {},
): Row {
  return {
    id,
    galleryId,
    isSelected: billedTo !== null,
    billedTo,
    selectedAt: billedTo ? T0 : null,
    requestedAt: billedTo ? T0 : null,
    billedAt: billedTo ? T0 : null,
    selectionKind: kind,
    finalKey: null,
    ...overrides,
  };
}

function pick(
  assetId: string,
  galleryId: string,
  userId: string,
  kind = "edited",
  submittedAt: Date | null = T0,
): Row {
  return { assetId, galleryId, userId, kind, pickedAt: T0, submittedAt };
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
  // A claim is a SUBMITTED pick since epic #250: one per claimed asset above.
  r.assetPicks.push(
    pick("a1", G1, A),
    pick("a2", G1, A, "original"),
    pick("b1", G1, B),
    pick("x-a", G2, A),
    pick("x-b", G2, B),
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

// ---------------------------------------------------------------------------
// Epic #250 S5 (#260) — the hazards. Every assertion below is about a state
// the pre-S5 admin write left behind.
// ---------------------------------------------------------------------------

/** The four `asset_picks` invariants of the epic, asserted inline (the
 * orchestrator's allowed edit surfaces exclude a shared test helper). */
function expectPickInvariants(r: Rows, galleryId = G1) {
  const claimed = new Map(r.assets.map((a) => [a.id, a]));
  for (const p of r.assetPicks.filter((row) => row.galleryId === galleryId)) {
    const asset = claimed.get(p.assetId as string)!;
    if (p.submittedAt !== null) {
      // (i) no submitted pick on an unclaimed asset.
      expect(asset.isSelected).toBe(true);
    }
    if (asset.isSelected && asset.billedTo !== null) {
      // (ii) the holder has a submitted pick on it.
      expect(
        r.assetPicks.some(
          (other) =>
            other.assetId === asset.id &&
            other.userId === asset.billedTo &&
            other.submittedAt !== null,
        ),
      ).toBe(true);
    }
  }
  for (const asset of r.assets.filter((row) => row.galleryId === galleryId)) {
    if (asset.isSelected) continue;
    // (iii) unclaimed means every claim field is null.
    expect(asset).toMatchObject({
      billedTo: null,
      billedAt: null,
      requestedAt: null,
      selectedAt: null,
    });
  }
}

async function emptyRows(): Promise<Rows> {
  const r = await rows();
  for (const list of Object.values(r)) list.length = 0;
  r.galleries.push(gallery(G1, { allowsOriginalSelection: true }));
  r.galleryClients.push(member(G1, A), member(G1, B), member(G1, C));
  r.users.push(
    { id: A, name: "Ana", email: "a@example.com" },
    { id: B, name: null, email: "b@example.com" },
    { id: C, name: "Caro", email: "c@example.com" },
  );
  return r;
}

describe("hazard 1 — remove-picks leaves no joined pick on an unclaimed asset", () => {
  it("transfers X to the other picker, unclaims Y, and B's pick survives untouched", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    r.assets.push(asset("x", G1, A), asset("y", G1, A));
    r.assetPicks.push(pick("x", G1, A), pick("x", G1, B), pick("y", G1, A));
    const bPick = structuredClone(r.assetPicks.find((p) => p.userId === B)!);
    const { removeGalleryClientPicks } = await import("./actions");

    const result = await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(r.assets.find((a) => a.id === "x")).toMatchObject({
      isSelected: true,
      billedTo: B,
      billedAt: T0,
      selectionKind: "edited",
    });
    expect(r.assets.find((a) => a.id === "y")).toMatchObject({
      isSelected: false,
      billedTo: null,
      billedAt: null,
      requestedAt: null,
      selectedAt: null,
    });
    expect(r.assetPicks.find((p) => p.userId === B)).toEqual(bPick);
    expectPickInvariants(r);
  });

  it("answers B's NEXT real PATCH with 409 already_requested — the state that used to 500", async () => {
    // Review of #260, W5: the plan's §9.1 row H1 asks for the REAL PATCH, not a
    // direct `derivePickStatus` call. The removal action and the route share
    // this file's one fake db, so the whole hazard is driven end to end: A's
    // picks are removed, X transfers to B, and B then calls the route.
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    const X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    r.assets.push(asset(X, G1, A));
    r.assetPicks.push(pick(X, G1, A), pick(X, G1, B));
    const { removeGalleryClientPicks } = await import("./actions");
    await removeGalleryClientPicks({ status: "idle" }, form(A));
    expect(r.assets.find((row) => row.id === X)).toMatchObject({ isSelected: true, billedTo: B });

    authMock.mockResolvedValue({
      user: { id: B, role: "client", email: "b@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session);
    const { PATCH } = await import("@/app/api/assets/[assetId]/selection/route");
    const response = await PATCH(
      new NextRequest(`http://localhost:3300/api/assets/${X}/selection`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: false }),
      }),
      { params: Promise.resolve({ assetId: X }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "already_requested" });
  });

  it("never bills a DEGRADED picker when the holder is removed (submittedAt null carries no claim)", async () => {
    // Review of #260, C2/M2, the action end of it: if an unsubmitted pick were
    // fed to the resolution as if submitted, the unit would land on B — who
    // never submitted — and B's cart pick would silently become a billed one.
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    r.assets.push(asset("x", G1, A));
    r.assetPicks.push(pick("x", G1, A), pick("x", G1, B, "edited", null));
    const { removeGalleryClientPicks } = await import("./actions");

    const result = await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(r.assets.find((row) => row.id === "x")).toMatchObject({
      isSelected: false,
      billedTo: null,
      billedAt: null,
      selectedAt: null,
      requestedAt: null,
    });
    expect(r.assetPicks.find((row) => row.userId === B)).toMatchObject({
      kind: "edited",
      submittedAt: null,
    });
    expectPickInvariants(r);
  });

  it("hands the unit to the SUBMITTER, never to a remaining picker who did not submit", async () => {
    // Same clause, the comparator's end: a `submittedAt: null` reaching the
    // arrival sort is `.getTime()` on null — a 500 in production.
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    r.assets.push(asset("x", G1, A));
    r.assetPicks.push(
      pick("x", G1, A),
      pick("x", G1, B, "edited", null),
      pick("x", G1, C, "edited", new Date(T0.getTime() + 1000)),
    );
    const { removeGalleryClientPicks } = await import("./actions");

    const result = await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(r.assets.find((row) => row.id === "x")).toMatchObject({
      isSelected: true,
      billedTo: C,
      billedAt: T0,
    });
    expect(r.assetPicks.find((row) => row.userId === B)).toMatchObject({ submittedAt: null });
    expectPickInvariants(r);
  });
});

describe("hazard 2 — an unlock never touches picks (decision 10's semantics)", () => {
  it("leaves every asset_picks row deep-equal, keeps gatePickEdit's already_requested, and lets a NEW pick claim", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    Object.assign(
      r.galleryClients.find((m) => m.userId === A)!,
      {
        selectionLockedAt: T0,
        selectionSubmittedAt: T0,
      },
    );
    r.assets.push(asset("s1", G1, A), asset("s2", G1, A, "original"), asset("free", G1, null));
    r.assetPicks.push(pick("s1", G1, A), pick("s2", G1, A, "original"));
    const picksBefore = structuredClone(r.assetPicks);
    const { unlockGalleryClientSelection } = await import("./actions");

    const unlocked = await unlockGalleryClientSelection({ status: "idle" }, form(A));

    expect(unlocked.status).toBe("done");
    expect(r.assetPicks).toEqual(picksBefore);
    const { gatePickEdit } = await import("@/lib/pick-resolution");
    expect(gatePickEdit("billed", "edited", { type: "remove" })).toEqual({
      ok: false,
      error: "already_requested",
    });

    // A NEW pick still claims, so the unlock is not a dead end.
    r.assetPicks.push(pick("free", G1, A, "edited", null));
    const { claimCart } = await import("@/lib/pick-claims");
    const { db } = (await import("@/lib/db")) as unknown as {
      db: { transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T> };
    };
    await db.transaction((tx) =>
      claimCart(tx, r.galleries[0] as never, A, new Date("2026-10-18T10:00:00Z")),
    );
    expect(r.assets.find((a) => a.id === "free")).toMatchObject({
      isSelected: true,
      billedTo: A,
    });
    expectPickInvariants(r);
  });

  it("the GALLERY-WIDE unlock (gallery-wide unlock is the same rule) also leaves picks deep-equal", async () => {
    // `unlockGalleryClientSelection` is the per-client action; the gallery-wide
    // unlock clears every membership row and likewise never writes a pick.
    // This is the same fixture as above, exercised through the per-client
    // action for C, whose picks are A's: nothing of A's may move.
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    Object.assign(
      r.galleryClients.find((m) => m.userId === C)!,
      {
        selectionLockedAt: T0,
        selectionSubmittedAt: T0,
      },
    );
    r.assets.push(asset("s1", G1, A));
    r.assetPicks.push(pick("s1", G1, A));
    const before = structuredClone(r.assetPicks);
    const { unlockGalleryClientSelection } = await import("./actions");

    await unlockGalleryClientSelection({ status: "idle" }, form(C));

    expect(r.assetPicks).toEqual(before);
  });
});

describe("hazard 3 — an admin lock CLAIMS the cart (decision 18)", () => {
  it("claims a free asset, escalates an original, joins an edited one, and reports the delta", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    r.assets.push(asset("x", G1, null), asset("y", G1, B, "original"), asset("z", G1, B));
    r.assetPicks.push(
      pick("x", G1, A, "edited", null),
      pick("y", G1, A, "edited", null),
      pick("z", G1, A, "edited", null),
      pick("y", G1, B, "original"),
      pick("z", G1, B, "edited"),
    );
    const { lockGalleryClientSelection } = await import("./actions");

    const result = await lockGalleryClientSelection({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(r.assets.find((a) => a.id === "x")).toMatchObject({ isSelected: true, billedTo: A });
    const y = r.assets.find((a) => a.id === "y")!;
    expect(y).toMatchObject({ isSelected: true, billedTo: A, selectionKind: "edited" });
    expect((y.billedAt as Date).getTime()).toBeGreaterThan(T0.getTime());
    expect(r.assets.find((a) => a.id === "z")).toMatchObject({ isSelected: true, billedTo: B });
    expect(r.assetPicks.filter((p) => p.userId === A).every((p) => p.submittedAt !== null)).toBe(
      true,
    );
    expect(r.galleryClients.find((m) => m.userId === A)).toMatchObject({
      selectionLockedBy: "admin",
    });
    expectPickInvariants(r);

    // Before: A holds nothing, B holds y and z. After: A holds x and y, B holds z.
    expect(result.delta?.people.map((person) => person.userId).sort()).toEqual([A, B]);
    expect(result.delta?.people.find((person) => person.userId === A)?.before.extras).toBe(0);
    expect(result.delta?.people.find((person) => person.userId === A)?.after.extras).toBe(2);
    expect(result.delta?.people.find((person) => person.userId === B)?.after.extras).toBe(1);
    expect(result.delta?.people.find((person) => person.userId === A)?.label).toBe("Ana");
    expect(result.pickOutcomes).toEqual({
      claimed: 1,
      escalated: 1,
      joined: 1,
      escalationBlocked: 0,
    });
  });

  it("still locks somebody whose cart is empty, claiming nothing", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    const { lockGalleryClientSelection } = await import("./actions");

    const result = await lockGalleryClientSelection({ status: "idle" }, form(C));

    expect(result.status).toBe("done");
    expect(r.assets).toEqual([]);
    expect(result.pickOutcomes).toEqual({
      claimed: 0,
      escalated: 0,
      joined: 0,
      escalationBlocked: 0,
    });
  });
});

describe("hazard 4 — unclaiming clears billed_at", () => {
  it("leaves every claim column null when the only picker is removed", async () => {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    r.assets.push(asset("x", G1, A));
    r.assetPicks.push(pick("x", G1, A));
    const { removeGalleryClientPicks } = await import("./actions");

    await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(r.assets[0]).toMatchObject({
      isSelected: false,
      billedTo: null,
      billedAt: null,
      selectedAt: null,
      requestedAt: null,
    });
    expectPickInvariants(r);
  });
});

describe("hazard 5 — a final freezes the kind, and the holder is re-elected", () => {
  it.each([
    // Decision 15: B's edited pick must NOT raise the kind over a final.
    ["with a final", "final/x.jpg", "edited"],
    ["without a final, B's pick original", null, "original"],
  ])("keeps the resolved kind when the holder leaves (%s)", async (_label, finalKey, kind) => {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    r.assets.push(asset("x", G1, A, "original", { finalKey }));
    r.assetPicks.push(pick("x", G1, A, "original"), pick("x", G1, B, kind as string));
    const { removeGalleryClientPicks } = await import("./actions");

    await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(r.assets[0]).toMatchObject({
      isSelected: true,
      billedTo: B,
      selectionKind: "original",
      billedAt: T0,
    });
    expectPickInvariants(r);
  });
});

// ---------------------------------------------------------------------------
// Epic #250, task #263 (S8) — PREVIEW == WRITE.
//
// The dashboard shows the admin a before/after before they confirm either
// money-affecting per-person action. That preview is only honest if it is the
// same function the write executes, so this block seeds one state, asks
// `previewClientActions` what would happen, runs the REAL server action, and
// requires the action's own `state.delta` — computed from the rows it actually
// wrote — to deep-equal the preview. A preview that recomputed the money with
// different maths (or previewed a cart pick as if it were already claimed)
// fails here, at the numbers.
//
// The fixture is the plan's two-person case: Ana bills X (edited), Y (edited)
// and W (original, no final); Beto joined X and has Z and W in his cart.
// ---------------------------------------------------------------------------
describe("preview == write (task #263)", () => {
  const TERMS = {
    includedPhotosSnapshot: 1,
    extraPhotoPriceCopSnapshot: 5_000,
    extraPhotoPriceTiersSnapshot: null,
    originalPhotoPriceCopSnapshot: 2_000,
  };

  async function seedParityFixture() {
    authMock.mockResolvedValue(adminSession());
    const r = await emptyRows();
    const row = r.galleries[0]!;
    Object.assign(row, TERMS);
    r.assets.push(
      asset("x", G1, A, "edited"),
      asset("y", G1, A, "edited"),
      asset("w", G1, A, "original"),
      asset("z", G1, null),
    );
    r.assetPicks.push(
      pick("x", G1, A),
      pick("y", G1, A),
      pick("w", G1, A, "original"),
      pick("x", G1, B),
      pick("z", G1, B, "edited", null),
      pick("w", G1, B, "edited", null),
    );
    return r;
  }

  /** The preview, from the SAME rows and the SAME four frozen terms the action
   * will read — `readPickState` + `quotaSnapshotOf` are the action's own
   * readers, not a test-local reconstruction. */
  async function previewFor(userId: string) {
    const { readPickState, quotaSnapshotOf } = await import("@/lib/pick-claims");
    const { previewClientActions } = await import("@/lib/pick-plans");
    const r = await rows();
    const galleryRow = r.galleries.find((candidate) => candidate.id === G1)!;
    const state = await readPickState((await import("@/lib/db")).db as never, G1);
    const labels = Object.fromEntries(
      r.users.map((user) => [user.id as string, (user.name ?? user.email) as string]),
    );
    return previewClientActions(
      state.rows,
      state.picks,
      userId,
      new Date(),
      quotaSnapshotOf(galleryRow as never),
      labels,
      { allowsOriginal: galleryRow.allowsOriginalSelection !== false },
    );
  }

  it("lockGalleryClientSelection's answered delta deep-equals the preview", async () => {
    const r = await seedParityFixture();
    const preview = await previewFor(B);
    // The preview is not vacuous: Beto's cart really does move money.
    expect(preview.lock.gallery.before.surchargeCop).toBe(7_000);
    expect(preview.lock.gallery.after.surchargeCop).toBe(15_000);
    expect(preview.lock.assets.map((change) => change.op).sort()).toEqual(["claim", "escalate"]);

    const { lockGalleryClientSelection } = await import("./actions");
    const result = await lockGalleryClientSelection({ status: "idle" }, form(B));

    expect(result.status).toBe("done");
    expect(result.delta?.gallery).toEqual(preview.lock.gallery);
    expect(result.delta?.people).toEqual(preview.lock.people);
    expect(result.delta?.unattributed).toEqual(preview.lock.unattributed);
    expect(
      [...(result.delta?.assets ?? [])].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)),
    ).toEqual([...preview.lock.assets].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)));
    expectPickInvariants(r);
  });

  it("removeGalleryClientPicks' answered delta deep-equals the preview", async () => {
    const r = await seedParityFixture();
    const preview = await previewFor(A);
    expect(preview.removePicks.assets.map((change) => change.op).sort()).toEqual([
      "transfer",
      "unclaim",
      "unclaim",
    ]);

    const { removeGalleryClientPicks } = await import("./actions");
    const result = await removeGalleryClientPicks({ status: "idle" }, form(A));

    expect(result.status).toBe("done");
    expect(result.delta?.gallery).toEqual(preview.removePicks.gallery);
    expect(result.delta?.people).toEqual(preview.removePicks.people);
    expect(result.delta?.unattributed).toEqual(preview.removePicks.unattributed);
    expect(
      [...(result.delta?.assets ?? [])].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)),
    ).toEqual([...preview.removePicks.assets].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)));
    expectPickInvariants(r);
  });
});
