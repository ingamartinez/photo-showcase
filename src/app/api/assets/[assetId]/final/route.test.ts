import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Same boundary-mocking philosophy as ../proof/route.test.ts: R2 itself is
// proven for real elsewhere, `@/lib/asset-access` is left UNMOCKED so the
// real ownership check runs, and this suite's own job is the final-specific
// gate (selected AND delivered AND an object actually exists) plus the
// wiring above it.
const getPresignedUrlMock = vi.fn();
const putObjectMock = vi.fn();
// Task #220: `deleteObject` IS now imported and called by the route — the
// stale-object cleanup that runs after a successful DB update when a
// re-upload changed format. The "no compensating delete on DB-update
// failure" describe block below still proves the ABSENCE of a call on that
// specific branch; the dedicated "stale-object cleanup" describe block
// further down proves the PRESENCE of one on the branch that actually needs
// it.
const deleteObjectMock = vi.fn();
// Task #93: defaults to "present" so every PRE-EXISTING test in this file
// (none of which is about this gap) keeps exercising the happy path exactly
// as before. The dedicated "missing R2 object" describe block below
// overrides this per test.
const objectExistsMock = vi.fn<(key: string) => Promise<boolean>>().mockResolvedValue(true);
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
  // A deterministic fake, not src/lib/r2.ts's real (environment-namespaced)
  // format — same reasoning as the proofs route's own test file: what
  // matters here is only that this route reuses the SAME key on a
  // same-format re-upload (and a DIFFERENT key on a different-format one,
  // task #220), not the real `dev/` prefix this suite never stubs `APP_ENV`
  // for.
  finalKey: (galleryId: string, assetId: string, extension: string) =>
    `galleries/${galleryId}/finals/${assetId}.${extension}`,
  // Task #89: the same deterministic-fake treatment as `finalKey` above.
  // POST now writes TWO objects per upload — the full-resolution final AND
  // its browsing-sized, unwatermarked derivative — and several tests below
  // assert on which key received which body.
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
  putObject: (...args: unknown[]) => putObjectMock(...args),
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
  objectExists: (...args: [string]) => objectExistsMock(...args),
  // Task #78: identity fake — the route re-attaches the `R2Key` brand to
  // `asset.finalKey` via `storedKey` before calling `getPresignedUrl`.
  storedKey: (key: string) => key,
}));

// Task #93: the "photographer finds out" side effect — mocked at this
// boundary (not Resend's own HTTP call) for the same reason
// submit-selection/route.test.ts mocks `sendSubmissionNotificationEmail`
// rather than `fetch`: this suite's own job is whether the ROUTE calls this
// on the right branch, with the right asset, never twice on the happy path
// — not whether Resend's own request shape is correct (that belongs to
// missing-final-notification-email.test.ts).
const notifyAdminOfMissingFinalMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/missing-final-notification-email", () => ({
  notifyAdminOfMissingFinal: (...args: unknown[]) => notifyAdminOfMissingFinalMock(...args),
}));

// This route's own wiring (the gates, the ordering, the DB write) is what's
// under test here, not sharp's pipeline (proven for real in
// src/lib/images.test.ts) — same boundary-mocking philosophy as the proofs
// route's own test file.
//
// TASK #218: the route no longer calls `processFinal` at all — it writes the
// uploaded bytes to `finalKey` verbatim. `processDisplay` (task #89) is the
// ONLY sharp pass left on this route, producing the browsing-sized derivative
// from those SAME raw bytes (never a pre-filtered intermediate — there isn't
// one any more). Mocked at the same boundary as before: the pipeline itself
// (downscale, no watermark, EXIF allowlist) is proven for real in
// src/lib/images.test.ts; what this suite owns is that the route calls it,
// feeds it the RIGHT bytes, and stores the result under the display key.
const processDisplayMock = vi.fn();
vi.mock("@/lib/images", () => ({
  processDisplay: (...args: unknown[]) => processDisplayMock(...args),
}));

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
      // Corrected version: resolves the JS property key through `table`'s
      // own entries instead of hardcoding a snake_case<->camelCase
      // transform — see src/app/api/galleries/[galleryId]/proofs/route.test.ts
      // for the same helper and its rationale.
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
  const { assets, galleries, galleryClients } = await import("@/lib/db/schema");

  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];

  // Always returns a FRESH COPY, never the live row object — a real
  // `SELECT` is a point-in-time snapshot, not a handle a later UPDATE could
  // mutate out from under an already-in-flight caller. This is the FIXED
  // shape (src/app/dashboard/galleries/actions.unlock.test.ts's own
  // `project`), not the still-buggy one in
  // src/app/api/galleries/[galleryId]/submit-selection/route.test.ts
  // (tracked separately as #84) that returns the live reference for the
  // no-`columns` case.
  function project(row: Row): Row {
    return { ...row };
  }

  function rowsFor(table: unknown): Row[] {
    if (table === assets) return assetRows;
    if (table === galleries) return galleryRows;
    if (table === galleryClients) return galleryClientRows;
    throw new Error("fake db: unsupported table in select().where()");
  }

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const conditions = eqConditions(condition);
            if (conditions.length === 0 || conditions.some((c) => !c.column)) {
              throw new Error("eqConditions: not a supported eq()/and(eq(), eq()) condition");
            }
            const rows = rowsFor(table)
              .filter((r) => conditions.every(({ column, value }) => r[column!] === value))
              .map(project);
            return { limit: async (n: number) => rows.slice(0, n) };
          },
        }),
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
      __rows: { assets: assetRows, galleries: galleryRows, galleryClients: galleryClientRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; galleries: Row[]; galleryClients: Row[] } };
  };
  return db;
}

