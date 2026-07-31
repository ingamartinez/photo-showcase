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

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering off
// `eq()`/`and(eq(), eq())` conditions (this route's atomic conditional
// UPDATE needs the latter; every sibling route test so far has only ever
// needed the former). `and()`'s own queryChunks nest an inner `sql.join(...)`
// SQL object rather than laying every chunk flat at the top level (verified
// by reading node_modules/drizzle-orm/sql/expressions/conditions.js
// directly, not assumed) — `flattenChunks` below recurses into any chunk
// that itself carries `queryChunks` so both shapes end up in the same flat
// list `eqConditions` scans.
type Row = Record<string, unknown>;

function flattenChunks(node: unknown, out: unknown[]): void {
  if (node && typeof node === "object" && "queryChunks" in node) {
    for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) {
      flattenChunks(chunk, out);
    }
    return;
  }
  out.push(node);
}

function eqConditions(condition: unknown): { dbColumnName: string; value: unknown }[] {
  const flat: unknown[] = [];
  flattenChunks(condition, flat);

  const dbColumnNames: string[] = [];
  const values: unknown[] = [];
  for (const chunk of flat) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnNames.push((chunk as { name: string }).name);
      } else if ("value" in chunk && "encoder" in chunk) {
        values.push((chunk as { value: unknown }).value);
      }
    }
  }
  if (dbColumnNames.length === 0 || dbColumnNames.length !== values.length) {
    throw new Error("eqConditions: not a supported eq()/and(eq(), eq()) condition");
  }
  return dbColumnNames.map((dbColumnName, i) => ({ dbColumnName, value: values[i] }));
}

function jsKeyFor(table: Record<string, unknown>, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`jsKeyFor: no column named ${dbColumnName} on this table`);
  return found[0];
}

function matchesRow(row: Row, table: Record<string, unknown>, condition: unknown): boolean {
  return eqConditions(condition).every(
    ({ dbColumnName, value }) => row[jsKeyFor(table, dbColumnName)] === value,
  );
}

function project(row: Row, columns: Record<string, unknown> | undefined): Row {
  if (!columns) return row;
  const projected: Row = {};
  for (const key of Object.keys(columns)) projected[key] = row[key];
  return projected;
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries, users } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const assetRows: Row[] = [];
  const userRows: Row[] = [];

  function rowsFor(table: unknown): Row[] {
    if (table === galleries) return galleryRows;
    if (table === assets) return assetRows;
    if (table === users) return userRows;
    throw new Error("fake db: unsupported table");
  }

  // Drizzle's `PgTable` type carries no index signature (each column is its
  // own named, strongly-typed property) — `matchesRow`/`jsKeyFor` only ever
  // need to enumerate those properties at runtime via `Object.entries`, so
  // the cast here is purely to satisfy that mismatch, not a claim about the
  // real shape.
  function tableShapeFor(table: unknown): Record<string, unknown> {
    if (table === galleries) return galleries as unknown as Record<string, unknown>;
    if (table === assets) return assets as unknown as Record<string, unknown>;
    if (table === users) return users as unknown as Record<string, unknown>;
    throw new Error("fake db: unsupported table");
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const rows = rowsFor(table)
              .filter((row) => matchesRow(row, tableShapeFor(table), condition))
              .map((row) => project(row, columns));
            const resultPromise = Promise.resolve(rows);
            return {
              limit: async (n: number) => rows.slice(0, n),
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
            };
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: (condition: unknown) => {
            if (table !== galleries) throw new Error("fake db: unsupported table in update()");
            const matches = galleryRows.filter((row) =>
              matchesRow(row, galleries as unknown as Record<string, unknown>, condition),
            );
            for (const row of matches) Object.assign(row, patch);
            const snapshot = matches.map((row) => ({ ...row }));
            const promise = Promise.resolve(snapshot) as Promise<Row[]> & {
              returning: () => Promise<Row[]>;
            };
            promise.returning = async () => snapshot;
            return promise;
          },
        }),
      }),
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: { galleries: galleryRows, assets: assetRows, users: userRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; assets: Row[]; users: Row[] } };
  };
  return db;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "client-a";
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
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    selectedAt: null,
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
    async (_galleryId, session) => session.user.role === "admin" || session.user.id === CLIENT_ID,
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
  db.__rows.galleries.push(galleryRow());
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
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        extras: 0,
        surchargeCop: 0,
      },
      submittedAt: "2026-07-28T10:00:00.000Z",
    });
    expect(sendSubmissionNotificationEmailMock).not.toHaveBeenCalled();
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
      includedPhotosSnapshot: 1,
      extraPhotoPriceCopSnapshot: 5_000,
      extras: 1,
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

  // Task #114: every open tab's submit lock (proof-grid.tsx's live `status`)
  // converges off this signal — dropping this call silently degrades to the
  // 30s fallback poll with no test noticing otherwise.
  it("signals the shared-selection change for this gallery on the winning submit", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(notifySelectionChangedMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("lets an admin submit on behalf of the client too", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    const db = await seededDb();
    expect(db.__rows.galleries[0]).toMatchObject({ status: "selected" });
  });
});

describe("POST /api/galleries/[galleryId]/submit-selection — double submission is idempotent", () => {
  // A SEQUENTIAL double-submit (the first call has already fully resolved
  // before the second one starts) exercises the early `status === "selected"`
  // short-circuit at the top of the route, never the atomic UPDATE itself —
  // real, worth covering on its own, but NOT proof the CAS guard works: this
  // same assertion would still pass even if the UPDATE's own `WHERE status =
  // 'proofing'` clause were deleted entirely, because the second call never
  // reaches it.
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
  // reach `db.update(...).where(and(eq(id), eq(status, "proofing")))` before
  // either one has mutated anything — genuinely racing the UPDATE itself, not
  // the early short-circuit above. The fake `@/lib/db` mutates its rows
  // SYNCHRONOUSLY inside `.where()` (no extra `await` in between), which is
  // what makes this a meaningful test at all: JS's single-threaded run-to-
  // completion between `await` points means whichever of the two `POST`
  // calls' turns comes up first at that exact line completes its match-and-
  // mutate atomically before the other one can interleave — exactly
  // mirroring how Postgres serializes two concurrent UPDATEs against the
  // same row. Deleting the `eq(status, "proofing")` half of the route's
  // `and(...)` (turning it back into the unconditional
  // `.where(eq(galleries.id, ...))` kanban #61 flagged for the publish path)
  // makes BOTH calls match and mutate, and this test catches that: two
  // notifications instead of one.
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
