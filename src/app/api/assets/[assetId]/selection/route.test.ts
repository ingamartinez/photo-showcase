import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

const notifySelectionChangedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: (...args: [string]) => notifySelectionChangedMock(...args),
}));

// The shared in-memory double (src/test-support/fake-db.ts) — filters for real
// off eq()/isNull()/and(), supports `transaction()` and `for("update")`.
vi.mock("@/lib/db", async () => {
  const { assets, assetPicks, galleries, galleryClients, users } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  const fake = createFakeDb([assets, assetPicks, galleries, galleryClients, users]);
  return {
    db: Object.assign(fake, {
      __rows: {
        assets: fake.__tables.get(assets)!,
        assetPicks: fake.__tables.get(assetPicks)!,
        galleries: fake.__tables.get(galleries)!,
        galleryClients: fake.__tables.get(galleryClients)!,
        users: fake.__tables.get(users)!,
      },
    }),
  };
});

type Row = Record<string, unknown>;

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      __rows: {
        assets: Row[];
        assetPicks: Row[];
        galleries: Row[];
        galleryClients: Row[];
        users: Row[];
      };
    };
  };
  return db;
}

const GALLERY_A_ID = "11111111-1111-4111-8111-111111111111";
const GALLERY_B_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ASSET_2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

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
    id: GALLERY_A_ID,
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "proofing",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    originalPhotoPriceCopSnapshot: 2_000,
    allowsOriginalSelection: true,
    rollingDelivery: false,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function assetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_1_ID,
    galleryId: GALLERY_A_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_1_ID}.webp`,
    finalKey: null,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    selectedAt: null,
    requestedAt: null,
    billedTo: null,
    billedAt: null,
    selectionKind: "edited",
    isEdited: false,
    sortOrder: 0,
    createdAt: new Date("2026-07-02"),
    ...overrides,
  };
}

function pickRow(assetId: string, userId: string, overrides: Row = {}): Row {
  return {
    assetId,
    galleryId: GALLERY_A_ID,
    userId,
    kind: "edited",
    pickedAt: new Date("2026-07-02"),
    submittedAt: null,
    ...overrides,
  };
}

function requestFor(assetId: string, selected: boolean): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/selection`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected }),
  });
}

function requestBody(assetId: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/selection`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

const claimed = (overrides: Row = {}): Row =>
  assetRow({
    isSelected: true,
    billedTo: "client-a",
    billedAt: new Date("2026-07-03"),
    ...overrides,
  });

beforeEach(async () => {
  authMock.mockReset();
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.assetPicks.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow({ id: ASSET_1_ID, sortOrder: 0 }));
  db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-a" });
});

describe("PATCH /api/assets/[assetId]/selection — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 403 when a different client toggles someone else's asset", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("lets the asset's own owning client insert their pick", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(1);
    expect(db.__rows.assetPicks[0]).toMatchObject({
      assetId: ASSET_1_ID,
      userId: "client-a",
      kind: "edited",
      submittedAt: null,
    });
  });

  it("refuses an ADMIN with 409 admin_cannot_pick, writing nothing", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const before = structuredClone(db.__rows.assets);
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "admin_cannot_pick" });
    expect(db.__rows.assetPicks).toHaveLength(0);
    expect(db.__rows.assets).toEqual(before);
    expect(notifySelectionChangedMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/assets/[assetId]/selection — validation and not-found", () => {
  it("rejects a malformed asset id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor("not-a-uuid", true), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
  });

  it("rejects a body without a boolean `selected`", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");
    const badRequest = new NextRequest(`http://localhost:3300/api/assets/${ASSET_1_ID}/selection`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected: "yes" }),
    });

    const response = await PATCH(badRequest, paramsFor(ASSET_1_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("rejects a body with neither selected nor selectionKind", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestBody(ASSET_1_ID, {}), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("rejects an invalid selectionKind value", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "premium" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("returns 404 when the asset does not exist", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });
});

describe("PATCH /api/assets/[assetId]/selection — gallery status gate", () => {
  it.each(["selected", "delivered"])(
    "refuses a CLIENT with 409 when the gallery status is %s",
    async (status) => {
      authMock.mockResolvedValue(clientASession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { PATCH } = await import("./route");

      const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
      expect(db.__rows.assetPicks).toHaveLength(0);
    },
  );

  it("refuses a CLIENT with 404 (not 409) when the gallery status is archived", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "archived" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
    expect(db.__rows.assetPicks).toHaveLength(0);
  });

  it.each(["selected", "delivered", "archived"])(
    "refuses an ADMIN with 409 when the gallery status is %s — the lock applies to everyone",
    async (status) => {
      authMock.mockResolvedValue(adminSession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { PATCH } = await import("./route");

      const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
      expect(db.__rows.assetPicks).toHaveLength(0);
    },
  );

  it("still lets a CLIENT insert when the gallery status is proofing", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(1);
  });

  it("refuses a CLIENT with 404 when the gallery status is draft", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });

  it("refuses an ADMIN with 409 admin_cannot_pick when the gallery status is draft", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "admin_cannot_pick" });
  });
});