const GALLERY_A_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    status: "delivered",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: new Date("2026-07-10"),
    deliveredAt: new Date("2026-07-20"),
    ...overrides,
  };
}

const FINAL_KEY = `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.jpg`;
// Task #89: the second object every successful POST now writes.
const DISPLAY_KEY = `galleries/${GALLERY_A_ID}/display/${ASSET_A_ID}.webp`;

/** Every `putObject` call that targeted `key`. One upload writes two objects
 * since task #89 (the final and its browsing-sized derivative), so a bare
 * `toHaveBeenCalledTimes` on `putObjectMock` no longer says anything about
 * either one specifically — the assertions that care about "the final's key
 * was written exactly once" filter through this instead. */
function writesTo(key: string): unknown[][] {
  return putObjectMock.mock.calls.filter((call) => call[0] === key);
}

function assetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_A_ID,
    galleryId: GALLERY_A_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: `galleries/${GALLERY_A_ID}/proofs/${ASSET_A_ID}.webp`,
    finalKey: FINAL_KEY,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: true,
    selectedAt: new Date("2026-07-11"),
    isEdited: true,
    sortOrder: 0,
    createdAt: new Date("2026-07-02"),
    ...overrides,
  };
}

function requestFor(assetId: string): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/final`, { method: "GET" });
}

function formDataWith(file: File | undefined): FormData {
  const data = new FormData();
  if (file) data.set("file", file);
  return data;
}

function postRequestFor(assetId: string, body?: FormData): NextRequest {
  return new NextRequest(`http://localhost:3300/api/assets/${assetId}/final`, {
    method: "POST",
    body,
  });
}

function imageFile(bytes: BlobPart = "fake-edited-bytes", name = "IMG_0001-edit.jpg"): File {
  return new File([bytes], name, { type: "image/jpeg" });
}

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-final-url");
  putObjectMock.mockReset();
  putObjectMock.mockResolvedValue(undefined);
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  objectExistsMock.mockReset();
  objectExistsMock.mockResolvedValue(true);
  notifyAdminOfMissingFinalMock.mockReset();
  notifyAdminOfMissingFinalMock.mockResolvedValue(undefined);
  processDisplayMock.mockReset();
  processDisplayMock.mockResolvedValue({
    data: Buffer.from("fake-display-webp-bytes"),
    width: 1600,
    height: 1067,
  });
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleryClients.length = 0;
  // Selected + delivered + a finalKey present — the fully-unlocked case.
  // Individual tests override one axis at a time to prove each gate is
  // independently enforced.
  db.__rows.galleries.push(galleryRow());
  db.__rows.assets.push(assetRow());
  // Task #94: ownership is now a `gallery_clients` row, not a `clientId`
  // column on the gallery itself.
  db.__rows.galleryClients.push({ galleryId: GALLERY_A_ID, userId: "client-a" });
});

