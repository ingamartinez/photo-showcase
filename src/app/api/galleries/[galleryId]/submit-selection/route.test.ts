import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts AND
// src/lib/galleries.ts, both imported by this route) only resolves inside a
// real Next.js bundle — see src/lib/auth-guards.test.ts, and the identical
// mock on src/app/api/assets/[assetId]/selection/route.test.ts (this
// route's own sibling).
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Task #94: ownership itself moved to src/lib/gallery-access.ts's
// `isGalleryOwner`, which has its own dedicated, mutation-tested suite
// (gallery-access.test.ts). Mocked here with a realistic default (admin, or
// the session that owns `CLIENT_ID`'s gallery, is an owner — anyone else
// isn't) rather than re-seeding a second fake `gallery_clients` table, so
// this suite tests exactly its own job: does this ROUTE call
// `isGalleryOwner` and honor its result.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

// Mocked at the module boundary, not the network (`fetch`) boundary — this
// suite is about the ROUTE's own orchestration (who gets emailed, with what,
// and what happens to the gallery's status when it fails).
const sendSubmissionNotificationEmailMock = vi.fn();
vi.mock("@/lib/admin-notification-email", () => ({
  sendSubmissionNotificationEmail: (...args: unknown[]) =>
    sendSubmissionNotificationEmailMock(...args),
}));

// Task #114: this route is one of the three write paths that must signal the
// shared selection changed — the submit lock itself is one of the two things
// that must converge live (see proof-grid.tsx's own comment on `status`).
const notifySelectionChangedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: (...args: [string]) => notifySelectionChangedMock(...args),
}));

// The shared in-memory double (src/test-support/fake-db.ts) — filters for real
// off eq()/isNull()/and(), supports `transaction()` and `for("update")`.
vi.mock("@/lib/db", async () => {
  const { galleries, assets, users, galleryClients, assetPicks } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, assets, users, galleryClients, assetPicks]);
  // Test-only escape hatch, not part of the real `db` shape.
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        assets: fake.__tables.get(assets)!,
        users: fake.__tables.get(users)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        assetPicks: fake.__tables.get(assetPicks)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: {
        galleries: Row[];
        assets: Row[];
        users: Row[];
        galleryClients: Row[];
        assetPicks: Row[];
      };
    };
  };
  return db;
}

/** One ACTIVE membership of the fixture gallery, open (not locked) by default. */
function membership(userId: string, overrides: Row = {}): Row {
  return {
    galleryId: GALLERY_ID,
    userId,
    removedAt: null,
    selectionLockedAt: null,
    selectionSubmittedAt: null,
    ...overrides,
  };
}

