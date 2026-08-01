import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Task #114: this route is one of the three write paths that must signal the
// shared selection changed. Mocked (not the real `@/lib/db`-backed module)
// because this suite's whole point is proving the DATABASE write, not the
// pub/sub plumbing (see selection-events.test.ts for that).
const notifySelectionChangedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/selection-events", () => ({
  notifySelectionChanged: (...args: [string]) => notifySelectionChangedMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — same
// `eqColumnAndValue` (the CORRECTED version, see
// src/app/api/galleries/[galleryId]/proofs/route.test.ts's comment) plus a
// real `update`. `where()` on `assets` returns an object that is both
// directly awaitable (a plain `.select().from().where(cond)` with no further
// chained call, the shape this route's re-read query uses) AND still
// supports `.limit()` (the shape `loadOwnedAsset` uses) — mirroring how the
// real drizzle query builder is itself thenable. `@/lib/asset-access` is
// deliberately left UNMOCKED: this suite exercises the real ownership check
// end to end through the route, same reasoning as every sibling asset route
// test.
type Row = Record<string, unknown>;

// Resolves EVERY `eq()` this condition is built from, however deep — a bare
// `eq()` at the top level, or several nested inside an `and(...)` (drizzle
// wraps `and(eqA, eqB)` in an EXTRA parens/`" and "` SQL node one level
// deeper than a flat `queryChunks` array). Task #94's `isGalleryOwner`
// (src/lib/gallery-access.ts) is the first caller in this suite to need the
// `and(eq(), eq())` shape at all — every prior `eq()`-only condition here
// still resolves to a single-element list.
function eqConditions(condition: unknown): { column?: string; value?: unknown }[] {
  const results: { column?: string; value?: unknown }[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!chunks) return;
    let dbColumnName: string | undefined;
    let table: unknown;
    let value: unknown;
    for (const chunk of chunks) {
      if (chunk && typeof chunk === "object") {
        if ("name" in chunk && "table" in chunk) {
          dbColumnName = (chunk as { name: string }).name;
          table = (chunk as { table: unknown }).table;
        }
        if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
      }
    }
    if (dbColumnName && table) {
      const jsKey = Object.entries(table as Record<string, unknown>).find(
        ([, col]) =>
          col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
      )?.[0];
      results.push({ column: jsKey, value });
      return;
    }
    for (const chunk of chunks) walk(chunk);
  }
  walk(condition);
  return results;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries, galleryClients, users } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];
  const userRows: Row[] = [];

  function project(row: Row, columns: Record<string, unknown> | undefined): Row {
    if (!columns) return row;
    const projected: Row = {};
    for (const key of Object.keys(columns)) projected[key] = row[key];
    return projected;
  }

  function rowsFor(table: unknown): Row[] {
    if (table === assets) return assetRows;
    if (table === galleries) return galleryRows;
    if (table === galleryClients) return galleryClientRows;
    // Task #206 — the type-only-change branch looks up a DIFFERENT picker's
    // name when the acting session isn't the original one; see this route's
    // own comment on why it never substitutes the acting session's name.
    if (table === users) return userRows;
    throw new Error("fake db: unsupported table in select().where()");
  }

  function selectFrom(columns: Record<string, unknown> | undefined, table: unknown) {
    return {
      where: (condition: unknown) => {
        const conditions = eqConditions(condition);
        if (conditions.length === 0 || conditions.some((c) => !c.column)) {
          throw new Error("eqConditions: not a supported eq()/and(eq(), eq()) condition");
        }
        const matches = (r: Row) => conditions.every(({ column, value }) => r[column!] === value);

        if (table === assets) {
          const rows = assetRows.filter(matches).map((r) => project(r, columns));
          const resultPromise = Promise.resolve(rows);
          return {
            limit: async (n: number) => rows.slice(0, n),
            then: resultPromise.then.bind(resultPromise),
            catch: resultPromise.catch.bind(resultPromise),
          };
        }
        // Round-2 review finding: this branch used to skip `project()`
        // entirely, so a query reading a column it never selected (or a
        // typo'd alias) would pass here regardless — `assets`' own branch
        // above already projected; the other tables (this route's own
        // `users` lookup is the first non-`assets` caller through here) must
        // too.
        const rows = rowsFor(table)
          .filter(matches)
          .map((r) => project(r, columns));
        return { limit: async (n: number) => rows.slice(0, n) };
      },
    };
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => selectFrom(columns, table),
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: async (condition: unknown) => {
            if (table !== assets) throw new Error("fake db: unsupported table in update()");
            const conditions = eqConditions(condition);
            if (conditions.length === 0 || conditions.some((c) => !c.column)) {
              throw new Error("eqConditions: not a supported eq()/and(eq(), eq()) condition");
            }
            for (const row of assetRows) {
              if (conditions.every(({ column, value }) => row[column!] === value)) {
                Object.assign(row, patch);
              }
            }
          },
        }),
      }),
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: {
        assets: assetRows,
        galleries: galleryRows,
        galleryClients: galleryClientRows,
        users: userRows,
      },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; galleries: Row[]; galleryClients: Row[]; users: Row[] } };
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
    // Task #214 — defaults ON: this file predates the switch and exercises
    // `selectionKind: "original"` writes throughout as the domain's own
    // established behavior. The "allowsOriginalSelection is OFF" describe
    // block below overrides this explicitly, which is the ONLY thing that
    // proves the server gate — see this route's own header comment on why a
    // UI-only gate is not enough.
    allowsOriginalSelection: true,
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
    // Task #206 — the domain's own default; the tests exercising a type
    // change override this explicitly.
    selectionKind: "edited",
    isEdited: false,
    sortOrder: 0,
    createdAt: new Date("2026-07-02"),
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