describe("GET /api/assets/[assetId]/final — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns 403 when a different client requests someone else's final", async () => {
    authMock.mockResolvedValue(clientBSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("lets an admin read a delivered, selected final regardless of gallery ownership", async () => {
    authMock.mockResolvedValue(adminSession());
    const { GET, buildFinalDownloadFilename } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    const expectedFilename = buildFinalDownloadFilename(
      "Boda Ana y Beto",
      "IMG_0001.JPG",
      FINAL_KEY,
    );
    expect(getPresignedUrlMock).toHaveBeenCalledWith(FINAL_KEY, {
      contentDisposition: `attachment; filename="${expectedFilename}"`,
    });
  });
});

// Task #26's inherited decision from #63's review: the `delivered` gate is
// loosened for admins ONLY — a client still needs both selected AND
// delivered, unchanged from task #16.
describe("GET /api/assets/[assetId]/final — the admin preview exception", () => {
  it("lets an admin preview a selected asset's final BEFORE the gallery is delivered", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "selected", deliveredAt: null }));
    const { GET, buildFinalDownloadFilename } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    const expectedFilename = buildFinalDownloadFilename(
      "Boda Ana y Beto",
      "IMG_0001.JPG",
      FINAL_KEY,
    );
    expect(getPresignedUrlMock).toHaveBeenCalledWith(FINAL_KEY, {
      contentDisposition: `attachment; filename="${expectedFilename}"`,
    });
  });

  it("still refuses the SAME pre-delivery asset for the owning client", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "selected", deliveredAt: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
  });

  it("still refuses an admin a final for an asset that was never selected, delivered or not", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("still refuses an admin when no final object has ever been uploaded, delivered or not", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ finalKey: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/assets/[assetId]/final — the final-specific gate", () => {
  it("serves the final for the owning client when selected + delivered + finalKey all hold", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET, buildFinalDownloadFilename } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://r2.example.com/presigned-final-url",
    });
    const expectedFilename = buildFinalDownloadFilename(
      "Boda Ana y Beto",
      "IMG_0001.JPG",
      FINAL_KEY,
    );
    expect(getPresignedUrlMock).toHaveBeenCalledWith(FINAL_KEY, {
      contentDisposition: `attachment; filename="${expectedFilename}"`,
    });
  });

  // Task #28's own acceptance criterion: "Only assets that were selected AND
  // edited are downloadable" — checked as an INDEPENDENT condition from
  // `finalKey`, not inferred from it (see the route's own comment). Proves
  // the explicit `isEdited` check actually gates something: an asset with a
  // finalKey but `isEdited: false` (a state that should never occur given
  // how the POST handler writes both together, but this gate does not lean
  // on that invariant) must still be refused.
  it("refuses a selected, delivered, finalKey-present asset when isEdited is false", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isEdited: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses the owning client a final for an asset that was never selected", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses a selected asset's final before the gallery has been delivered", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "selected", deliveredAt: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("refuses a selected, delivered asset when no final object was ever uploaded", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ finalKey: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "final_not_available" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  // Proofs and finals are different access rules (task #16) — this is the
  // asymmetry made explicit: the SAME asset is reachable at .../proof but
  // not yet at .../final purely because it hasn't been selected.
  it("still returns 404 for an unselected asset even for the owning client who could see its proof", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false, finalKey: null }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
  });
});