/** One CART pick by default; a submit stamps `submittedAt`. */
function pick(assetId: string, userId: string, overrides: Row = {}): Row {
  return {
    assetId,
    galleryId: GALLERY_ID,
    userId,
    kind: "edited",
    pickedAt: new Date("2026-07-02T00:00:00.000Z"),
    submittedAt: null,
    ...overrides,
  };
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "client-a";
const CLIENT_B = "client-b";
const CLIENT_EMAIL = "ana@example.com";
const ADMIN_EMAIL = "photographer@example.com";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ASSET_2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

function clientSession(userId = CLIENT_ID): Session {
  return {
    user: { id: userId, role: "client", email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: ADMIN_EMAIL },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

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
    originalPhotoPriceCopSnapshot: 2_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function assetRow(overrides: Row = {}): Row {
  return {
    id: ASSET_1_ID,
    galleryId: GALLERY_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_ID}/proofs/${ASSET_1_ID}.webp`,
    finalKey: null,
    requestedAt: null,
    billedAt: null,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    selectedAt: null,
    billedTo: null,
    selectionKind: "edited",
    isEdited: false,
    sortOrder: 0,
    createdAt: new Date("2026-07-02"),
    ...overrides,
  };
}

function requestFor(): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${GALLERY_ID}/submit-selection`, {
    method: "POST",
  });
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockImplementation(
    async (_galleryId, session) =>
      session.user.role === "admin" ||
      session.user.id === CLIENT_ID ||
      session.user.id === CLIENT_B,
  );
  sendSubmissionNotificationEmailMock.mockReset();
  sendSubmissionNotificationEmailMock.mockResolvedValue(undefined);
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("EMAIL_FROM", "no-reply@alejoframes.com");
  vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-characters-long");
  vi.stubEnv("AUTH_URL", "http://localhost:3300");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.assetPicks.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.galleryClients.push(membership(CLIENT_ID));
  db.__rows.users.push({ id: CLIENT_ID, name: "Ana Pérez", email: CLIENT_EMAIL, role: "client" });
  db.__rows.users.push({ id: "admin-1", name: "Alejo", email: ADMIN_EMAIL, role: "admin" });
  // The caller's CART: an unclaimed asset plus the caller's unsubmitted pick.
  db.__rows.assets.push(assetRow({ id: ASSET_1_ID }));
  db.__rows.assetPicks.push(pick(ASSET_1_ID, CLIENT_ID));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/galleries/[galleryId]/submit-selection — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects a malformed gallery id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_gallery_id" });
  });

  it("returns 404 when the gallery does not exist", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });

  it("returns 403 when a different client submits someone else's gallery", async () => {
    authMock.mockResolvedValue(clientSession("client-b"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("calls isGalleryOwner with the gallery's OWN id, never anything caller-supplied", async () => {
    const session = clientSession();
    authMock.mockResolvedValue(session);
    const { POST } = await import("./route");

    await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(isGalleryOwnerMock).toHaveBeenCalledWith(GALLERY_ID, session);
  });

  it("returns 404 (not 403) for a CLIENT when the gallery is still draft — not yet visible to them at all", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });

  it("lets an admin reach a draft gallery, but refuses the submission itself with 409 (draft isn't proofing yet)", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_submittable" });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — empty selection", () => {
  it("refuses an empty cart with 400, without touching the gallery's status", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.assetPicks.length = 0;
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });

  it("refuses a cart whose only picks are already submitted (empty cart) with 400", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.assetPicks[0]!.submittedAt = new Date("2026-10-16T10:00:00.000Z");
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
  });

  it("ignores ANOTHER person's cart: a client with no picks of their own gets 400", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.assetPicks.length = 0;
    db.__rows.galleryClients.push(membership(CLIENT_B));
    db.__rows.users.push({ id: CLIENT_B, name: "Beto", email: "beto@example.com", role: "client" });
    db.__rows.assetPicks.push(pick(ASSET_1_ID, CLIENT_B));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)).toMatchObject({
      selectionLockedAt: null,
    });
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — locked statuses", () => {
  it.each(["delivered", "archived"])(
    "refuses with 409 when the gallery status is already %s",
    async (status) => {
      authMock.mockResolvedValue(adminSession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { POST } = await import("./route");

      const response = await POST(requestFor(), paramsFor(GALLERY_ID));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_not_submittable" });
      expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
    },
  );

  it("returns a calm already_submitted 200 — no mutation, no email — when the gallery is already selected", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(
      galleryRow({
        status: "selected",
        selectionSubmittedAt: new Date("2026-07-28T11:00:00.000Z"),
      }),
    );
    // The CALLER's own submission time is what comes back.
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push(
      membership(CLIENT_ID, {
        selectionLockedAt: new Date("2026-07-28T10:00:00.000Z"),
        selectionSubmittedAt: new Date("2026-07-28T10:00:00.000Z"),
      }),
    );
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "already_submitted",
      quota: {
        selected: 0,
        selectedEdited: 0,
        selectedOriginal: 0,
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        extraPhotoPriceTiersSnapshot: null,
        extraUnitPriceCop: 5_000,
        originalPhotoPriceCopSnapshot: 2_000,
        extras: 0,
        originals: 0,
        extrasSurchargeCop: 0,
        originalsSurchargeCop: 0,
        surchargeCop: 0,
      },
      submittedAt: "2026-07-28T10:00:00.000Z",
      gallerySelected: true,
    });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — volume scale (task #231)", () => {
  it("prices the submitted quota, and the admin email, by the gallery's frozen scale", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, sortOrder: 1 }));
    db.__rows.assetPicks.push(pick(ASSET_2_ID, CLIENT_ID));
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(
      galleryRow({
        includedPhotosSnapshot: 0,
        extraPhotoPriceCopSnapshot: 15_000,
        extraPhotoPriceTiersSnapshot: [
          { minExtras: 1, priceCop: 15_000 },
          { minExtras: 2, priceCop: 10_000 },
        ],
      }),
    );
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    const body = (await response.json()) as {
      quota: { extras: number; extraUnitPriceCop: number; surchargeCop: number };
    };
    // 2 extras, both at the 2+ tier's 10.000 — not 2 x 15.000.
    expect(body.quota).toMatchObject({
      extras: 2,
      extraUnitPriceCop: 10_000,
      surchargeCop: 20_000,
    });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        quota: expect.objectContaining({ extraUnitPriceCop: 10_000, surchargeCop: 20_000 }),
      }),
    );
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — success", () => {
  it("claims the cart, flips proofing -> selected, and notifies the admin naming WHO submitted", async () => {
    authMock.mockResolvedValue({
      user: { id: CLIENT_ID, role: "client", name: "Ana Pérez", email: CLIENT_EMAIL },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, sortOrder: 1 }));
    db.__rows.assetPicks.push(pick(ASSET_2_ID, CLIENT_ID));
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 1 }));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      quota: { selected: number; extras: number; surchargeCop: number };
      pickOutcomes: Record<string, number>;
      submittedAt: string;
    };
    expect(body.status).toBe("submitted");
    expect(body.quota).toEqual({
      selected: 2,
      selectedEdited: 2,
      selectedOriginal: 0,
      includedPhotosSnapshot: 1,
      extraPhotoPriceCopSnapshot: 5_000,
      extraPhotoPriceTiersSnapshot: null,
      extraUnitPriceCop: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      extras: 1,
      originals: 0,
      extrasSurchargeCop: 5_000,
      originalsSurchargeCop: 0,
      surchargeCop: 5_000,
    });
    expect(body.pickOutcomes).toEqual({
      claimed: 2,
      escalated: 0,
      joined: 0,
      escalationBlocked: 0,
    });
    expect(body.submittedAt).toBeTruthy();

    // Both assets are claimed by the caller, and their picks are submitted.
    for (const id of [ASSET_1_ID, ASSET_2_ID]) {
      const asset = db.__rows.assets.find((a) => a.id === id)!;
      expect(asset).toMatchObject({ isSelected: true, billedTo: CLIENT_ID });
      expect(asset.billedAt).toBeInstanceOf(Date);
      expect(asset.requestedAt).toBeInstanceOf(Date);
      expect(asset.selectedAt).toBeInstanceOf(Date);
      const pickRow = db.__rows.assetPicks.find((p) => p.assetId === id && p.userId === CLIENT_ID)!;
      expect(pickRow.submittedAt).toBeInstanceOf(Date);
    }
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });

    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
    const [emailArgs] = sendSubmissionNotificationEmailMock.mock.calls[0] as [
      {
        to: string;
        clientName: string | null;
        clientEmail: string;
        quota: { selected: number };
      },
    ];
    expect(emailArgs.to).toBe(ADMIN_EMAIL);
    expect(emailArgs.clientName).toBe("Ana Pérez");
    expect(emailArgs.quota).toEqual(body.quota);
  });

  it("freezes and notifies the quota split between edited and original picks", async () => {
    authMock.mockResolvedValue({
      user: { id: CLIENT_ID, role: "client", name: "Ana Pérez", email: CLIENT_EMAIL },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 7 }));
    db.__rows.assets.length = 0;
    db.__rows.assetPicks.length = 0;
    for (let i = 0; i < 9; i += 1) {
      const id = `edited-${i}`;
      db.__rows.assets.push(assetRow({ id, sortOrder: i }));
      db.__rows.assetPicks.push(pick(id, CLIENT_ID, { kind: "edited" }));
    }
    for (let i = 0; i < 3; i += 1) {
      const id = `original-${i}`;
      db.__rows.assets.push(assetRow({ id, sortOrder: 9 + i }));
      db.__rows.assetPicks.push(pick(id, CLIENT_ID, { kind: "original" }));
    }
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));
    const body = (await response.json()) as {
      quota: { selectedEdited: number; selectedOriginal: number; surchargeCop: number };
    };

    // 9 edited -> 2 over the 7 included -> 10_000. 3 originals -> 6_000 more.
    expect(body.quota.selectedEdited).toBe(9);
    expect(body.quota.selectedOriginal).toBe(3);
    expect(body.quota.surchargeCop).toBe(16_000);
  });

  it("signals the shared-selection change for this gallery on the winning submit", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("reports the single-client submit as having closed the gallery, with the caller's own submittedAt", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    const body = (await response.json()) as { gallerySelected: boolean; submittedAt: string };
    const db = await seededDb();
    expect(body.gallerySelected).toBe(true);
    expect(db.__rows.galleryClients[0]).toMatchObject({
      selectionLockedAt: expect.any(Date),
      selectionSubmittedAt: expect.any(Date),
    });
    expect(body.submittedAt).toBe(
      (db.__rows.galleryClients[0]!.selectionSubmittedAt as Date).toISOString(),
    );
  });
});