describe("PATCH /api/assets/[assetId]/selection — the caller's own pick only", () => {
  it("P1 — an insert creates the cart pick, reports pick.status cart and leaves asset.isSelected false", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as {
      asset: { isSelected: boolean };
      pick: { kind: string; submittedAt: string | null; status: string };
    };

    expect(body.asset.isSelected).toBe(false);
    expect(body.pick).toMatchObject({ kind: "edited", submittedAt: null, status: "cart" });
    expect(db.__rows.assetPicks[0]!.submittedAt).toBeNull();
  });

  it("P2 — a double select leaves one row, returns 200 and notifies once", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const first = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const second = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(1);
    expect(notifySelectionChangedMock).toHaveBeenCalledTimes(1);
  });

  it("P3 — B's insert on A's claimed asset degrades, and the legacy asset block names A", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.users.push({ id: "client-a", name: "Ana Pérez", email: "a@example.com" });
    db.__rows.assets[0] = claimed();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as {
      asset: { isSelected: boolean; pickedBy: { id: string; label: string } | null };
      pick: { status: string };
    };

    expect(body.asset.isSelected).toBe(true);
    expect(body.asset.pickedBy).toEqual({ id: "client-a", label: "Ana Pérez" });
    expect(body.pick.status).toBe("degraded");
    expect(db.__rows.assetPicks).toHaveLength(1);
    expect(db.__rows.assetPicks[0]).toMatchObject({ userId: "client-b", kind: "edited" });
  });

  it("P4 — removing B's pick leaves A's pick byte-identical (the incident)", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(
      pickRow(ASSET_1_ID, "client-a", { submittedAt: new Date("2026-07-03") }),
      pickRow(ASSET_1_ID, "client-b"),
    );
    const assetsBefore = structuredClone(db.__rows.assets);
    const aPickBefore = structuredClone(db.__rows.assetPicks[0]);
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(1);
    expect(db.__rows.assetPicks[0]).toEqual(aPickBefore);
    expect(db.__rows.assets).toEqual(assetsBefore);
  });

  // P4's two CART twins. P4 seeds A's pick as SUBMITTED, so the delete's own
  // `submitted_at IS NULL` clause already protects it — the `user_id` half of
  // `pickWhere` never decides that outcome. Carts are exactly where several
  // people coexist on one photo, so these are the rows a regression to "delete
  // every cart pick on the asset" would take down while P4 stayed green.
  it("P4a — removing B's CART pick leaves A's CART pick on the same asset byte-identical", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"), pickRow(ASSET_1_ID, "client-b"));
    const assetsBefore = structuredClone(db.__rows.assets);
    const aPickBefore = structuredClone(
      db.__rows.assetPicks.find((pick) => pick.userId === "client-a"),
    );
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(1);
    expect(db.__rows.assetPicks[0]).toEqual(aPickBefore);
    expect(db.__rows.assetPicks[0]).toMatchObject({ userId: "client-a", kind: "edited" });
    expect(db.__rows.assets).toEqual(assetsBefore);
  });

  it("P4b — retyping B's CART pick (original->edited) leaves A's CART pick byte-identical", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = claimed();
    // Both are CARTS of kind `original`. B's retype (original -> edited) is the
    // one a degraded pick is allowed to make; A's row is the one a retype
    // without the `user_id` predicate would rewrite too.
    db.__rows.assetPicks.push(
      pickRow(ASSET_1_ID, "client-a", { kind: "original" }),
      pickRow(ASSET_1_ID, "client-b", { kind: "original" }),
    );
    const assetsBefore = structuredClone(db.__rows.assets);
    const aPickBefore = structuredClone(
      db.__rows.assetPicks.find((pick) => pick.userId === "client-a"),
    );
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks.find((pick) => pick.userId === "client-b")).toMatchObject({
      kind: "edited",
    });
    // A's cart pick is untouched: still original, still A's.
    expect(db.__rows.assetPicks.find((pick) => pick.userId === "client-a")).toEqual(aPickBefore);
    expect(db.__rows.assetPicks.find((pick) => pick.userId === "client-a")).toMatchObject({
      kind: "original",
    });
    expect(db.__rows.assets).toEqual(assetsBefore);
  });

  it("P5 — a degraded pick can be removed", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-b"));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(0);
  });

  it("P6 — a cart retype works both ways, and a same-kind retype is a no-op without notify", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"));
    const { PATCH } = await import("./route");

    const toOriginal = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    expect(toOriginal.status).toBe(200);
    expect(db.__rows.assetPicks[0]!.kind).toBe("original");

    notifySelectionChangedMock.mockClear();
    const sameKind = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    expect(sameKind.status).toBe(200);
    expect(notifySelectionChangedMock).not.toHaveBeenCalled();

    const back = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );
    expect(back.status).toBe(200);
    expect(db.__rows.assetPicks[0]!.kind).toBe("edited");
  });

  it("P7 — degraded original->edited is allowed; edited->original answers pick_degraded and leaves the row", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-b", { kind: "original" }));
    const { PATCH } = await import("./route");

    const up = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );
    expect(up.status).toBe(200);
    expect(db.__rows.assetPicks[0]!.kind).toBe("edited");

    const down = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    expect(down.status).toBe(409);
    await expect(down.json()).resolves.toEqual({ error: "pick_degraded" });
    // The previous edit survives; the refused change wrote nothing.
    expect(db.__rows.assetPicks[0]!.kind).toBe("edited");
  });

  it.each([
    ["rolling on", true],
    ["rolling off", false],
  ])("P8 — a billed pick cannot be removed or retyped (%s)", async (_name, rolling) => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries[0]!.rollingDelivery = rolling;
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a", { submittedAt: new Date() }));
    const { PATCH } = await import("./route");

    const remove = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    expect(remove.status).toBe(409);
    await expect(remove.json()).resolves.toEqual({ error: "already_requested" });

    const retype = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    expect(retype.status).toBe(409);
    await expect(retype.json()).resolves.toEqual({ error: "already_requested" });
    expect(db.__rows.assetPicks).toHaveLength(1);
  });

  it("P9 — a joined pick cannot be removed or retyped", async () => {
    authMock.mockResolvedValue(clientBSession());
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(
      pickRow(ASSET_1_ID, "client-b", { submittedAt: new Date(), kind: "original" }),
    );
    const { PATCH } = await import("./route");

    const remove = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    expect(remove.status).toBe(409);
    await expect(remove.json()).resolves.toEqual({ error: "already_requested" });

    const retype = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );
    expect(retype.status).toBe(409);
    await expect(retype.json()).resolves.toEqual({ error: "already_requested" });
  });

  it("P10 — the submitted_at CAS: a submit landing between the read and the write refuses remove and retype", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    // A CART pick (unclaimed asset): the edit gate passes, so the refusal
    // observed is the `submitted_at IS NULL` CAS itself, not the gate.
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"));
    const row = db.__rows.assetPicks[0]!;
    let reads = 0;
    Object.defineProperty(row, "submittedAt", {
      configurable: true,
      get: () => (reads++ === 0 ? null : new Date("2026-10-17T10:00:00.000Z")),
      set: () => {},
    });
    const { PATCH } = await import("./route");

    const removed = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    expect(removed.status).toBe(409);
    await expect(removed.json()).resolves.toEqual({ error: "already_requested" });
    expect(db.__rows.assetPicks).toHaveLength(1);
    expect(notifySelectionChangedMock).not.toHaveBeenCalled();

    reads = 0;
    const retype = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    expect(retype.status).toBe(409);
    await expect(retype.json()).resolves.toEqual({ error: "already_requested" });
    expect(db.__rows.assetPicks[0]!.kind).toBe("edited");
  });

  it("P11 — selectionKind-only with no own pick answers asset_not_selected", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_selected" });
    expect(db.__rows.assetPicks).toHaveLength(0);
  });

  it("P17 — originals_not_allowed precedes the insert", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries[0]!.allowsOriginalSelection = false;
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selected: true, selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "originals_not_allowed" });
    expect(db.__rows.assetPicks).toHaveLength(0);
  });

  it("P18 — gate order: the caller lock precedes originals_not_allowed", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries[0]!.allowsOriginalSelection = false;
    db.__rows.galleryClients[0]!.selectionLockedAt = new Date("2026-10-15");
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "client_selection_locked" });
  });
});