// Task #93: the database saying `final_key` is set is not proof the R2
// object is still there — a stale key or an object deleted out from under
// the row must produce a DESCRIBED response, never an unhandled throw, and
// must tell the photographer, not just the client who hit it.
describe("GET /api/assets/[assetId]/final — the R2 object is missing (task #93)", () => {
  it("returns 502 final_missing, never presigns, and notifies the photographer when objectExists resolves false", async () => {
    authMock.mockResolvedValue(clientASession());
    objectExistsMock.mockResolvedValue(false);
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "final_missing" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
    expect(notifyAdminOfMissingFinalMock).toHaveBeenCalledWith({
      gallery: expect.objectContaining({ id: GALLERY_A_ID, title: "Boda Ana y Beto" }),
      missingFilenames: ["IMG_0001.JPG"],
    });
  });

  // Same fail-closed stance GET .../display already takes on this exact
  // probe (see that route's own comment): a THROWN check must never escape
  // as an unrelated 500, it is treated as "not there".
  it("treats a thrown objectExists the same as an explicit false", async () => {
    authMock.mockResolvedValue(clientASession());
    objectExistsMock.mockRejectedValue(new Error("R2 unreachable"));
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "final_missing" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("never calls notifyAdminOfMissingFinal on the happy path", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(200);
    expect(notifyAdminOfMissingFinalMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/assets/[assetId]/final — validation and not-found", () => {
  it("rejects a malformed asset id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientASession());
    const { GET } = await import("./route");

    const response = await GET(requestFor("not-a-uuid"), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
    expect(getPresignedUrlMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the asset does not exist", async () => {
    authMock.mockResolvedValue(clientASession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { GET } = await import("./route");

    const response = await GET(requestFor(ASSET_A_ID), paramsFor(ASSET_A_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
  });
});

describe("POST /api/assets/[assetId]/final — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(processDisplayMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in CLIENT with a 403, without processing or storing anything", async () => {
    authMock.mockResolvedValue(clientASession());
    const { POST } = await import("./route");

    await expect(
      POST(postRequestFor(ASSET_A_ID, formDataWith(imageFile())), paramsFor(ASSET_A_ID)),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(processDisplayMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/assets/[assetId]/final — the core rule: selected assets only", () => {
  it("rejects a malformed asset id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor("not-a-uuid", formDataWith(imageFile())),
      paramsFor("not-a-uuid"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_asset_id" });
    expect(processDisplayMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the asset does not exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_found" });
    expect(processDisplayMock).not.toHaveBeenCalled();
  });

  // The acceptance criterion this task exists to enforce: `final_key` is
  // nullable precisely because most assets never get one, and uploading a
  // final for an asset the client never selected is a bug, not a
  // convenience (epic #5).
  it("refuses to attach a final to an asset that was never selected", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "asset_not_selected" });
    expect(processDisplayMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();

    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBeNull();
    expect(row?.isEdited).toBe(false);
  });

  // `isSelected` can be true while the gallery is still `proofing` (a
  // client can toggle a selection before ever submitting) — this route
  // deliberately does not layer a gallery-status requirement on top of
  // `isSelected`, see the route's own comment for why.
  it("accepts a final for a selected asset even while the gallery is still 'proofing'", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status: "proofing", selectionSubmittedAt: null }));
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(200);
    expect(processDisplayMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/assets/[assetId]/final — validation", () => {
  it("returns 400 for a request with no file field", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(undefined)),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "missing_file" });
    expect(processDisplayMock).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-image content type, without calling processDisplay", async () => {
    authMock.mockResolvedValue(adminSession());
    const notAnImage = new File(["hello"], "notes.txt", { type: "text/plain" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(notAnImage)),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "not_an_image" });
    expect(processDisplayMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  // TASK #218's gate (JPEG-only) was widened by #220 to a small allowlist
  // (JPEG + PNG) — a real image MIME type that is in NEITHER, e.g. GIF, must
  // still be refused: not merely "not an image", but "not one of the formats
  // this route stores byte-for-byte". Mutation proof (task #220's own
  // required coverage, item #6): reverting the gate back to
  // `file.type.startsWith("image/")` turns this test red (a `image/gif` file
  // passes the gate and reaches `processDisplay`) while leaving the
  // `text/plain` test above green, which is exactly why that older test
  // alone was never sufficient coverage for this gate.
  it("returns 415 for a real image MIME type that isn't in the allowlist, e.g. GIF", async () => {
    authMock.mockResolvedValue(adminSession());
    const gif = new File(["fake-gif-bytes"], "edit.gif", { type: "image/gif" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(gif)),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "not_an_image" });
    expect(processDisplayMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  // Task #220's own required coverage, item #6's complement: PNG is no
  // longer "not JPEG", it is now one of the two accepted formats. MUTATION
  // PROOF: reverting `ACCEPTED_FINAL_FORMATS` to a bare `file.type !==
  // "image/jpeg"` check (#218's own gate) turns this test red — the same
  // PNG upload that must succeed here would 415 instead.
  it("accepts a PNG upload, storing it at a .png key with an image/png Content-Type", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const png = new File(["fake-png-bytes"], "edit.png", { type: "image/png" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(png)),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(200);
    const pngKey = `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.png`;
    await expect(response.json()).resolves.toEqual({
      asset: { id: ASSET_A_ID, finalKey: pngKey, isEdited: true },
    });
    expect(putObjectMock).toHaveBeenCalledWith(
      pngKey,
      expect.anything(),
      expect.objectContaining({ contentType: "image/png" }),
    );
  });

  it("returns 413 for a file larger than the configured cap, without calling processDisplay", async () => {
    authMock.mockResolvedValue(adminSession());
    const { MAX_FINAL_UPLOAD_BYTES } = await import("./route");
    const tooLarge = new File([new Uint8Array(MAX_FINAL_UPLOAD_BYTES + 1)], "big.jpg", {
      type: "image/jpeg",
    });
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(tooLarge)),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "file_too_large" });
    expect(processDisplayMock).not.toHaveBeenCalled();
  });

  it("returns 422 when processDisplay rejects, and never calls putObject", async () => {
    authMock.mockResolvedValue(adminSession());
    processDisplayMock.mockRejectedValue(new Error("not a real image"));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "processing_failed" });
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the R2 write fails, and never touches the database", async () => {
    authMock.mockResolvedValue(adminSession());
    putObjectMock.mockRejectedValue(new Error("R2 unreachable"));
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "upload_failed" });

    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBeNull();
  });
});

describe("POST /api/assets/[assetId]/final — DB update failure (no compensating delete)", () => {
  // The route's own comment explains WHY there is no compensating delete on
  // this path (finalKey() is deterministic per (galleryId, assetId), so a
  // delete here could destroy a still-DB-referenced final from a PRIOR
  // successful upload). This test proves that design holds rather than just
  // asserting it in prose: force the DB write to reject after the R2 write
  // already succeeded, confirm deleteObject is never reached, and confirm a
  // later retry still lands cleanly on the same key — no orphan, ever.
  it("returns 500 with update_failed, never calls deleteObject, and a later retry overwrites the same key cleanly", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    // Force the fake db's update to throw — same "temporarily replace with a
    // throwing implementation" technique as the proofs route's own
    // insert-failure test (route.test.ts:418), applied to `update` instead
    // of `insert` since this route writes with `db.update`, not
    // `db.insert`.
    const { db: rawDb } = (await import("@/lib/db")) as unknown as {
      db: { update: (table: unknown) => unknown };
    };
    const realUpdate = rawDb.update;
    rawDb.update = () => {
      throw new Error("simulated update failure");
    };

    const failedResponse = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile("first-attempt-bytes"))),
      paramsFor(ASSET_A_ID),
    );

    rawDb.update = realUpdate;

    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toEqual({ error: "update_failed" });

    // The point of the asymmetry with the proofs route: the R2 object this
    // failed attempt just wrote is deliberately left in place. Assert the
    // ABSENCE of the cleanup call explicitly, not just the response status —
    // a future regression that added a compensating delete here would still
    // return the same 500/update_failed shape while silently destroying a
    // previously-delivered final on a re-upload's failure.
    expect(deleteObjectMock).not.toHaveBeenCalled();
    // Counted per KEY, not in total: task #89 made one upload write TWO
    // objects (the final plus its browsing-sized derivative), so a bare
    // call count here would now say "2" for reasons that have nothing to do
    // with what this test is about. Filtering by key keeps the assertion
    // saying exactly what it always meant — the final's own key was written
    // once and never cleaned up.
    expect(writesTo(FINAL_KEY)).toHaveLength(1);

    const [rowAfterFailure] = db.__rows.assets;
    expect(rowAfterFailure?.finalKey).toBeNull();
    expect(rowAfterFailure?.isEdited).toBe(false);

    // A retry for the SAME asset must overwrite `key` cleanly: same
    // deterministic key, no delete ever needed to get there, no orphan left
    // over from the failed attempt.
    const retryResponse = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile("retry-bytes"))),
      paramsFor(ASSET_A_ID),
    );

    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({
      asset: { id: ASSET_A_ID, finalKey: FINAL_KEY, isEdited: true },
    });
    const finalWrites = writesTo(FINAL_KEY);
    expect(finalWrites).toHaveLength(2);
    expect(finalWrites[1]).toEqual([
      FINAL_KEY,
      expect.anything(),
      expect.objectContaining({ contentType: "image/jpeg" }),
    ]);
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const [rowAfterRetry] = db.__rows.assets;
    expect(rowAfterRetry?.finalKey).toBe(FINAL_KEY);
    expect(rowAfterRetry?.isEdited).toBe(true);
  });
});