// Epic #239 — the lock is PER PERSON. Fixture: Ana (client-a) and Beto
// (client-b) share the gallery; each has one pick of their own.
describe("POST /api/galleries/[galleryId]/submit-selection — per-client lock (epic #239)", () => {
  async function twoClientGallery() {
    const db = await seededDb();
    db.__rows.users.push({
      id: CLIENT_B,
      name: "Beto Ruiz",
      email: "beto@example.com",
      role: "client",
    });
    db.__rows.galleryClients.push(membership(CLIENT_B));
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, sortOrder: 1 }));
    db.__rows.assetPicks.push(pick(ASSET_2_ID, CLIENT_B));
    return db;
  }

  function sessionOf(userId: string, name: string): Session {
    return {
      user: { id: userId, role: "client", name, email: `${userId}@example.com` },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session;
  }

  it("A submits: A's pick is claimed, the gallery stays proofing, B's pick is untouched and the admin is told about A", async () => {
    const db = await twoClientGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "submitted",
      gallerySelected: false,
    });
    expect(db.__rows.galleries[0]).toMatchObject({
      status: "proofing",
      selectionSubmittedAt: null,
    });
    expect(db.__rows.assets.find((a) => a.id === ASSET_1_ID)).toMatchObject({
      isSelected: true,
      billedTo: CLIENT_ID,
    });
    // B's asset stays unclaimed and B's pick stays in the cart.
    expect(db.__rows.assets.find((a) => a.id === ASSET_2_ID)).toMatchObject({ isSelected: false });
    expect(
      db.__rows.assetPicks.find((p) => p.assetId === ASSET_2_ID && p.userId === CLIENT_B)!
        .submittedAt,
    ).toBeNull();
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)).toMatchObject({
      selectionLockedAt: expect.any(Date),
    });
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_B)).toMatchObject({
      selectionLockedAt: null,
    });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: "Ana Pérez" }),
    );
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("B submitting afterwards, as the last open client, moves the gallery to selected exactly once", async () => {
    const db = await twoClientGallery();
    const { POST } = await import("./route");
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    await POST(requestFor(), paramsFor(GALLERY_ID));
    authMock.mockResolvedValue(sessionOf(CLIENT_B, "Beto Ruiz"));

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({
      status: "submitted",
      gallerySelected: true,
    });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
    expect(db.__rows.assets.find((a) => a.id === ASSET_2_ID)).toMatchObject({
      isSelected: true,
      billedTo: CLIENT_B,
    });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(2);
  });

  it("refuses an empty OWN cart with 400 even though the other client has picks", async () => {
    const db = await twoClientGallery();
    // Ana has no pick; the only cart pick belongs to Beto. Mutate in place
    // (the fake db's store is the same array reference).
    const ownPickIndex = db.__rows.assetPicks.findIndex((p) => p.userId === CLIENT_ID);
    db.__rows.assetPicks.splice(ownPickIndex, 1);
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)).toMatchObject({
      selectionLockedAt: null,
    });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });

  it("is idempotent for a client who is already locked while the gallery is still open", async () => {
    const db = await twoClientGallery();
    const ownSubmittedAt = new Date("2026-10-15T09:00:00.000Z");
    const own = db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!;
    own.selectionLockedAt = ownSubmittedAt;
    own.selectionSubmittedAt = ownSubmittedAt;
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "already_submitted",
      submittedAt: ownSubmittedAt.toISOString(),
      gallerySelected: false,
    });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });

  it("ignores a REMOVED unlocked client: the last ACTIVE client submitting closes the gallery", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push(membership(CLIENT_B, { removedAt: new Date("2026-09-01") }));
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({ gallerySelected: true });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("locks only THIS gallery's membership: the same client in another gallery stays untouched", async () => {
    const db = await seededDb();
    const OTHER = "22222222-2222-4222-8222-222222222222";
    db.__rows.galleryClients.unshift(membership(CLIENT_ID, { galleryId: OTHER }));
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(
      db.__rows.galleryClients.find((r) => r.galleryId === OTHER && r.userId === CLIENT_ID),
    ).toMatchObject({ selectionLockedAt: null, selectionSubmittedAt: null });
    expect(
      db.__rows.galleryClients.find((r) => r.galleryId === GALLERY_ID && r.userId === CLIENT_ID),
    ).toMatchObject({ selectionLockedAt: expect.any(Date) });
  });

  it("reads the caller's lock in THIS gallery: being locked in another gallery does not make a first submit here idempotent", async () => {
    const db = await seededDb();
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const lockedAt = new Date("2026-10-01T10:00:00.000Z");
    db.__rows.galleryClients.unshift(
      membership(CLIENT_ID, {
        galleryId: OTHER,
        selectionLockedAt: lockedAt,
        selectionSubmittedAt: lockedAt,
      }),
    );
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({ status: "submitted" });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an admin with 409 admin_cannot_submit — there is no membership to lock — and changes nothing", async () => {
    const db = await twoClientGallery();
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "admin_cannot_submit" });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(db.__rows.galleryClients.every((r) => r.selectionLockedAt === null)).toBe(true);
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });

  it("refuses with 403 a caller whose membership was removed after the ownership check", async () => {
    const db = await seededDb();
    db.__rows.galleryClients[0]!.removedAt = new Date("2026-09-01");
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
  });

  it("refuses an UNLOCKED client of an already-selected gallery (attached after it closed) with 409, locking nothing", async () => {
    const db = await seededDb();
    db.__rows.galleries[0]!.status = "selected";
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_submittable" });
    expect(db.__rows.galleryClients[0]).toMatchObject({ selectionLockedAt: null });
  });

  it("takes the gallery row lock before it writes anything, including the pick stamp", async () => {
    await twoClientGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { db } = (await import("@/lib/db")) as unknown as { db: { __log: string[] } };
    db.__log.length = 0;
    const { POST } = await import("./route");

    await POST(requestFor(), paramsFor(GALLERY_ID));

    const firstUpdate = db.__log.findIndex((entry) => entry.startsWith("update:"));
    expect(db.__log.indexOf("for:update")).toBeGreaterThanOrEqual(0);
    expect(db.__log.indexOf("for:update")).toBeLessThan(firstUpdate);
  });
});

