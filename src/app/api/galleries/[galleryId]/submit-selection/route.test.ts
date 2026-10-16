import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Mocked at the module boundary, not the network (`fetch`) boundary —
// mirrors how src/app/dashboard/galleries/actions.publish.test.ts mocks
// `signIn` rather than Resend's HTTP call: this suite is about the ROUTE's
// own orchestration (who gets emailed, with what, and what happens to the
// gallery's status when it fails), which `sendSubmissionNotificationEmail`'s
// own unit tests (src/lib/admin-notification-email.test.ts) already cover
// at the Resend-call level.
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
  const { galleries, assets, users, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, assets, users, galleryClients]);
  // Test-only escape hatch, not part of the real `db` shape.
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        assets: fake.__tables.get(assets)!,
        users: fake.__tables.get(users)!,
        galleryClients: fake.__tables.get(galleryClients)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; assets: Row[]; users: Row[]; galleryClients: Row[] } };
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
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    selectedAt: null,
    // Epic #239 — the picker. Defaults to the fixture's main client; the
    // multi-client tests override it per asset.
    selectedBy: CLIENT_ID,
    // Task #206 — the domain's own default; the mixed-case test overrides
    // this explicitly.
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
  db.__rows.galleries.push(galleryRow());
  db.__rows.galleryClients.push(membership(CLIENT_ID));
  db.__rows.users.push({ id: CLIENT_ID, name: "Ana Pérez", email: CLIENT_EMAIL, role: "client" });
  db.__rows.users.push({ id: "admin-1", name: "Alejo", email: ADMIN_EMAIL, role: "admin" });
  db.__rows.assets.push(assetRow({ isSelected: true }));
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

  // Review finding on task #94: this suite's `isGalleryOwnerMock` above
  // ignores its OWN first argument (`_galleryId`), so it can never catch a
  // regression where the route passed a caller-supplied gallery id instead
  // of the loaded row's own `gallery.id` — exactly the shortcut
  // src/lib/asset-access.ts's header comment warns never to take. Asserted
  // here explicitly, the same way src/lib/asset-access.test.ts:166 already
  // does for `loadOwnedAsset`.
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
  it("refuses an empty selection with 400, without touching the gallery's status", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false }));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
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

  // The idempotent double-submit path: the gallery is ALREADY `selected` —
  // a calm 200, not an error, and definitely not a second email.
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
    // The CALLER's own submission time is what comes back — deliberately
    // different from the gallery's closing time above.
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
        selected: 1,
        selectedEdited: 1,
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
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, isSelected: true, sortOrder: 1 }));
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
  it("flips proofing -> selected, stamps selectionSubmittedAt, and notifies the single admin naming WHO submitted (the session), gallery, count, extras, and surcharge", async () => {
    // Task #94: `gallery.clientId` is gone — the admin notification now
    // names whoever's SESSION actually submitted, not a separate DB lookup
    // by the gallery's (now nonexistent) single client id. A realistic
    // session (name + the client's own email) exercises that path
    // meaningfully, rather than `clientSession()`'s bare synthetic email.
    authMock.mockResolvedValue({
      user: { id: CLIENT_ID, role: "client", name: "Ana Pérez", email: CLIENT_EMAIL },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, isSelected: true, sortOrder: 1 }));
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 1 }));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      quota: { selected: number; extras: number; surchargeCop: number };
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
    expect(body.submittedAt).toBeTruthy();

    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
    expect(db.__rows.galleries[0]?.selectionSubmittedAt).toBeInstanceOf(Date);

    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
    const [emailArgs] = sendSubmissionNotificationEmailMock.mock.calls[0] as [
      {
        to: string;
        clientName: string | null;
        clientEmail: string;
        galleryTitle: string;
        galleryUrl: string;
        quota: { selected: number; extras: number; surchargeCop: number };
      },
    ];
    expect(emailArgs.to).toBe(ADMIN_EMAIL);
    expect(emailArgs.clientName).toBe("Ana Pérez");
    expect(emailArgs.clientEmail).toBe(CLIENT_EMAIL);
    expect(emailArgs.galleryTitle).toBe("Boda Ana y Beto");
    expect(emailArgs.galleryUrl).toContain(`/dashboard/galleries/${GALLERY_ID}`);
    expect(emailArgs.quota).toEqual(body.quota);
  });

  // Task #206, criterion 4 — the quota this route freezes and mails to the
  // admin reflects the client's actual edited/original split, not "every
  // pick is edited" the way task #205 (before this slice) still assumed.
  // Both summands non-zero, neither a multiple of the other.
  it("freezes and notifies the quota split between edited and original picks", async () => {
    authMock.mockResolvedValue({
      user: { id: CLIENT_ID, role: "client", name: "Ana Pérez", email: CLIENT_EMAIL },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 7 }));
    db.__rows.assets.length = 0;
    db.__rows.assets.push(
      ...Array.from({ length: 9 }, (_unused, i) =>
        assetRow({ id: `edited-${i}`, isSelected: true, selectionKind: "edited", sortOrder: i }),
      ),
      ...Array.from({ length: 3 }, (_unused, i) =>
        assetRow({
          id: `original-${i}`,
          isSelected: true,
          selectionKind: "original",
          sortOrder: 9 + i,
        }),
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));
    const body = (await response.json()) as {
      quota: {
        selectedEdited: number;
        selectedOriginal: number;
        extras: number;
        originals: number;
        surchargeCop: number;
      };
    };

    // 9 edited -> 2 over the 7 included -> 10_000. 3 originals -> 6_000 more.
    expect(body.quota.selectedEdited).toBe(9);
    expect(body.quota.selectedOriginal).toBe(3);
    expect(body.quota.extras).toBe(2);
    expect(body.quota.originals).toBe(3);
    expect(body.quota.surchargeCop).toBe(16_000);

    const [emailArgs] = sendSubmissionNotificationEmailMock.mock.calls[0] as [
      { quota: { surchargeCop: number } },
    ];
    expect(emailArgs.quota.surchargeCop).toBe(16_000);
  });

  // Task #114: every open tab's submit lock (proof-grid.tsx's live `status`)
  // converges off this signal — dropping this call silently degrades to the
  // 30s fallback poll with no test noticing otherwise.
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
    db.__rows.assets.push(
      assetRow({ id: ASSET_2_ID, isSelected: true, selectedBy: CLIENT_B, sortOrder: 1 }),
    );
    return db;
  }

  function sessionOf(userId: string, name: string): Session {
    return {
      user: { id: userId, role: "client", name, email: `${userId}@example.com` },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session;
  }

  it("A submits: A is locked, the gallery stays proofing, B is untouched and the admin is told about A", async () => {
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
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)).toMatchObject({
      selectionLockedAt: expect.any(Date),
      selectionSubmittedAt: expect.any(Date),
    });
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_B)).toMatchObject({
      selectionLockedAt: null,
      selectionSubmittedAt: null,
    });
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: "Ana Pérez" }),
    );
    // The board changed for everyone (A's picks froze), so tabs are told.
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
    expect(db.__rows.galleries[0]!.selectionSubmittedAt).toBeInstanceOf(Date);
    // One notification per client submission, each naming its own client.
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(2);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientName: "Beto Ruiz" }),
    );
  });

  it("refuses an empty OWN selection with 400 even though the other client has picks", async () => {
    const db = await twoClientGallery();
    // Ana picked nothing; every pick belongs to Beto.
    db.__rows.assets.find((a) => a.id === ASSET_1_ID)!.selectedBy = CLIENT_B;
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

  it("is idempotent for a client who is already locked while the gallery is still open: own submittedAt, no email, gallerySelected false", async () => {
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

  // Every other fixture lives in ONE gallery, which hides a dropped
  // `galleryId` condition. Here the SAME client also belongs to a second
  // gallery, with the OPPOSITE lock state, listed first.
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

  it("takes the gallery row lock before it writes anything (what serializes two last submitters in Postgres)", async () => {
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
// `requested_at` on THIS client's cart and never locks. The flag-off behavior
// is pinned by the epic #239 suite above, which this block does not touch.
describe("POST /api/galleries/[galleryId]/submit-selection — rolling delivery orders (#244)", () => {
  const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
  const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
  const A3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
  const B1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1";

  // A owns three cart picks, B owns ONE different cart pick: the submitter's
  // cart and the other person's cart are different sets on purpose.
  async function rollingGallery() {
    const db = await seededDb();
    db.__rows.galleries[0]!.rollingDelivery = true;
    db.__rows.assets.length = 0;
    db.__rows.users.push({
      id: CLIENT_B,
      name: "Beto Ruiz",
      email: "beto@example.com",
      role: "client",
    });
    db.__rows.galleryClients.push(membership(CLIENT_B));
    db.__rows.assets.push(
      assetRow({ id: A1, isSelected: true, selectedBy: CLIENT_ID, sortOrder: 0 }),
      assetRow({ id: A2, isSelected: true, selectedBy: CLIENT_ID, sortOrder: 1 }),
      assetRow({ id: A3, isSelected: true, selectedBy: CLIENT_ID, sortOrder: 2 }),
      assetRow({ id: B1, isSelected: true, selectedBy: CLIENT_B, sortOrder: 3 }),
    );
    return db;
  }

  function sessionOf(userId: string, name: string): Session {
    return {
      user: { id: userId, role: "client", name, email: `${userId}@example.com` },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session;
  }

  const stampOf = (db: Awaited<ReturnType<typeof seededDb>>, id: string) =>
    db.__rows.assets.find((r) => r.id === id)!.requestedAt;

  it("A submits: ONLY A's three cart picks are stamped, B's pick is untouched, nobody is locked, the gallery stays proofing", async () => {
    const db = await rollingGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "submitted",
      gallerySelected: false,
      requestedCount: 3,
    });
    for (const id of [A1, A2, A3]) expect(stampOf(db, id)).toBeInstanceOf(Date);
    expect(stampOf(db, B1)).toBeNull();
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

  it("a second order stamps only the NEW cart pick and keeps the first order's original stamps", async () => {
    const db = await rollingGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");
    await POST(requestFor(), paramsFor(GALLERY_ID));
    const firstStamp = stampOf(db, A1) as Date;
    // Move the stored stamps into the past so "kept" vs "overwritten" is
    // observable, then add two cart picks and drop one of them.
    const past = new Date(firstStamp.getTime() - 3_600_000);
    for (const id of [A1, A2, A3]) db.__rows.assets.find((r) => r.id === id)!.requestedAt = past;
    db.__rows.assets.push(
      assetRow({ id: "n1", isSelected: true, selectedBy: CLIENT_ID, sortOrder: 4 }),
      assetRow({ id: "n2", isSelected: false, selectedBy: null, sortOrder: 5 }),
    );

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(stampOf(db, "n1")).toBeInstanceOf(Date);
    expect(stampOf(db, "n2")).toBeNull();
    for (const id of [A1, A2, A3]) expect(stampOf(db, id)).toBe(past);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedCount: 1 }),
    );
    expect(
      db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!.selectionLockedAt,
    ).toBeNull();
  });

  it("submitting with an empty cart (everything already ordered) is 400 empty_selection and writes nothing", async () => {
    const db = await rollingGallery();
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    const { POST } = await import("./route");
    await POST(requestFor(), paramsFor(GALLERY_ID));
    sendSubmissionNotificationEmailMock.mockClear();
    const stampsBefore = [A1, A2, A3].map((id) => stampOf(db, id));
    const submittedBefore = db.__rows.galleryClients.find(
      (r) => r.userId === CLIENT_ID,
    )!.selectionSubmittedAt;

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "empty_selection" });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
    expect([A1, A2, A3].map((id) => stampOf(db, id))).toEqual(stampsBefore);
    expect(db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!.selectionSubmittedAt).toBe(
      submittedBefore,
    );
  });

  it("never auto-moves the gallery to selected, even once EVERY client has ordered", async () => {
    const db = await rollingGallery();
    const { POST } = await import("./route");
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));
    await POST(requestFor(), paramsFor(GALLERY_ID));
    authMock.mockResolvedValue(sessionOf(CLIENT_B, "Beto Ruiz"));

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    await expect(response.json()).resolves.toMatchObject({ gallerySelected: false });
    expect(db.__rows.galleries[0]).toMatchObject({ status: "proofing" });
    expect(db.__rows.galleryClients.every((r) => r.selectionLockedAt === null)).toBe(true);
    expect(stampOf(db, B1)).toBeInstanceOf(Date);
  });

  it("an admin lock landing between the pre-check and the transaction stamps NOTHING and sends no email", async () => {
    const db = await rollingGallery();
    const membershipRow = db.__rows.galleryClients.find((r) => r.userId === CLIENT_ID)!;
    // Open on the route's FIRST read (the pre-check), locked on every read
    // after it: the lock lands "mid-transaction".
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
    for (const id of [A1, A2, A3, B1]) expect(stampOf(db, id)).toBeNull();
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
  });

  it("flag OFF: submit locks as in #239 and never writes requestedAt", async () => {
    const db = await seededDb();
    const { POST } = await import("./route");
    authMock.mockResolvedValue(sessionOf(CLIENT_ID, "Ana Pérez"));

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.galleryClients[0]).toMatchObject({ selectionLockedAt: expect.any(Date) });
    expect(db.__rows.assets.every((r) => !r.requestedAt)).toBe(true);
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — double submission is idempotent", () => {
  // A SEQUENTIAL double-submit (the first call has already fully resolved
  // before the second one starts) exercises the early `ownLock.lockedAt`
  // short-circuit near the top of the route, never the atomic membership
  // UPDATE itself — real, worth covering on its own, but NOT proof the CAS
  // guard works: this same assertion would still pass even if the UPDATE's
  // own `selection_locked_at IS NULL` clause were deleted entirely, because
  // the second call never reaches it.
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

  // THE actual proof of the atomicity guard (route.ts's own "THE atomicity
  // guard" comment): two submits issued via `Promise.all`, so BOTH calls run
  // past every read (auth, gallery lookup, the empty-selection check) and
  // reach the membership `UPDATE ... WHERE selection_locked_at IS NULL`
  // before either one has mutated anything — genuinely racing the UPDATE
  // itself, not the early short-circuit above. The fake `@/lib/db` mutates its
  // rows SYNCHRONOUSLY inside `.where()` (no extra `await` in between), which
  // is what makes this a meaningful test at all: JS's single-threaded run-to-
  // completion between `await` points means whichever of the two `POST`
  // calls' turns comes up first at that exact line completes its match-and-
  // mutate atomically before the other one can interleave — exactly
  // mirroring how Postgres serializes two concurrent UPDATEs against the
  // same row. Deleting the `isNull(selectionLockedAt)` condition from the
  // route's `and(...)` makes BOTH calls match and mutate, and this test
  // catches that: two notifications instead of one. (Two DIFFERENT clients
  // racing to be last is the row lock's job, which this fake cannot model —
  // see src/test-support/fake-db.ts's header.)
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
    // Exactly one winner ("submitted") and one loser ("already_submitted") —
    // never two winners, which would mean the guard let both through.
    expect(statuses).toEqual(["already_submitted", "submitted"]);
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — notification failure", () => {
  // Blocking finding from this task's own review: an earlier version of
  // this route REVERTED the status update back to `proofing` when the
  // notification failed. That created a worse bug than the one it tried to
  // prevent — a concurrent SECOND caller could read the gallery as
  // `selected` (the winner's CAS had committed) and report a confident
  // "already_submitted" to ITS OWN client a moment before the winner's own
  // failed send reverted that same row back to `proofing`, out from under
  // the response the loser had already sent. Fact-checked before choosing
  // the fix (not assumed): `/dashboard/galleries`
  // (src/app/dashboard/galleries/page.tsx, via `getGalleriesWithDetails`,
  // src/lib/galleries.ts) renders every gallery's `status` unconditionally —
  // a `selected` gallery is NOT invisible to the photographer just because
  // this email failed; it is one click away in the list they already use.
  // So the fix is: never revert. The submission committing IS the truth: a
  // failed notification is swallowed, the gallery stays `selected`, and the
  // route's response stays 200 "submitted" — never a lie in either
  // direction, for either caller.
  it("still reports success and leaves the gallery selected when the notification fails", async () => {
    authMock.mockResolvedValue(clientSession());
    sendSubmissionNotificationEmailMock.mockRejectedValue(new Error("Resend error (500): boom"));
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "submitted" });

    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
    expect(db.__rows.galleries[0]?.selectionSubmittedAt).toBeInstanceOf(Date);
  });

  // A THIRD caller (or the same client refreshing the page) hitting the
  // route again after a notification failure must see the honest,
  // idempotent "already_submitted" — not an error, and not a second
  // notification attempt for a submission that already fully committed.
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
    // The failed attempt above still counts as ONE attempt — the second call
    // never re-sends, because it never reaches the notification step at all
    // (the `status === "selected"` short-circuit returns before it).
    expect(sendSubmissionNotificationEmailMock).toHaveBeenCalledTimes(1);
  });
});