describe("POST /api/assets/[assetId]/final — success and re-upload", () => {
  it("writes finalKey and isEdited on a first-ever upload, using the deterministic key", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      asset: { id: ASSET_A_ID, finalKey: FINAL_KEY, isEdited: true },
    });

    expect(putObjectMock).toHaveBeenCalledWith(
      FINAL_KEY,
      expect.anything(),
      expect.objectContaining({ contentType: "image/jpeg" }),
    );

    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBe(FINAL_KEY);
    expect(row?.isEdited).toBe(true);
  });

  // The acceptance criterion: re-uploading a final in the SAME format
  // replaces it without orphaning the previous R2 object. `finalKey()` is
  // DETERMINISTIC per (galleryId, assetId, extension) — this test proves the
  // route reuses that same key on a second same-format upload rather than
  // minting a new one, which is exactly what makes the old object get
  // overwritten instead of orphaned, AND (task #220's own required coverage,
  // item #5) that the stale-object cleanup never fires when there is no
  // stale object — same key in, same key out.
  it("same-extension re-upload still overwrites in place and deletes nothing", async () => {
    authMock.mockResolvedValue(adminSession());
    // Starting state already has a final (assetRow()'s own default).
    const { POST } = await import("./route");

    const firstKeyCall = FINAL_KEY;
    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile("second-edit-bytes", "IMG_0001-v2.jpg"))),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(200);
    // Per-key count, see the DB-update-failure test above for why.
    expect(writesTo(firstKeyCall)).toHaveLength(1);
    expect(putObjectMock).toHaveBeenCalledWith(firstKeyCall, expect.anything(), expect.anything());
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const db = await seededDb();
    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBe(FINAL_KEY);
  });

  // Task #220's own required coverage, item #4: an extension-change
  // re-upload must write the new key, point the DB at it, AND delete the
  // OLD object — and the delete must happen ONLY AFTER the DB update
  // succeeds. MUTATION PROOF: moving the `deleteObject` call to BEFORE the
  // `db.update` call (an ordering inversion of the route's own comment)
  // still passes the first three assertions below but turns the LAST test
  // in this file's own DB-update-failure-with-a-prior-final describe block
  // red — see that block for the ordering half of this proof; this test
  // covers the happy-path shape.
  it("extension-change re-upload writes the new key, updates the DB, and deletes the OLD object", async () => {
    authMock.mockResolvedValue(adminSession());
    // Starting state already has a .jpg final (assetRow()'s own default,
    // FINAL_KEY).
    const { POST } = await import("./route");
    const png = new File(["fake-png-bytes"], "edit.png", { type: "image/png" });

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(png)),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(200);
    const pngKey = `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.png`;
    await expect(response.json()).resolves.toEqual({
      asset: { id: ASSET_A_ID, finalKey: pngKey, isEdited: true },
    });
    expect(writesTo(pngKey)).toHaveLength(1);

    const db = await seededDb();
    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBe(pngKey);

    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(FINAL_KEY);
  });

  // The ordering half of item #4: a failed DB update must leave the OLD
  // object intact — `deleteObject` must never be reached at all on that
  // branch, even for an extension-changing upload. MUTATION PROOF: moving
  // the cleanup block above the `db.update` try/catch in the route turns
  // this test red — `deleteObjectMock` would then be called even though the
  // update itself failed.
  it("never deletes the old object when the DB update fails on an extension-change re-upload", async () => {
    authMock.mockResolvedValue(adminSession());
    // Starting state already has a .jpg final (assetRow()'s own default).
    const { db: rawDb } = (await import("@/lib/db")) as unknown as {
      db: { update: (table: unknown) => unknown };
    };
    const realUpdate = rawDb.update;
    rawDb.update = () => {
      throw new Error("simulated update failure");
    };
    const png = new File(["fake-png-bytes"], "edit.png", { type: "image/png" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(png)),
      paramsFor(ASSET_A_ID),
    );

    rawDb.update = realUpdate;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "update_failed" });
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const db = await seededDb();
    const [row] = db.__rows.assets;
    // Still the ORIGINAL .jpg final — the DB update never committed.
    expect(row?.finalKey).toBe(FINAL_KEY);
  });

  // TASK #218's own acceptance criterion, at the route's mocked-boundary
  // level (the REAL-pipeline version of this same claim lives in
  // route.download.test.ts, which never mocks @/lib/images or @/lib/r2 at
  // all): the bytes handed to `putObject` for `finalKey` must be
  // `Buffer.equals` to the uploaded bytes — not "similar size", not "still
  // starts the same", genuinely identical. `imageFile()` defaults to
  // `"fake-edited-bytes"`; this test uses a distinct payload so a bug that
  // accidentally wrote some OTHER buffer already in scope (`display.data`,
  // an empty buffer, a stale closure) could not coincidentally pass.
  //
  // MUTATION PROOF: reverting the `putObject(key, finalBytes, ...)` call
  // below to `putObject(key, display.data, ...)` turns this red — the
  // asserted bytes stop matching (`"distinctive-edit-bytes"` vs
  // `"fake-display-webp-bytes"`, `processDisplayMock`'s own default mock
  // value) and `Buffer.equals` fails.
  it("writes the exact uploaded bytes to finalKey, byte-for-byte — not a processed derivative", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");
    const uploadedBytes = Buffer.from("distinctive-edit-bytes");

    await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile(uploadedBytes))),
      paramsFor(ASSET_A_ID),
    );

    const finalWrite = writesTo(FINAL_KEY)[0];
    expect(finalWrite).toBeDefined();
    // Task #220: `putObject` now receives the raw `ArrayBuffer`
    // `file.arrayBuffer()` returns, never a `Buffer.from()` copy (see the
    // route's own comment on why) — `Buffer.from()` here is the TEST reading
    // that ArrayBuffer back for comparison, not evidence of a copy in the
    // route itself.
    const storedBytes = Buffer.from(finalWrite?.[1] as ArrayBuffer);
    expect(Buffer.compare(storedBytes, uploadedBytes)).toBe(0);
    expect(storedBytes.equals(uploadedBytes)).toBe(true);
  });

  it("feeds processDisplay the uploaded file's own bytes, never a stale reference", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile("distinctive-edit-bytes"))),
      paramsFor(ASSET_A_ID),
    );

    expect(processDisplayMock).toHaveBeenCalledTimes(1);
    const displayInput = processDisplayMock.mock.calls[0]?.[0] as Buffer;
    expect(Buffer.from(displayInput).toString()).toBe("distinctive-edit-bytes");
  });
});