beforeEach(async () => {
  authMock.mockReset();
  notifySelectionChangedMock.mockReset();
  notifySelectionChangedMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleryClients.length = 0;
  db.__rows.users.length = 0;
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow({ id: ASSET_1_ID, sortOrder: 0 }));
  // Task #94: ownership is now a `gallery_clients` row, not a `clientId`
  // column on the gallery itself.
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

  it("lets the asset's own owning client toggle it", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
  });

  it("lets an admin toggle any asset regardless of which client owns the gallery", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.assets.length = 0;
    db.__rows.galleryClients.length = 0;
    db.__rows.galleries.push(galleryRow({ id: GALLERY_B_ID }));
    db.__rows.galleryClients.push({ galleryId: GALLERY_B_ID, userId: "client-b" });
    db.__rows.assets.push(assetRow({ galleryId: GALLERY_B_ID }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
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
  // `selected`/`delivered` are still visible to a CLIENT (src/lib/galleries.ts's
  // `CLIENT_VISIBLE_STATUSES`), so a client's request passes the visibility
  // gate and reaches the lock gate, getting the honest 409 — not a 404 that
  // would hide the reason from the caller who is otherwise allowed to know
  // this gallery exists.
  it.each(["selected", "delivered"])(
    "refuses a CLIENT with 409 when the gallery status is %s, without touching is_selected",
    async (status) => {
      authMock.mockResolvedValue(clientASession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { PATCH } = await import("./route");

      const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
      expect(db.__rows.assets[0]?.isSelected).toBe(false);
    },
  );

  // `archived` is NOT in `CLIENT_VISIBLE_STATUSES` at all (galleries.ts's own
  // comment: an undefined future status fails closed rather than silently
  // rendering) — so a client's request never reaches the lock gate; it's
  // refused at the visibility gate first, with the same 404 `loadOwnedAsset`
  // already uses for "doesn't exist", not a 409 that would confirm the
  // gallery is real.
  it("refuses a CLIENT with 404 (not 409) when the gallery status is archived, since archived isn't client-visible at all", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "archived" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
    expect(db.__rows.assets[0]?.isSelected).toBe(false);
  });

  // An ADMIN bypasses the visibility gate entirely (same as the proof route,
  // task #63), so all three locked statuses reach the SAME lock gate a
  // client's `selected`/`delivered` request does above — refused for
  // everyone, admin included.
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
      expect(db.__rows.assets[0]?.isSelected).toBe(false);
    },
  );

  it("still allows the toggle for a CLIENT when the gallery status is proofing", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "proofing" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assets[0]?.isSelected).toBe(true);
  });

  // The headline finding this test guards against: a `draft` gallery is
  // "not yet visible to client" (PLAN.md §2) — a CLIENT must be refused here
  // exactly as they are refused when trying to VIEW the gallery
  // (src/app/galleries/[publicSlug]/page.tsx's own `notFound()` for draft),
  // not merely left to fall through an admin-shaped lock set that has no
  // opinion on draft at all.
  it("refuses a CLIENT with 404 when the gallery status is draft — a draft gallery is not writable by them either", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
    expect(db.__rows.assets[0]?.isSelected).toBe(false);
  });

  // An ADMIN legitimately works in `draft` (uploading/arranging proofs
  // before publishing) — same bypass as the proof route.
  it("still allows the toggle for an ADMIN when the gallery status is draft", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    // Admin bypasses ownership entirely (src/lib/gallery-access.ts) — no
    // `gallery_clients` row is seeded for this gallery at all, on purpose.
    db.__rows.galleryClients.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "draft" }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assets[0]?.isSelected).toBe(true);
  });
});

