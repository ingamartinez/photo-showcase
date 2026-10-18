import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { computeQuota, type GalleryQuotaSnapshot } from "@/lib/quota";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// DELIBERATELY NOT MOCKED: `@/lib/gallery-access`.
//
// Task #95's own constraint is that a live channel must not become the one
// door with a weaker lock, so this suite exercises the REAL `isGalleryOwner`
// against a seeded `gallery_clients` table — the same choice
// src/app/api/assets/[assetId]/selection/route.test.ts makes for its sibling
// PATCH route, and a deliberately stronger one than the mock-the-helper
// approach the submit-selection suite uses. What that buys, concretely: the
// soft-removed-client case (task #97) is proven THROUGH this route, not just
// in the helper's own suite, and a future edit that reached around the helper
// to a hand-rolled comparison here would fail these tests.
//
// MUTATION-PROVEN. Deleting the `if (!(await isGalleryOwner(...)))` block from
// the route makes "refuses a signed-in client who is not attached" and
// "refuses a client who was removed" both fail with a 200 (run and verified
// while writing these tests, not asserted on faith).
const getGallerySelectionMock =
  vi.fn<(galleryId: string, terms: unknown, subject: unknown) => Promise<unknown>>();
vi.mock("@/lib/gallery-selection", () => ({
  getGallerySelection: (...args: [string, unknown, unknown]) => getGallerySelectionMock(...args),
}));