describe("PATCH /api/assets/[assetId]/selection — decision 7 is structural", () => {
  it("P12 — the route source writes no `assets` row", async () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/\.(update|insert|delete)\(\s*assets\s*\)/);
  });

  // Every successful PATCH variant: each must leave `assets` byte-identical
  // and the gallery-wide quota unchanged — decision 7 at the route. ASSET_1
  // is free; ASSET_2 is claimed by client-a, so the baseline quota is
  // always exactly one selected asset no matter which pick operation runs.
  type Variant = {
    name: string;
    assetId: string;
    seed: (db: Awaited<ReturnType<typeof seededDb>>) => void;
    body: Record<string, unknown>;
  };
  const variants: Variant[] = [
    {
      name: "insert cart",
      assetId: ASSET_1_ID,
      seed: () => {},
      body: { selected: true },
    },
    {
      name: "double tap insert",
      assetId: ASSET_1_ID,
      seed: (db) => {
        db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"));
      },
      body: { selected: true },
    },
    {
      name: "insert degraded",
      assetId: ASSET_2_ID,
      seed: () => {},
      body: { selected: true },
    },
    {
      name: "remove cart",
      assetId: ASSET_1_ID,
      seed: (db) => {
        db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"));
      },
      body: { selected: false },
    },
    {
      name: "remove degraded",
      assetId: ASSET_2_ID,
      seed: (db) => {
        db.__rows.assetPicks.push(pickRow(ASSET_2_ID, "client-a"));
      },
      body: { selected: false },
    },
    {
      name: "retype cart",
      assetId: ASSET_1_ID,
      seed: (db) => {
        db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"));
      },
      body: { selectionKind: "original" },
    },
    {
      name: "retype degraded original->edited",
      assetId: ASSET_2_ID,
      seed: (db) => {
        db.__rows.assetPicks.push(pickRow(ASSET_2_ID, "client-a", { kind: "original" }));
      },
      body: { selectionKind: "edited" },
    },
    {
      name: "no-op remove",
      assetId: ASSET_1_ID,
      seed: () => {},
      body: { selected: false },
    },
  ];

  /** Every `asset_picks` row the caller does NOT own. */
  const otherPeoplePicks = (db: Awaited<ReturnType<typeof seededDb>>, caller: string) =>
    db.__rows.assetPicks.filter((pick) => pick.userId !== caller);

  it.each(variants)(
    "P13/P14 — $name leaves assets deep-equal, other people's picks deep-equal and quota unchanged",
    async (variant) => {
      authMock.mockResolvedValue(clientASession());
      const db = await seededDb();
      db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
      // The claimed sibling every variant shares.
      db.__rows.assets.push(claimed({ id: ASSET_2_ID, sortOrder: 1 }));
      variant.seed(db);
      // A SECOND person's CART pick on the very asset the variant targets, of
      // the KIND OPPOSITE to whatever this variant writes. A stray `user_id`
      // predicate loses it (delete / retype of a cart), and `pickWhere` is the
      // only thing standing between the caller and somebody else's cart.
      const bystanderKind = variant.body.selectionKind === "original" ? "edited" : "original";
      db.__rows.assetPicks.push(pickRow(variant.assetId, "client-b", { kind: bystanderKind }));
      const assetsBefore = structuredClone(db.__rows.assets);
      const othersBefore = structuredClone(otherPeoplePicks(db, "client-a"));
      const { PATCH } = await import("./route");

      const response = await PATCH(
        requestBody(variant.assetId, variant.body),
        paramsFor(variant.assetId),
      );
      const body = (await response.json()) as { quota: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(db.__rows.assets).toEqual(assetsBefore);
      // Decision 7's other half, in the same breath: no row the caller does
      // not own moved either. The stub above is still there, still that kind,
      // still unsubmitted.
      expect(otherPeoplePicks(db, "client-a")).toEqual(othersBefore);
      expect(otherPeoplePicks(db, "client-a")).toHaveLength(1);
      // The quota is a pure function of the (unchanged) sibling rows: exactly
      // the one claimed ASSET_2.
      expect(body.quota).toMatchObject({
        selected: 1,
        selectedEdited: 1,
        selectedOriginal: 0,
        extras: 0,
        surchargeCop: 0,
      });
    },
  );
});