// Task #244 — with rolling delivery on, submitting places an ORDER: it stamps
// `submitted_at` on THIS client's cart, claims the assets and never locks. The
// flag-off behavior is pinned by the epic #239 suite above.
describe("POST /api/galleries/[galleryId]/submit-selection — rolling delivery orders (#244)", () => {
  const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
  const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
  const A3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
  const B1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1";

  // A owns three cart picks, B owns ONE different cart pick.
  async function rollingGallery() {
    const db = await seededDb();
    db.__rows.galleries[0]!.rollingDelivery = true;
    db.__rows.assets.length = 0;
    db.__rows.assetPicks.length = 0;
    db.__rows.users.push({
      id: CLIENT_B,
      name: "Beto Ruiz",
      email: "beto@example.com",
      role: "client",
    });
    db.__rows.galleryClients.push(membership(CLIENT_B));
    db.__rows.assets.push(
      assetRow({ id: A1, sortOrder: 0 }),
      assetRow({ id: A2, sortOrder: 1 }),
      assetRow({ id: A3, sortOrder: 2 }),
      assetRow({ id: B1, sortOrder: 3 }),
    );
    db.__rows.assetPicks.push(
      pick(A1, CLIENT_ID, { pickedAt: new Date("2026-07-02T00:00:00Z") }),
      pick(A2, CLIENT_ID, { pickedAt: new Date("2026-07-02T00:01:00Z") }),
      pick(A3, CLIENT_ID, { pickedAt: new Date("2026-07-02T00:02:00Z") }),
      pick(B1, CLIENT_B, { pickedAt: new Date("2026-07-02T00:03:00Z") }),
    );
    return db;
  }

  function sessionOf(userId: string, name: string): Session {
    return {
      user: { id: userId, role: "client", name, email: `${userId}@example.com` },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session;
  }

  const assetOf = (db: Awaited<ReturnType<typeof seededDb>>, id: string) =>
    db.__rows.assets.find((r) => r.id === id)!;

  it("A submits: ONLY A's three picks are claimed, B's pick is untouched, nobody is locked, the gallery stays proofing", async () => {
    const db = await rollingGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "submitted",
      gallerySelected: false,
      requestedCount: 3,
      pickOutcomes: { claimed: 3, escalated: 0, joined: 0, escalationBlocked: 0 },
    });
    for (const id of [A1, A2, A3]) {
      expect(assetOf(db, id)).toMatchObject({ isSelected: true, billedTo: CLIENT_ID });
      expect(assetOf(db, id).requestedAt).toBeInstanceOf(Date);
    }
    expect(assetOf(db, B1)).toMatchObject({ isSelected: false, requestedAt: null });
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: expect.any(Date),
    });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestedCount: 3 }),
    );
    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("a second order claims only the NEW cart pick; earlier arrivals are unchanged", async () => {
    const db = await rollingGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");
    await POST(requestFor(), paramsFor(GALLERY_ID));
    const firstArrival = assetOf(db, A1).billedAt as Date;
    db.__rows.assets.push(
      assetRow({ id: "n1", sortOrder: 4 }),
      assetRow({ id: "n2", sortOrder: 5 }),
    );
    db.__rows.assetPicks.push(
      pick("n1", CLIENT_ID, { pickedAt: new Date("2026-07-03T00:00:00Z") }),
    );

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(assetOf(db, "n1")).toMatchObject({ isSelected: true, billedTo: CLIENT_ID });
    expect(assetOf(db, "n2")).toMatchObject({ isSelected: false, requestedAt: null });
    expect((assetOf(db, "n1").billedAt as Date).getTime()).toBeGreaterThan(firstArrival.getTime());
    // The first claims keep their original arrival.
    expect(assetOf(db, A1).billedAt).toEqual(firstArrival);
    await expect(response.json()).resolves.toMatchObject({ requestedCount: 1 });
    expect(
      db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!.selectionLockedAt,
    ).toBeNull();
  });

  it("submitting with an empty cart (everything already submitted) is 400 empty_selection and writes nothing", async () => {
    const db = await rollingGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");
    await POST(requestFor(), paramsFor(GALLERY_ID));
    sendSubmissionNotificationEmailMock.mockClear();
    const arrivalsBefore = [A1, A2, A3].map((id) => assetOf(db, id).billedAt);
    const submittedBefore = db.__rows.galleryClients.find(
      (r) => r.userId === CLIENT_ID,
    )!.selectionSubmittedAt;

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
    expect([A1, A2, A3].map((id) => assetOf(db, id).billedAt)).toEqual(arrivalsBefore);
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!.selectionSubmittedAt).toBe(
      submittedBefore,
    );
  });

  it("never auto-moves the gallery to selected, even once EVERY client has ordered (#260 owns decision 13)", async () => {
    const db = await rollingGallery();
    const { POST } = await import("./route");
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    await POST(requestFor(), paramsFor(GALLERY_ID));
    authMock.mockResolvedValue(sessionOf(CLIENT_B, "Beto Ruiz"));

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({ gallerySelected: false });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(db.__rows.galleryClients.every((r) => r.selectionLockedAt === null)).toBe(true);
    expect(assetOf(db, B1)).toMatchObject({ isSelected: true, billedTo: CLIENT_B });
  });

  it("an admin lock landing between the pre-check and the transaction stamps NOTHING and sends no email", async () => {
    const db = await rollingGallery();
    const membershipRow = db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!;
    // Open on the route's FIRST read (the own-lock check), locked on every read
    // after it: the lock lands mid-transaction.
    let reads = 0;
    Object.defineProperty(membershipRow, "selectionLockedAt", {
      configurable: true,
      get: () => (reads++ === 0 ? null : new Date("2026-10-16T11:00:00.000Z")),
      set: () => {},
    });
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({ status: "already_submitted" });
    for (const id of [A1, A2, A3, B1]) expect(assetOf(db, id).isSelected).toBe(false);
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });

  it("flag OFF: submit locks AND claims, stamping requestedAt in both modes", async () => {
    const db = await seededDb();
    const { POST } = await import("./route");
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.galleryClients[0]).toMatchObject({
      selectionLockedAt: expect.any(Date),
      selectionLockedBy: "client",
    });
    expect(db.__rows.assets[0]).toMatchObject({ isSelected: true, requestedAt: expect.any(Date) });
  });
});