describe("PATCH /api/assets/[assetId]/selection — persistence and quota recomputation", () => {
  it("persists is_selected and selected_at on select", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as { asset: { isSelected: boolean; selectedAt: string } };

    expect(body.asset.isSelected).toBe(true);
    expect(body.asset.selectedAt).not.toBeNull();
    expect(db.__rows.assets[0]?.isSelected).toBe(true);
    expect(db.__rows.assets[0]?.selectedAt).toBeInstanceOf(Date);
  });

  // Task #114: every OTHER open session's tray converges off THIS signal —
  // dropping this call silently degrades the whole product back to a 30s
  // fallback poll with no test ever noticing, which is exactly the risk
  // src/lib/selection-events.ts's own header comment names as the tradeoff
  // of an application call over a database trigger.
  it("signals the shared-selection change for this asset's OWN gallery, after the write", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_A_ID);
  });

  it("still responds 200 even if the change signal itself fails", async () => {
    // Fire-and-forget, by design (src/lib/selection-events.ts's own header
    // comment) — the toggle already committed, and a NOTIFY failure must
    // never turn a successful mutation into a failed response.
    notifySelectionChangedMock.mockRejectedValue(new Error("notify boom"));
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
  });

  it("clears selected_at on deselect", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({ isSelected: true, selectedAt: new Date("2026-07-10") });
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as { asset: { isSelected: boolean; selectedAt: null } };

    expect(body.asset.isSelected).toBe(false);
    expect(body.asset.selectedAt).toBeNull();
    expect(db.__rows.assets[0]?.selectedAt).toBeNull();
  });

  // Task #94's "shared selection, ATTRIBUTED" decision — schema.ts's comment
  // on `assets.selectedBy` requires this route to keep it in lockstep with
  // `isSelected`, in BOTH directions. Unattributed selections made in
  // production can never be attributed retroactively, so this is the
  // headline regression this test exists to catch.
  it("stamps selected_by with the acting session's user id on select", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assets[0]?.selectedBy).toBe("client-a");
  });

  it("clears selected_by back to null on deselect, even though a different actor selected it", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({
      isSelected: true,
      selectedAt: new Date("2026-07-10"),
      selectedBy: "client-b",
    });
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assets[0]?.selectedBy).toBeNull();
  });

  // Task #95: the collaborative tray moves a photo the instant the SERVER
  // confirms the pick, and it needs a name to put under it. Reported back by
  // the route that just wrote the attribution rather than assembled on the
  // client — same "never derive a fact the server can hand you" stance the
  // `quota` field already follows.
  it("reports back who it recorded as the picker, so the tray never has to guess", async () => {
    authMock.mockResolvedValue({
      user: { id: "client-a", role: "client", email: "a@example.com", name: "Ana Pérez" },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as {
      asset: { pickedBy: { id: string; label: string } | null };
    };

    expect(body.asset.pickedBy).toEqual({ id: "client-a", label: "Ana Pérez" });
  });

  it("falls back to the email when the picker has no name, never to a blank label", async () => {
    authMock.mockResolvedValue(clientASession());
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as {
      asset: { pickedBy: { id: string; label: string } | null };
    };

    expect(body.asset.pickedBy).toEqual({ id: "client-a", label: "a@example.com" });
  });

  it("reports a null picker on deselect, in lockstep with the column it just cleared", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({ isSelected: true, selectedBy: "client-b" });
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as { asset: { pickedBy: unknown } };

    expect(body.asset.pickedBy).toBeNull();
  });

  // The task's core acceptance criterion: the response's `quota` is a fresh
  // server-side recomputation off the gallery's frozen snapshot, not
  // anything the client could have supplied or incremented itself.
  it("returns a quota recomputed from every sibling asset's is_selected flag, off the gallery's snapshot terms", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, isSelected: true, sortOrder: 1 }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as {
      quota: {
        selected: number;
        includedPhotosSnapshot: number;
        extraPhotoPriceCopSnapshot: number;
        extras: number;
        surchargeCop: number;
      };
    };

    // Both ASSET_1 (just selected) and ASSET_2 (already selected) count —
    // 2 selected against a snapshot of 13 included means no extras yet.
    expect(body.quota).toEqual({
      selected: 2,
      selectedEdited: 2,
      selectedOriginal: 0,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
    });
  });

  it("reflects extras and surcharge once the count passes the snapshot's included quota", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 1 }));
    db.__rows.assets.push(assetRow({ id: ASSET_2_ID, isSelected: true, sortOrder: 1 }));
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as {
      quota: { selected: number; extras: number; surchargeCop: number };
    };

    expect(body.quota).toEqual({
      selected: 2,
      selectedEdited: 2,
      selectedOriginal: 0,
      includedPhotosSnapshot: 1,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
      extras: 1,
      originals: 0,
      extrasSurchargeCop: 5_000,
      originalsSurchargeCop: 0,
      surchargeCop: 5_000,
    });
  });
});