// Task #89: a delivered gallery must show the client the UNWATERMARKED photo
// at browsing size, which means the final upload has to produce a second
// object. These tests own the route's half of that: that it happens at all,
// what it is derived FROM, where it lands, and what happens when it fails.
describe("POST /api/assets/[assetId]/final — the display derivative (task #89)", () => {
  it("writes a second object under the display key, as WebP", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(200);
    expect(writesTo(DISPLAY_KEY)).toHaveLength(1);
    expect(putObjectMock).toHaveBeenCalledWith(
      DISPLAY_KEY,
      Buffer.from("fake-display-webp-bytes"),
      expect.objectContaining({ contentType: "image/webp" }),
    );
  });

  // TASK #218 inverted this claim from what it used to be: before this task,
  // `processDisplay` had to be fed `processFinal`'s pre-filtered OUTPUT, never
  // the raw upload directly (that function no longer exists). Now the route
  // has no intermediate to feed it at all — `processDisplay` gets the SAME
  // raw bytes that get written to `finalKey`, and this is what makes it the
  // only remaining filter for GPS/EXIF (src/lib/images.ts's own comment).
  // Asserts the actual bytes handed over, not just that the call happened.
  it("feeds processDisplay the SAME raw upload bytes written to finalKey", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile("raw-lightroom-export-bytes"))),
      paramsFor(ASSET_A_ID),
    );

    expect(processDisplayMock).toHaveBeenCalledTimes(1);
    const displayInput = processDisplayMock.mock.calls[0]?.[0] as ArrayBuffer;
    const finalWrite = writesTo(FINAL_KEY)[0];
    const storedFinalBytes = Buffer.from(finalWrite?.[1] as ArrayBuffer);
    expect(Buffer.from(displayInput).toString()).toBe("raw-lightroom-export-bytes");
    expect(Buffer.compare(Buffer.from(displayInput), storedFinalBytes)).toBe(0);
  });

  // Both sharp passes run BEFORE either object is written, so a failure in
  // the second one leaves R2 untouched by this request instead of half
  // updated — and the database keeps saying "no final", which is what makes
  // the photographer's UI still show "Falta el final" and prompt a retry.
  it("fails the whole upload with 422 and writes NOTHING when the display pass throws", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    processDisplayMock.mockRejectedValue(new Error("display pass exploded"));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "processing_failed" });
    expect(putObjectMock).not.toHaveBeenCalled();

    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBeNull();
    expect(row?.isEdited).toBe(false);
  });

  // A final in R2 with no display object beside it is the state the whole
  // fallback path exists to cope with — but it must not be a state a
  // SUCCESSFUL upload can produce, or the client silently keeps seeing a
  // watermark on a photo the photographer believes was delivered.
  it("fails with 502 and never marks the asset edited when the display upload fails", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: true, finalKey: null, isEdited: false }));
    putObjectMock.mockImplementation(async (key: string) => {
      if (key === DISPLAY_KEY) throw new Error("R2 refused the display write");
    });
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "upload_failed" });

    const [row] = db.__rows.assets;
    expect(row?.finalKey).toBeNull();
    expect(row?.isEdited).toBe(false);
  });

  // Deterministic keys are what let a retry be a clean overwrite rather than
  // a cleanup problem — proven here for the display key specifically, the
  // same property `finalKey` already has its own test for above.
  it("reuses the same deterministic display key on a re-upload", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    await POST(postRequestFor(ASSET_A_ID, formDataWith(imageFile())), paramsFor(ASSET_A_ID));
    await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile("second-edit", "IMG_0001-v2.jpg"))),
      paramsFor(ASSET_A_ID),
    );

    const displayWrites = writesTo(DISPLAY_KEY);
    expect(displayWrites).toHaveLength(2);
    expect(displayWrites[0]?.[0]).toBe(displayWrites[1]?.[0]);
  });

  // Every refusal above the processing step must still short-circuit before
  // the SECOND sharp pass too, not just the first — cheap to get wrong when
  // adding a pass, and the consequence would be a decode/encode running for
  // a request that was about to be refused anyway.
  it("never runs the display pass for an unselected asset", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.length = 0;
    db.__rows.assets.push(assetRow({ isSelected: false, finalKey: null, isEdited: false }));
    const { POST } = await import("./route");

    const response = await POST(
      postRequestFor(ASSET_A_ID, formDataWith(imageFile())),
      paramsFor(ASSET_A_ID),
    );

    expect(response.status).toBe(409);
    expect(processDisplayMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});