// Task #259 R2/R3 — the email's `requestedCount` is the photographer's NEW
// work (claims + escalations), omitted rather than sent as a misleading 0.
describe("POST /api/galleries/[galleryId]/submit-selection — rolling notification count", () => {
  it("R2 — an all-degraded rolling submit joins: 200, pickOutcomes.joined = n, no requestedCount in the email, requestedCount = n in the response", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries[0]!.rollingDelivery = true;
    db.__rows.galleryClients.push(membership(CLIENT_B));
    // B claims the asset; A's pick on it is degraded.
    db.__rows.assets[0] = assetRow({
      id: ASSET_1_ID,
      isSelected: true,
      billedTo: CLIENT_B,
      billedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    db.__rows.assetPicks[0] = pick(ASSET_1_ID, CLIENT_ID, { kind: "edited" });
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({
      status: "submitted",
      requestedCount: 1,
      pickOutcomes: { claimed: 0, escalated: 0, joined: 1, escalationBlocked: 0 },
    });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
    const [emailArgs] = sendSubmissionNotificationEmailMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(emailArgs).not.toHaveProperty("requestedCount");
    // The claim is untouched.
    expect(db.__rows.assets[0]).toMatchObject({ billedTo: CLIENT_B, isSelected: true });
  });

  it("R3 — the email gets requestedCount = claimed + escalated when that is > 0", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries[0]!.rollingDelivery = true;
    // A holds an original claim on ASSET_2 with no final; client-a escalates it.
    db.__rows.assets.push(
      assetRow({
        id: ASSET_2_ID,
        isSelected: true,
        billedTo: CLIENT_B,
        billedAt: new Date("2026-07-02T00:00:00.000Z"),
        selectionKind: "original",
        sortOrder: 1,
      }),
    );
    db.__rows.assetPicks.push(pick(ASSET_2_ID, CLIENT_ID, { kind: "edited" }));
    const { POST } = await import("./route");

    await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestedCount: 2 }),
    );
  });
});