describe("PATCH /api/assets/[assetId]/selection — setting the type (task #206)", () => {
  // Criterion 1 — mark a picked photo `original`, then back to `edited`.
  it("sets selection_kind on an already-selected asset without touching is_selected", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    const body = (await response.json()) as {
      asset: { isSelected: boolean; selectionKind: string };
    };

    expect(response.status).toBe(200);
    expect(body.asset.isSelected).toBe(true);
    expect(body.asset.selectionKind).toBe("original");
    expect(db.__rows.assets[0]?.selectionKind).toBe("original");
    expect(db.__rows.assets[0]?.isSelected).toBe(true);

    // And back — criterion 1's own round trip.
    const back = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );
    const backBody = (await back.json()) as { asset: { selectionKind: string } };
    expect(backBody.asset.selectionKind).toBe("edited");
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });

  // Criterion 2, first half — a type change is not a deselect.
  it("never touches is_selected, selected_at or selected_by on a type-only change", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    const selectedAt = new Date("2026-07-10T00:00:00.000Z");
    db.__rows.assets[0] = assetRow({
      isSelected: true,
      selectedAt,
      selectedBy: "client-a",
      selectionKind: "edited",
    });
    const { PATCH } = await import("./route");

    await PATCH(requestBody(ASSET_1_ID, { selectionKind: "original" }), paramsFor(ASSET_1_ID));

    expect(db.__rows.assets[0]?.isSelected).toBe(true);
    expect(db.__rows.assets[0]?.selectedAt).toBe(selectedAt);
    expect(db.__rows.assets[0]?.selectedBy).toBe("client-a");
  });

  // Criterion 2, second half — deselecting and re-selecting returns to
  // `edited`, even though the asset was `original` a moment ago.
  it("resets selection_kind to edited when the plain select control re-selects a photo that was marked original", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "original" });
    const { PATCH } = await import("./route");

    // Deselect (the plain toggle, no `selectionKind` in the body).
    await PATCH(requestFor(ASSET_1_ID, false), paramsFor(ASSET_1_ID));
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");

    // Re-select.
    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));
    const body = (await response.json()) as { asset: { selectionKind: string } };

    expect(body.asset.selectionKind).toBe("edited");
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });

  // The trap named in the task body: a photo that is not selected has no
  // type. Refused with 409, the same "authorized caller, wrong asset state"
  // shape the lock gate above uses — not silently accepted, not a 404 (the
  // asset is real and this client does own it).
  it("refuses a type-only change on an asset that is not selected", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({ isSelected: false, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_selected" });
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });

  // The state gate applies to a type change exactly as it applies to a
  // toggle — the task body's own named trap ("es fácil acordarse de gatear
  // 'elegir' y olvidarse de gatear 'cambiar el tipo'"). At least two of the
  // three locked statuses, per criterion 6.
  it.each(["selected", "delivered"])(
    "refuses a type-only change with 409 when the gallery status is %s, without touching selection_kind",
    async (status) => {
      authMock.mockResolvedValue(clientASession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "edited" });
      const { PATCH } = await import("./route");

      const response = await PATCH(
        requestBody(ASSET_1_ID, { selectionKind: "original" }),
        paramsFor(ASSET_1_ID),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
      expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
    },
  );

  it("refuses a type-only change with 409 when the gallery status is archived, for an admin too — the lock applies to everyone", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "archived" }));
    db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "gallery_locked" });
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
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
    const db = await seededDb();
    db.__rows.assets[0] = assetRow({ isSelected: true });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "premium" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_body" });
  });

  // The quota split: an original never draws from the included-photos quota,
  // no matter how much room the quota has left. THE test that distinguishes
  // a correct implementation from one that ignores the split — both terms
  // non-zero, chosen so neither is a multiple of the other.
  it("recomputes the quota split between edited and original picks after a type change", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ includedPhotosSnapshot: 2 }));
    // ASSET_1 is about to become `original`. Three more edited picks put the
    // edited count at 3, one over the included 2.
    db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "edited" });
    db.__rows.assets.push(
      assetRow({ id: ASSET_2_ID, isSelected: true, selectionKind: "edited", sortOrder: 1 }),
      assetRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        isSelected: true,
        selectionKind: "edited",
        sortOrder: 2,
      }),
      assetRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        isSelected: true,
        selectionKind: "edited",
        sortOrder: 3,
      }),
    );
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    const body = (await response.json()) as {
      quota: {
        selectedEdited: number;
        selectedOriginal: number;
        extras: number;
        originals: number;
        surchargeCop: number;
      };
    };

    // 3 edited (ASSET_2/3/4) -> 1 over the 2 included -> 5_000 edited surcharge.
    // 1 original (ASSET_1) -> 2_000 more, additive, never drawing from the
    // included quota that still has room.
    expect(body.quota.selectedEdited).toBe(3);
    expect(body.quota.selectedOriginal).toBe(1);
    expect(body.quota.extras).toBe(1);
    expect(body.quota.originals).toBe(1);
    expect(body.quota.surchargeCop).toBe(5_000 + 2_000);
  });

  // The race this route's OWN attribution logic guards against: client B
  // changes the type of a photo client A picked. The response must name A,
  // not mislabel B's own name onto A's id.
  it("reports the ORIGINAL picker's own name, not the acting session's, on a type-only change made by someone else", async () => {
    authMock.mockResolvedValue({
      user: { id: "client-b", role: "client", email: "b@example.com", name: "Beto Ruiz" },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const db = await seededDb();
    // Task #94: both clients attached to the same gallery.
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = assetRow({ isSelected: true, selectedBy: "client-a" });
    // Round-2 review finding: this row MUST be seeded for the assertion below
    // to mean anything — an unseeded `users` table makes the lookup return
    // nothing no matter what the route does with its result, which is
    // exactly how `pickedBy = null` slipped through as a passing mutation
    // the first time this test was written.
    db.__rows.users.push({ id: "client-a", name: "Ana Pérez", email: "a@example.com" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    const body = (await response.json()) as { asset: { pickedBy: { id: string; label: string } } };

    // The ORIGINAL picker's real name (from the seeded `users` row) — never
    // "Beto Ruiz", the ACTING session's own name, which the route must not
    // substitute for a different picker's id.
    expect(body.asset.pickedBy).toEqual({ id: "client-a", label: "Ana Pérez" });
  });

  // The fallback this route's own comment names: `selected_by` pointing at a
  // user row that no longer exists (`onDelete: "set null"`) is a narrow,
  // reachable window, not a bug — same honest "no attribution" outcome
  // `gallery-selection.ts` already gives it. Seeded users table, genuinely
  // empty result — not an unseeded table standing in for "nothing to find".
  it("reports no attribution when the original picker's user row no longer exists", async () => {
    authMock.mockResolvedValue({
      user: { id: "client-b", role: "client", email: "b@example.com", name: "Beto Ruiz" },
      expires: "2099-01-01T00:00:00.000Z",
    });
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-b" });
    db.__rows.assets[0] = assetRow({ isSelected: true, selectedBy: "deleted-user" });
    // A DECOY row, deliberately NOT matching "deleted-user" — round-3 review
    // finding: without this, `db.__rows.users` stays empty (only ever pushed
    // to by the PREVIOUS test), and an unseeded table can't distinguish "the
    // lookup ran and found nothing" from "the lookup never ran at all". This
    // row proves the `users` table genuinely has rows in it and the query
    // still, correctly, finds none matching this asset's `selected_by`.
    db.__rows.users.push({ id: "client-a", name: "Ana Pérez", email: "a@example.com" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );
    const body = (await response.json()) as { asset: { pickedBy: unknown } };

    expect(body.asset.pickedBy).toBeNull();
  });
});

// Task #214 — THE MUTATION THAT MATTERS MOST FOR THIS TASK, per its own
// kanban body: a gate that only lives in the UI (proof-tile.tsx hiding the
// type buttons) is not a gate, because this route is reachable directly by
// any client attached to the gallery regardless of what their own tab
// currently renders. Every test below sets `allowsOriginalSelection: false`
// on the gallery row explicitly — the default fixture above is `true`
// specifically so these are the ONLY tests exercising the OFF gate, and a
// regression that deleted the gate entirely would turn every one of these
// red without touching anything else in this file.
describe("PATCH /api/assets/[assetId]/selection — allowsOriginalSelection is OFF (task #214)", () => {
  it("refuses a type-only change to original with 409, without touching selection_kind", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ allowsOriginalSelection: false }));
    db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "originals_not_allowed" });
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });

  // The OTHER shape this route's own header comment documents: an atomic
  // "select AND mark original" in ONE request (`selected` and `selectionKind`
  // both present). A gate that only covered the type-only branch above would
  // leave this one reachable — the exact gap this test exists to close.
  it("refuses an atomic select-and-mark-original combo with 409, without selecting the asset at all", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ allowsOriginalSelection: false }));
    db.__rows.assets[0] = assetRow({ isSelected: false, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selected: true, selectionKind: "original" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "originals_not_allowed" });
    expect(db.__rows.assets[0]?.isSelected).toBe(false);
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });

  // The plain select/deselect toggle (no `selectionKind` in the body at all)
  // must be COMPLETELY unaffected by the switch — this gate only ever
  // refuses a REQUESTED "original", never an ordinary pick.
  it("still allows the ordinary select/deselect toggle, unaffected by the switch", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ allowsOriginalSelection: false }));
    db.__rows.assets[0] = assetRow({ isSelected: false, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(requestFor(ASSET_1_ID, true), paramsFor(ASSET_1_ID));

    expect(response.status).toBe(200);
    expect(db.__rows.assets[0]?.isSelected).toBe(true);
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });

  // An explicit `selectionKind: "edited"` request must still succeed while
  // the switch is off — the gate refuses "original" specifically, not the
  // whole `selectionKind` field.
  it("still allows an explicit type-only change to edited, unaffected by the switch", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ allowsOriginalSelection: false }));
    db.__rows.assets[0] = assetRow({ isSelected: true, selectionKind: "edited" });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      requestBody(ASSET_1_ID, { selectionKind: "edited" }),
      paramsFor(ASSET_1_ID),
    );

    expect(response.status).toBe(200);
    expect(db.__rows.assets[0]?.selectionKind).toBe("edited");
  });
});

// Task #58: proves this route's mutation lock is literally the SAME Set as
// the DELETE/reorder routes' — not a separately maintained copy of the same
// three strings, which is exactly the shape that drifted silently before.
// `SELECTION_LOCKED_STATUSES` stays exported under its task-#73 name (the
// unlock-action suite imports it by that name) but is now an alias for
// `ASSET_MUTATION_BLOCKED_STATUSES`, checked here by reference (`toBe`, not
// `toEqual`) so a future refactor that reintroduces a second `new Set([...])`
// literal fails this assertion immediately.
describe("SELECTION_LOCKED_STATUSES — single shared definition (task #58)", () => {
  it("is reference-identical to the shared ASSET_MUTATION_BLOCKED_STATUSES", async () => {
    const { SELECTION_LOCKED_STATUSES } = await import("./route");
    const { ASSET_MUTATION_BLOCKED_STATUSES } = await import("@/lib/asset-access");

    expect(SELECTION_LOCKED_STATUSES).toBe(ASSET_MUTATION_BLOCKED_STATUSES);
  });
});