// Task #28's own acceptance criterion: "a sensible download filename" — an
// asset id or raw R2 key is explicitly called out as NOT sensible. These
// tests exercise `buildFinalDownloadFilename` directly, independent of the
// route's own request/response wiring above.
describe("buildFinalDownloadFilename", () => {
  it("combines a slugified gallery title with a slugified original filename, ending in the STORED key's extension", async () => {
    const { buildFinalDownloadFilename } = await import("./route");
    expect(buildFinalDownloadFilename("Boda Ana y Beto", "IMG_0001.JPG", FINAL_KEY)).toBe(
      "boda-ana-y-beto-img-0001.jpg",
    );
  });

  // Task #220's own required coverage: item #2 (key really ends in the right
  // extension) and #3 (download filename carries it), for BOTH formats.
  // MUTATION PROOF: reverting `extensionFromKey(finalKeyValue)` to a
  // hardcoded `"jpg"` literal turns this test red — the PNG case would still
  // produce a `.jpg` filename.
  it("ends in .png for a final stored at a .png key, not a hardcoded .jpg", async () => {
    const { buildFinalDownloadFilename } = await import("./route");
    const pngKey = `galleries/${GALLERY_A_ID}/finals/${ASSET_A_ID}.png`;
    expect(buildFinalDownloadFilename("Boda Ana y Beto", "IMG_0001.JPG", pngKey)).toBe(
      "boda-ana-y-beto-img-0001.png",
    );
  });

  it("derives the extension from the STORED key, not from the original upload's own filename extension", async () => {
    const { buildFinalDownloadFilename } = await import("./route");
    // `originalFilename` is the name recorded at PROOF-upload time and could
    // be anything (.png, .heic, whatever the client's camera produced) — it
    // has never driven the download extension, and still doesn't after task
    // #220. Only `finalKeyValue` (the STORED object's own key) does.
    expect(buildFinalDownloadFilename("Sesion", "foto.png", FINAL_KEY)).toBe("sesion-foto.jpg");
    expect(buildFinalDownloadFilename("Sesion", "foto.HEIC", FINAL_KEY)).toBe("sesion-foto.jpg");
  });

  it("strips accents so Spanish gallery titles and filenames stay ASCII-safe", async () => {
    const { buildFinalDownloadFilename } = await import("./route");
    expect(buildFinalDownloadFilename("Bautizo de María José", "Sesión_01.jpg", FINAL_KEY)).toBe(
      "bautizo-de-maria-jose-sesion-01.jpg",
    );
  });

  it("never produces a raw asset id or R2 key as the filename", async () => {
    const { buildFinalDownloadFilename } = await import("./route");
    const filename = buildFinalDownloadFilename("Boda Ana y Beto", "IMG_0001.JPG", FINAL_KEY);
    expect(filename).not.toContain(ASSET_A_ID);
    expect(filename).not.toContain("galleries/");
    expect(filename).not.toContain("finals/");
  });

  it("falls back to generic words rather than producing a degenerate filename when an input slugifies to nothing", async () => {
    const { buildFinalDownloadFilename } = await import("./route");
    expect(buildFinalDownloadFilename("🎉🎉", "🎉🎉.jpg", FINAL_KEY)).toBe("galeria-foto.jpg");
  });
});