// Task #259 R1 — `now` is sampled AFTER the gallery lock. The fake clock is
// advanced the moment `.for("update")` runs, so a `now` taken before the lock
// reads T0 and this test goes red.
describe("POST /api/galleries/[galleryId]/submit-selection — now after the lock (R1)", () => {
  it("stamps the membership, the pick and the response with the post-lock time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = new Date("2026-10-17T10:00:00.000Z");
    const T_LOCK = new Date("2026-10-17T10:00:05.000Z");
    vi.setSystemTime(T0);
    authMock.mockResolvedValue(clientSession());
    const { db } = (await import("@/lib/db")) as unknown as {
      db: {
        select: (columns?: Record<string, unknown>) => unknown;
        __rows: {
          galleries: Row[];
          assets: Row[];
          users: Row[];
          galleryClients: Row[];
          assetPicks: Row[];
        };
      };
    };

    const realSelect = db.select.bind(db);
    db.select = ((columns?: Record<string, unknown>) => {
      const from = realSelect(columns) as {
        from: (table: unknown) => {
          where: (condition: unknown) => {
            for: (mode: string) => Promise<Row[]>;
            limit: (n: number) => Promise<Row[]>;
          };
        };
      };
      const realFrom = from.from.bind(from);
      from.from = (table: unknown) => {
        const where = realFrom(table);
        const realWhere = where.where.bind(where);
        where.where = (condition: unknown) => {
          const promise = realWhere(condition);
          const realFor = promise.for.bind(promise);
          promise.for = async (mode: string) => {
            vi.setSystemTime(T_LOCK);
            return realFor(mode);
          };
          return promise;
        };
        return where;
      };
      return from;
    }) as typeof db.select;

    const { POST } = await import("./route");
    const response = await POST(requestFor(), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { submittedAt: string };

    expect(body.submittedAt).toBe(T_LOCK.toISOString());
    expect(db.__rows.galleryClients[0]!.selectionSubmittedAt).toEqual(T_LOCK);
    expect(db.__rows.assetPicks[0]!.submittedAt).toEqual(T_LOCK);
    const claimedAt = db.__rows.assets[0]!.billedAt as Date;
    expect(claimedAt.getTime()).toBeGreaterThanOrEqual(T_LOCK.getTime());
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — double submission is idempotent", () => {
  it("the second of two SEQUENTIAL submits short-circuits before ever reaching the UPDATE", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const first = await POST(requestFor(), paramsFor(GALLERY_ID));
    const second = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "submitted" });
    await expect(second.json()).resolves.toMatchObject({ status: "already_submitted" });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("sends exactly one notification when two submits race via Promise.all", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    const [first, second] = await Promise.all([
      POST(requestFor(), paramsFor(GALLERY_ID)),
      POST(requestFor(), paramsFor(GALLERY_ID)),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 200]);
    const bodies = await Promise.all([first.json(), second.json()]);
    const statuses = bodies.map((body) => (body as { status: string }).status).sort();
    expect(statuses).toEqual(["already_submitted", "submitted"]);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — notification failure", () => {
  it("still reports success and leaves the gallery selected when the notification fails", async () => {
    authMock.mockResolvedValue(clientSession());
    sendSubmissionNotificationEmailMock.mockRejectedValue(new Error("Resend error (500): boom"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "submitted" });

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });

  it("a later call after a failed notification is idempotent, not a retry of the notification", async () => {
    authMock.mockResolvedValue(clientSession());
    sendSubmissionNotificationEmailMock.mockRejectedValueOnce(
      new Error("Resend error (500): boom"),
    );
    const { POST } = await import("./route");

    const first = await POST(requestFor(), paramsFor(GALLERY_ID));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "submitted" });

    const second = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ status: "already_submitted" });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
  });
});