// The shared in-memory double (src/test-support/fake-db.ts) — filters for real
// off eq()/isNull()/and(), supports `transaction()` and `for("update")`.
vi.mock("@/lib/db", async () => {
  const { galleries, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([galleries, galleryClients]);
  // Test-only escape hatch, not part of the real `db` shape.
  return {
    db: Object.assign(fake, {
      __rows: {
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; galleryClients: Row[] } };
  };
  return db;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function clientASession(): Session {
  return {
    user: { id: "client-a", role: "client", email: "a@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientBSession(): Session {
  return {
    user: { id: "client-b", role: "client", email: "b@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function galleryRow(overrides: Partial<Row> = {}): Row {
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

const TERMS: GalleryQuotaSnapshot = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

function view(
  overrides: {
    entries?: unknown[];
    quota?: ReturnType<typeof computeQuota>;
    counter?: unknown;
    lock?: {
      viewerLock?: unknown;
      adminLockedPickerIds?: string[];
      viewerSubmittedAt?: string | null;
    };
  } = {},
) {
  return {
    entries: overrides.entries ?? [],
    quota: overrides.quota ?? computeQuota(0, 0, TERMS),
    counter: overrides.counter ?? {
      group: 0,
      viewer: { yours: 0, shared: 0, toSend: 0 },
      people: [],
      unattributed: 0,
    },
    lock: {
      viewerLock: overrides.lock?.viewerLock ?? null,
      adminLockedPickerIds: overrides.lock?.adminLockedPickerIds ?? [],
      viewerSubmittedAt: overrides.lock?.viewerSubmittedAt ?? null,
    },
  };
}

function requestFor(galleryId: string): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${galleryId}/selection`);
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  getGallerySelectionMock.mockReset();
  getGallerySelectionMock.mockResolvedValue(view());
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.galleryClients.push({
    galleryId: GALLERY_ID,
    userId: "client-a",
    removedAt: null,
    selectionLockedAt: null,
    selectionSubmittedAt: null,
  });
});

describe("GET /api/galleries/[galleryId]/selection — the guard", () => {
  it("returns 401 JSON, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("refuses a signed-in client who is not among the gallery's clients", async () => {
    // THE acceptance criterion: a live channel gets the same lock as every
    // other route. `client-b` has a perfectly valid session and the gallery's
    // id — and gets nothing.
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    // And it never even asked for the selection — the refusal happens before
    // anybody's name is read out of the database.
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  it("refuses a client whose membership was SOFT-removed, exercising the real isGalleryOwner", async () => {
    // Task #97's soft delete: the `gallery_clients` row survives removal with
    // `removedAt` set. Proven through THIS route rather than only in the
    // helper's own suite, because "the row is still there" is exactly how a
    // new data path quietly keeps letting a removed client in.
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-a",
      removedAt: new Date("2026-07-29"),
    });
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
  });

  it("serves a client who IS attached to the gallery", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(getGallerySelectionMock).toHaveBeenCalledWith(
      GALLERY_ID,
      expect.any(Object),
      "client-a",
    );
  });

  it("serves an admin regardless of which clients the gallery has", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
  });

  it("hides a DRAFT gallery from its own client with the same 404 the page uses", async () => {
    // PLAN.md §2: a draft gallery is not yet visible to a client, so neither
    // is its selection state. Same 404, not a 403 — a client fishing for
    // gallery ids learns nothing new.
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });

  it("lets an admin read a draft gallery's selection, same carve-out as every sibling route", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
  });

  it("rejects a malformed gallery id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_gallery_id" });
  });

  it("returns 404 for a gallery that does not exist", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });
});

describe("GET /api/galleries/[galleryId]/selection — the snapshot", () => {
  it("passes the entries and counter through exactly as the builder produced them", async () => {
    const entries = [
      {
        assetId: "asset-1",
        claim: {
          claimedAt: "2026-07-30T12:00:00.000Z",
          resolvedKind: "edited",
          billedTo: { id: "client-b", label: "Beto Ruiz" },
          charge: "included",
        },
        picks: [],
      },
    ];
    const counter = {
      group: 1,
      viewer: { yours: 0, shared: 0, toSend: 0 },
      people: [{ userId: "client-b", label: "Beto Ruiz", units: 1 }],
      unattributed: 0,
    };
    getGallerySelectionMock.mockResolvedValue(view({ entries, counter }));
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { entries: unknown; counter: unknown };

    expect(body.entries).toEqual(entries);
    expect(body.counter).toEqual(counter);
  });

  it("asks the builder for the gallery's FROZEN terms and the caller's subject", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(
      galleryRow({
        includedPhotosSnapshot: 7,
        extraPhotoPriceCopSnapshot: 9_000,
        originalPhotoPriceCopSnapshot: 3_000,
        extraPhotoPriceTiersSnapshot: [
          { minExtras: 1, priceCop: 9_000 },
          { minExtras: 3, priceCop: 7_000 },
        ],
      }),
    );
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(getGallerySelectionMock).toHaveBeenCalledWith(
      GALLERY_ID,
      {
        includedPhotosSnapshot: 7,
        extraPhotoPriceCopSnapshot: 9_000,
        extraPhotoPriceTiersSnapshot: [
          { minExtras: 1, priceCop: 9_000 },
          { minExtras: 3, priceCop: 7_000 },
        ],
        originalPhotoPriceCopSnapshot: 3_000,
      },
      "client-a",
    );
  });

  it("passes the builder's quota through unchanged (the route no longer computes it)", async () => {
    const quota = computeQuota(15, 3, TERMS);
    getGallerySelectionMock.mockResolvedValue(view({ quota }));
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { quota: unknown };

    expect(body.quota).toEqual(quota);
  });

  it("reports the gallery's own status and submission timestamp", async () => {
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(
      galleryRow({
        status: "selected",
        selectionSubmittedAt: new Date("2026-07-30T13:00:00.000Z"),
      }),
    );
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { status: string; submittedAt: string | null };

    expect(body.status).toBe("selected");
    expect(body.submittedAt).toBe("2026-07-30T13:00:00.000Z");
  });

  it("reports a null submission timestamp for a gallery still being picked", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as { status: string; submittedAt: string | null };

    expect(body.status).toBe("proofing");
    expect(body.submittedAt).toBeNull();
  });

  it("returns no R2 key, no presigned URL and no slug, and no retired submittedPickerIds", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "adminLockedPickerIds",
      "counter",
      "entries",
      "quota",
      "status",
      "submittedAt",
      "viewerLock",
      "viewerSubmittedAt",
    ]);
    expect(body).not.toHaveProperty("submittedPickerIds");
    expect(body).not.toHaveProperty("picks");
    expect(body).not.toHaveProperty("lockedPickerIds");
  });
});

describe("GET /api/galleries/[galleryId]/selection — the lock snapshot", () => {
  it("passes the subject's viewerLock, the admin locks and the submit time through", async () => {
    getGallerySelectionMock.mockResolvedValue(
      view({
        lock: {
          viewerLock: {
            lockedAt: "2026-10-15T10:00:00.000Z",
            submittedAt: null,
            lockedBy: "admin",
          },
          adminLockedPickerIds: ["client-b"],
          viewerSubmittedAt: "2026-10-14T09:00:00.000Z",
        },
      }),
    );
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.viewerLock).toEqual({
      lockedAt: "2026-10-15T10:00:00.000Z",
      submittedAt: null,
      lockedBy: "admin",
    });
    expect(body.adminLockedPickerIds).toEqual(["client-b"]);
    expect(body.viewerSubmittedAt).toBe("2026-10-14T09:00:00.000Z");
  });
});

describe("GET /api/galleries/[galleryId]/selection — view as (epic #250 S6)", () => {
  function viewAsRequest(galleryId: string, values: string[]): NextRequest {
    const url = new URL(`http://localhost:3300/api/galleries/${galleryId}/selection`);
    for (const value of values) url.searchParams.append("viewAs", value);
    return new NextRequest(url);
  }

  it("refuses a client sending viewAs, even with their own id, with 400", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    for (const values of [["client-b"], ["client-a"]]) {
      const response = await GET(viewAsRequest(GALLERY_ID, values), paramsFor(GALLERY_ID));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "view_as_admin_only" });
    }
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  it("refuses a STRANGER with 403 before ever parsing viewAs (ownership first)", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(viewAsRequest(GALLERY_ID, ["client-a"]), paramsFor(GALLERY_ID));

    expect(response.status).toBe(403);
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  it("passes an active member as the subject for an admin", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-b",
      removedAt: null,
      selectionLockedAt: null,
      selectionSubmittedAt: null,
    });
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(viewAsRequest(GALLERY_ID, ["client-b"]), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(getGallerySelectionMock).toHaveBeenCalledWith(
      GALLERY_ID,
      expect.any(Object),
      "client-b",
    );
  });

  it.each([
    ["a removed member", { removedAt: new Date("2026-07-29") }],
    ["a non-member", null],
  ])("404s a %s with view_as_not_member", async (_label, membership) => {
    const db = await seededDb();
    if (membership) {
      db.__rows.galleryClients.push({
        galleryId: GALLERY_ID,
        userId: "client-b",
        selectionLockedAt: null,
        selectionSubmittedAt: null,
        ...membership,
      });
    }
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(viewAsRequest(GALLERY_ID, ["client-b"]), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "view_as_not_member" });
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  it.each([["a", "b"], [""]])("400s invalid viewAs (%j)", async (...values) => {
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(viewAsRequest(GALLERY_ID, values), paramsFor(GALLERY_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_view_as" });
  });

  it("gives an admin without the parameter no subject", async () => {
    authMock.mockResolvedValue(adminSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(getGallerySelectionMock).toHaveBeenCalledWith(GALLERY_ID, expect.any(Object), null);
  });

  it("gives a client without the parameter their own id", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(GALLERY_ID), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(getGallerySelectionMock).toHaveBeenCalledWith(
      GALLERY_ID,
      expect.any(Object),
      "client-a",
    );
  });
});