describe("PATCH /api/assets/[assetId]/selection — allowsOriginalSelection is OFF (task #214)", () => {
  it("refuses a type-only change to original with 409, without touching the pick", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries[0]!.allowsOriginalSelection = false;
    db.__rows.assetPicks.push(pickRow(ASSET_1_ID, "client-a"));
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "originals_not_allowed" });
    expect(db.__rows.assetPicks[0]!.kind).toBe("edited");
  });

  it("still allows the ordinary toggle, unaffected by the switch", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries[0]!.allowsOriginalSelection = false;
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks[0]!.kind).toBe("edited");
  });
});

describe("PATCH /api/assets/[assetId]/selection — per-client lock and other people's picks", () => {
  async function groupGallery(options: { aSubmitted?: boolean; bLocked?: boolean } = {}) {
    const db = await seededDb();
    db.__rows.galleryClients.length = 0;
    db.__rows.galleryClients.push(
      {
        galleryId: GALLERY_A_ID,
        userId: "client-a",
        removedAt: null,
        selectionLockedAt: null,
        selectionSubmittedAt: null,
      },
      {
        galleryId: GALLERY_A_ID,
        userId: "client-b",
        removedAt: null,
        selectionLockedAt: options.bLocked ? new Date("2026-10-15") : null,
        selectionSubmittedAt: options.bLocked ? new Date("2026-10-15") : null,
      },
    );
    db.__rows.assets[0] = claimed();
    db.__rows.assetPicks.push(
      pickRow(ASSET_1_ID, "client-a", {
        submittedAt: options.aSubmitted ? new Date("2026-10-15") : null,
      }),
    );
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, sortOrder: 1 }));
    return db;
  }

  it("B acting on A's submitted photo touches only B's own row", async () => {
    const db = await groupGallery({ aSubmitted: true });
    authMock.mockResolvedValue(clientBSession());
    const aPickBefore = structuredClone(db.__rows.assetPicks[0]);
    const assetsBefore = structuredClone(db.__rows.assets);
    const { PATCH } = await import("./route");

    // Remove: B has no pick, so it is a no-op 200.
    const remove = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    expect(remove.status).toBe(200);
    expect(db.__rows.assetPicks[0]).toEqual(aPickBefore);

    // Retype: B has no pick, so it is refused.
    const retype = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );
    expect(retype.status).toBe(409);
    await expect(retype.json()).resolves.toEqual({ error: "asset_not_selected" });

    // Select: B inserts their own degraded pick.
    const insert = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    expect(insert.status).toBe(200);
    expect(db.__rows.assetPicks).toHaveLength(2);
    expect(db.__rows.assetPicks[1]).toMatchObject({ userId: "client-b" });
    expect(db.__rows.assets).toEqual(assetsBefore);
  });

  it("refuses B with client_selection_locked when B is locked", async () => {
    await groupGallery({ aSubmitted: true, bLocked: true });
    authMock.mockResolvedValue(clientBSession());
    const { PATCH } = await import("./route");

    for (const [assetId, body] of [
      [ASSET_1_ID, { selected: true }],
      [ASSET_2_ID, { selected: true }],
    ] as const) {
      const response = await PATCH(requestBody(assetId, body), paramsFor(assetId));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "client_selection_locked" });
    }
  });

  it("keeps the gallery-level gate for everyone: a selected gallery still refuses with gallery_locked", async () => {
    const db = await groupGallery({ aSubmitted: true, bLocked: true });
    db.__rows.galleries[0]!.status = "selected";
    authMock.mockResolvedValue(adminSession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
  });

  it("ignores locks the same users hold in ANOTHER gallery", async () => {
    const db = await groupGallery();
    const LOCKED_ELSEWHERE = {
      removedAt: null,
      selectionLockedAt: new Date("2026-10-15"),
      selectionSubmittedAt: new Date("2026-10-15"),
    };
    db.__rows.galleryClients.unshift(
      { galleryId: GALLERY_B_ID, userId: "client-a", ...LOCKED_ELSEWHERE },
      { galleryId: GALLERY_B_ID, userId: "client-b", ...LOCKED_ELSEWHERE },
    );
    authMock.mockResolvedValue(clientBSession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_2_ID, true), paramsFor(ASSET_2_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assetPicks.some((p) => p.userId === "client-b")).toBe(true);
  });

  it("refuses a REMOVED client's lock: its pick is still theirs, not protected by a stale lock", async () => {
    const db = await groupGallery();
    // client-a is removed and has no pick here; client-b picks freely.
    db.__rows.galleryClients[0]!.removedAt = new Date("2026-09-01");
    authMock.mockResolvedValue(clientBSession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_2_ID, true), paramsFor(ASSET_2_ID));

    expect(response.status).toBe(200);
  });
});

describe("SELECTION_LOCKED_STATUSES — single shared definition (task #58)", () => {
  it("is reference-identical to the shared ASSET_MUTATION_BLOCKED_STATUSES", async () => {
    const { SELECTION_LOCKED_STATUSES } = await import("./route");
    const { ASSET_MUTATION_BLOCKED_STATUSES } = await import("@/lib/asset-access");

    expect(SELECTION_LOCKED_STATUSES).toBe(ASSET_MUTATION_BLOCKED_STATUSES);
  });
});
