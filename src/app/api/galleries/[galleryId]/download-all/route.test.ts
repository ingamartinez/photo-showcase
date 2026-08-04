// GET /api/galleries/[galleryId]/download-all (task #29) — this route hands
// over an entire gallery's paid deliverables in ONE request, so its own
// review standard (kanban #29's own body) is explicit: "prove every
// authorization gate by mutation — delete or invert it, watch the test
// fail, restore it, watch it pass, and report both observations." Every
// gate below was verified that way during development (see this task's own
// final report for the two observations); this suite is what stays behind
// to catch a regression, not a substitute for having done that once by hand.
//
// Real bytes, not mocks, for the success path — same "prove it against
// actual content, not a stubbed call" standard
// src/app/api/assets/[assetId]/final/route.download.test.ts already applies:
// this suite writes REAL final-sized buffers into a fake R2 store under the
// REAL `finalKey()` shape, drives the ACTUAL route handler and the ACTUAL
// zip-stream module, and then verifies the produced archive with the
// system's own `unzip`/`zipinfo` binaries (skipped, not failed, if those
// aren't available — mirrors src/lib/zip-stream.test.ts's own guard).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { ZIP32_MAX_ENTRY_COUNT, ZIP32_MAX_TOTAL_BYTES } from "@/lib/zip-stream";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Task #94: ownership itself moved to src/lib/gallery-access.ts's
// `isGalleryOwner`, which has its own dedicated, mutation-tested suite
// (gallery-access.test.ts). Mocked here with a realistic default (admin, or
// the session that owns `CLIENT_A_ID`'s gallery, is an owner — anyone else
// isn't), so this suite keeps testing exactly its own job: does this ROUTE
// call `isGalleryOwner` and honor its result — including the "THE core
// mutation-tested gate" test below, still valid: it now proves the ROUTE
// calls through correctly, while gallery-access.test.ts proves the
// underlying gallery_clients query is itself correct.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

// Task #93: the "photographer finds out" side effect — mocked at this
// boundary for the same reason ./final/route.test.ts mocks it: this suite's
// own job is whether the ROUTE calls it, with which missing filenames, not
// whether Resend's own request shape is correct.
const notifyAdminOfMissingFinalMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/missing-final-notification-email", () => ({
  notifyAdminOfMissingFinal: (...args: unknown[]) => notifyAdminOfMissingFinalMock(...args),
}));

// In-memory stand-in for the R2 bucket — same shape as
// route.download.test.ts's own fake, plus a `.file()` method (this route's
// only R2 entry point is `getObjectStream`, which calls `.file(key).stream()`
// — see src/lib/r2.ts) and a `.size()` method (task #29 review follow-up:
// the pre-flight capacity check's `getObjectSize`, a HEAD-request-only
// lookup — see that function's own comment in r2.ts).
type StoredObject = { data: Buffer };
const store = new Map<string, StoredObject>();
// Lets the capacity-ceiling tests below claim an object is huge WITHOUT
// actually allocating gigabytes of real memory in the test process — same
// "the check must run off metadata alone" property `getObjectSize` itself
// exists to give the real route.
const sizeOverrides = new Map<string, number>();
// Counts EVERY actual open of an R2 body stream, across the whole fake
// client — the pre-flight tests below assert this stays at 0, proving the
// capacity check ran and refused BEFORE any stream was ever opened, not
// merely that the response happened to carry a 413.
let streamOpenCount = 0;
// Counts every `.size()` HEAD-lookup call — the too-many-entries test
// asserts this ALSO stays at 0, since the route checks the cheap entry
// count before spending even one HEAD request on this gallery.
let sizeCallCount = 0;

function streamFromBuffer(data: Buffer, chunkSize = 8192): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      controller.enqueue(new Uint8Array(data.subarray(offset, end)));
      offset = end;
    },
  });
}

class FakeS3Client {
  file(key: string) {
    return {
      stream: () => {
        streamOpenCount++;
        const stored = store.get(key);
        if (!stored) throw new Error(`fake R2: no object at key ${key}`);
        return streamFromBuffer(stored.data);
      },
    };
  }

  async size(key: string): Promise<number> {
    sizeCallCount++;
    const override = sizeOverrides.get(key);
    if (override !== undefined) return override;
    const stored = store.get(key);
    if (!stored) throw new Error(`fake R2: no object at key ${key}`);
    return stored.data.length;
  }
}

// Minimal fake `@/lib/db` — `eq()`-condition select only, this route never
// updates anything. Same `eqColumnAndValue`/fresh-copy-on-select shape as
// route.download.test.ts's own fake (see that file's own comment on why
// `project` must return a FRESH object, never the live row reference).
type Row = Record<string, unknown>;

function eqColumnAndValue(condition: unknown): { column?: string; value?: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
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
  if (!dbColumnName || !table) return { column: undefined, value };
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  return { column: jsKey, value };
}

vi.mock("@/lib/db", async () => {
  const { assets, galleries } = await import("@/lib/db/schema");
  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];

  function project(row: Row, columns?: Record<string, unknown>): Row {
    if (!columns) return { ...row };
    const projected: Row = {};
    for (const key of Object.keys(columns)) projected[key] = row[key];
    return projected;
  }

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const { column, value } = eqColumnAndValue(condition);
            if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
            const rows =
              table === galleries
                ? galleryRows.filter((r) => r[column] === value).map((r) => project(r, columns))
                : table === assets
                  ? assetRows.filter((r) => r[column] === value).map((r) => project(r, columns))
                  : (() => {
                      throw new Error("fake db: unsupported table in select().where()");
                    })();
            const resultPromise = Promise.resolve(rows);
            return {
              limit: async (n: number) => rows.slice(0, n),
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
            };
          },
        }),
      }),
      __rows: { assets: assetRows, galleries: galleryRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { assets: Row[]; galleries: Row[] } };
  };
  return db;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_A_ID = "client-a";
const ASSET_1_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ASSET_2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ASSET_3_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function clientSession(userId = CLIENT_A_ID): Session {
  return {
    user: { id: userId, role: "client", email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function galleryRow(overrides: Row = {}): Row {
  return {
    id: GALLERY_ID,
    title: "Boda Ana y Beto",
    status: "delivered",
    ...overrides,
  };
}

function assetRow(overrides: Row = {}): Row {
  return {
    id: ASSET_1_ID,
    galleryId: GALLERY_ID,
    originalFilename: "IMG_0001.JPG",
    finalKey: null,
    isSelected: false,
    isEdited: false,
    sortOrder: 0,
    ...overrides,
  };
}

function requestFor(): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${GALLERY_ID}/download-all`);
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

beforeEach(async () => {
  authMock.mockReset();
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockImplementation(
    async (_galleryId, session) => session.user.role === "admin" || session.user.id === CLIENT_A_ID,
  );
  notifyAdminOfMissingFinalMock.mockReset();
  notifyAdminOfMissingFinalMock.mockResolvedValue(undefined);
  store.clear();
  sizeOverrides.clear();
  streamOpenCount = 0;
  sizeCallCount = 0;
  vi.stubGlobal("Bun", { S3Client: FakeS3Client });
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET = "test-bucket";
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/galleries/[galleryId]/download-all — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects a malformed gallery id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(clientSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_gallery_id" });
  });

  it("returns 404 when the gallery does not exist", async () => {
    authMock.mockResolvedValue(clientSession());
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
  });

  // THE core mutation-tested gate: a different client must never get another
  // client's gallery. Verified by mutation during development (see this
  // task's own final report): inverting `isOwner` (or deleting the `if
  // (!isOwner)` guard entirely) makes this test fail — client B gets a 200
  // with client A's whole delivered set — and restoring the guard makes it
  // pass again.
  it("returns 403 when a different client requests someone else's gallery", async () => {
    authMock.mockResolvedValue(clientSession("client-b"));
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    db.__rows.assets.push(assetRow({ isSelected: true, isEdited: true, finalKey: "some-key" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

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
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    store.set("finals/some-key.jpg", { data: Buffer.from("bytes") });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/some-key.jpg" }),
    );
    const { GET } = await import("./route");

    await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(isGalleryOwnerMock).toHaveBeenCalledWith(GALLERY_ID, session);
  });

  it("returns 404 (gallery_not_delivered) for the OWNING client when the gallery isn't delivered yet", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow({ status: "selected" }));
    db.__rows.assets.push(assetRow({ isSelected: true, isEdited: true, finalKey: "some-key" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_delivered" });
  });

  it("lets an admin reach a non-delivered gallery's zip (same preview carve-out as GET .../final)", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow({ status: "selected" }));
    const finalBytes = Buffer.from("admin preview bytes");
    store.set("finals/preview.jpg", { data: finalBytes });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/preview.jpg" }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
  });

  it("returns 404 (no_finals_available) for a delivered gallery with no qualifying assets", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    // Present, but disqualified every way an asset can be: never selected,
    // never edited, no final key.
    db.__rows.assets.push(assetRow());
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "no_finals_available" });
  });
});

describe("GET /api/galleries/[galleryId]/download-all — the filter itself", () => {
  // THE other mutation-tested gate: only isSelected && isEdited && finalKey
  // assets may ever end up in the archive. Verified by mutation during
  // development: relaxing the filter (e.g. dropping the `isEdited` or
  // `isSelected` check) makes this test fail — the disqualified assets'
  // bytes show up in the zip — and restoring it makes it pass again.
  it("includes only isSelected && isEdited && finalKey assets — never a stray final, an unselected pick, or an unedited selection", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());

    store.set("finals/qualifies.jpg", { data: Buffer.from("QUALIFYING BYTES") });
    store.set("finals/stray.jpg", { data: Buffer.from("STRAY UPLOAD BYTES") });

    db.__rows.assets.push(
      assetRow({
        id: ASSET_1_ID,
        originalFilename: "IMG_0001.JPG",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/qualifies.jpg",
        sortOrder: 0,
      }),
      // Selected but never edited (no final produced yet) — must be excluded
      // even though it's selected.
      assetRow({
        id: ASSET_2_ID,
        originalFilename: "IMG_0002.JPG",
        isSelected: true,
        isEdited: false,
        finalKey: null,
        sortOrder: 1,
      }),
      // A stray final on an asset the client never selected (task #26's own
      // "uploading a final for an unselected asset is a bug" case) — must be
      // excluded even though `finalKey` is set and non-null.
      assetRow({
        id: ASSET_3_ID,
        originalFilename: "IMG_0003.JPG",
        isSelected: false,
        isEdited: true,
        finalKey: "finals/stray.jpg",
        sortOrder: 2,
      }),
    );

    const { GET } = await import("./route");
    const response = await GET(requestFor(), paramsFor(GALLERY_ID));
    expect(response.status).toBe(200);

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    let unzipAvailable = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzipAvailable = false;
    }
    if (!unzipAvailable) return;

    const dir = mkdtempSync(path.join(tmpdir(), "download-all-test-"));
    const zipPath = path.join(dir, "galeria.zip");
    try {
      writeFileSync(zipPath, zipBuffer);
      const names = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf-8" })
        .trim()
        .split("\n");

      // Exactly ONE entry — the qualifying asset — never the two disqualified
      // ones, regardless of what their slugified names would have been.
      expect(names).toHaveLength(1);
      const content = execFileSync("unzip", ["-p", zipPath, names[0]!], { encoding: "utf-8" });
      expect(content).toBe("QUALIFYING BYTES");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task #103: the filter now delegates to `canReadFinalDeliverable`
  // (src/lib/final-access.ts) instead of carrying its own `!== null` copy of
  // this leg — that function's own suite pins the empty-string refusal
  // against the gate directly; this test pins the SAME behavior on THIS
  // route, the way #89 pinned it on GET .../final. An empty `final_key` is
  // unreachable today (only `finalKey()`'s deterministic builder ever writes
  // the column), but a `!== null` regression here would silently admit one
  // into the archive.
  it("excludes an asset with an empty-string finalKey, exactly as the shared gate does", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    db.__rows.assets.push(assetRow({ isSelected: true, isEdited: true, finalKey: "" }));
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "no_finals_available" });
  });

  it("orders entries by the assets' own sort_order, matching the gallery's display order", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    store.set("finals/b.jpg", { data: Buffer.from("b") });
    store.set("finals/a.jpg", { data: Buffer.from("a") });
    db.__rows.assets.push(
      assetRow({
        id: ASSET_2_ID,
        originalFilename: "second.jpg",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/b.jpg",
        sortOrder: 1,
      }),
      assetRow({
        id: ASSET_1_ID,
        originalFilename: "first.jpg",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/a.jpg",
        sortOrder: 0,
      }),
    );

    const { GET } = await import("./route");
    const response = await GET(requestFor(), paramsFor(GALLERY_ID));
    expect(response.status).toBe(200);

    let unzipAvailable = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzipAvailable = false;
    }
    if (!unzipAvailable) return;

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const dir = mkdtempSync(path.join(tmpdir(), "download-all-order-test-"));
    const zipPath = path.join(dir, "galeria.zip");
    try {
      writeFileSync(zipPath, zipBuffer);
      const names = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf-8" })
        .trim()
        .split("\n");
      expect(names).toEqual(["first.jpg", "second.jpg"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task #220's own required coverage, item #3, at the archive level: the
  // owner's ACTUAL situation is a gallery whose finals are a MIX of JPEG and
  // PNG. Each entry must carry its own real extension and its own real
  // bytes, not one format assumed for the whole archive. MUTATION PROOF:
  // hardcoding `buildZipEntryFilename`'s extension back to `.jpg` turns this
  // red — the PNG entry's name would end in `.jpg` while still containing
  // PNG bytes, and `zipinfo`'s own listing would show `img-0002.jpg` instead
  // of `img-0002.png`.
  it("zips a mixed-format gallery with each entry carrying its own real extension and bytes", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    store.set("finals/a.jpg", { data: Buffer.from("JPEG BYTES") });
    store.set("finals/b.png", { data: Buffer.from("PNG BYTES") });
    db.__rows.assets.push(
      assetRow({
        id: ASSET_1_ID,
        originalFilename: "IMG_0001.JPG",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/a.jpg",
        sortOrder: 0,
      }),
      assetRow({
        id: ASSET_2_ID,
        originalFilename: "IMG_0002.PNG",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/b.png",
        sortOrder: 1,
      }),
    );

    const { GET } = await import("./route");
    const response = await GET(requestFor(), paramsFor(GALLERY_ID));
    expect(response.status).toBe(200);

    let unzipAvailable = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzipAvailable = false;
    }
    if (!unzipAvailable) return;

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const dir = mkdtempSync(path.join(tmpdir(), "download-all-mixed-test-"));
    const zipPath = path.join(dir, "galeria.zip");
    try {
      writeFileSync(zipPath, zipBuffer);
      const names = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf-8" })
        .trim()
        .split("\n");
      expect(names).toEqual(["img-0001.jpg", "img-0002.png"]);

      const jpegContent = execFileSync("unzip", ["-p", zipPath, "img-0001.jpg"], {
        encoding: "utf-8",
      });
      const pngContent = execFileSync("unzip", ["-p", zipPath, "img-0002.png"], {
        encoding: "utf-8",
      });
      expect(jpegContent).toBe("JPEG BYTES");
      expect(pngContent).toBe("PNG BYTES");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Task #29 review follow-up: this format's writer has no way to abort
// mid-archive without truncating an already-sent HTTP response (see
// zip-stream.ts's own comment on `Buffer.writeUInt32LE` throwing a
// `RangeError` too late to matter). These prove the fix runs BEFORE that
// point — a clean 4xx, with NO R2 stream ever opened, not merely "the
// status code is right" (a regression that streamed first and threw/failed
// later would still produce SOME non-200, but would already have leaked
// partial bytes onto the wire; `streamOpenCount === 0` is what actually
// rules that out).
describe("GET /api/galleries/[galleryId]/download-all — Zip64-less capacity ceiling", () => {
  it("refuses with 413 archive_too_large — and never opens a single R2 stream — when the summed final sizes would exceed the format's byte ceiling", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());

    // Two entries whose sizes alone (per getObjectSize's HEAD lookup —
    // never `.file().stream()`) already sum past ZIP32_MAX_TOTAL_BYTES.
    // Deliberately NOT put into `store`: if the route regressed and tried
    // to actually stream either one, the fake would throw "no object at
    // key" — a second, independent tripwire on top of the streamOpenCount
    // assertion below.
    const half = Math.ceil(ZIP32_MAX_TOTAL_BYTES / 2) + 1000;
    sizeOverrides.set("finals/huge-1.jpg", half);
    sizeOverrides.set("finals/huge-2.jpg", half);
    db.__rows.assets.push(
      assetRow({
        id: ASSET_1_ID,
        originalFilename: "huge-1.jpg",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/huge-1.jpg",
        sortOrder: 0,
      }),
      assetRow({
        id: ASSET_2_ID,
        originalFilename: "huge-2.jpg",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/huge-2.jpg",
        sortOrder: 1,
      }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "archive_too_large" });
    expect(streamOpenCount).toBe(0);
  });

  it("refuses with 413 too_many_files — without a single getObjectSize HEAD call or R2 stream — when the entry count would exceed the format's ceiling", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());

    // One MORE than the format's own entry-count ceiling — deliberately not
    // put into `store` (see the comment on the sibling test above; same
    // double-tripwire reasoning) and no `sizeOverrides` entries either,
    // since a regression that reached the HEAD-request loop at all should
    // fail loudly, not quietly succeed.
    const tooMany = ZIP32_MAX_ENTRY_COUNT + 1;
    for (let i = 0; i < tooMany; i++) {
      db.__rows.assets.push(
        assetRow({
          id: `asset-${i}`,
          originalFilename: `f${i}.jpg`,
          isSelected: true,
          isEdited: true,
          finalKey: `finals/f${i}.jpg`,
          sortOrder: i,
        }),
      );
    }
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "too_many_files" });
    expect(sizeCallCount).toBe(0);
    expect(streamOpenCount).toBe(0);
  });
});

// Task #93: a stale `finalKey`, or an object deleted out from under the
// row, used to reject the pre-flight's own `Promise.all` and escape GET
// unhandled — a bare 500 with no R2 stream ever opened, but also nothing
// telling the client OR the photographer what happened.
describe("GET /api/galleries/[galleryId]/download-all — a missing R2 object during pre-flight (task #93)", () => {
  it("returns 502 final_missing, notifies the photographer with the missing filename, and never opens a single R2 stream", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());

    store.set("finals/present.jpg", { data: Buffer.from("PRESENT BYTES") });
    db.__rows.assets.push(
      assetRow({
        id: ASSET_1_ID,
        originalFilename: "present.jpg",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/present.jpg",
        sortOrder: 0,
      }),
      // Deliberately never put into `store` — the fake's `.size()` throws
      // "no object at key", standing in for a stale `finalKey`/deleted R2
      // object the database still points at.
      assetRow({
        id: ASSET_2_ID,
        originalFilename: "missing.jpg",
        isSelected: true,
        isEdited: true,
        finalKey: "finals/missing.jpg",
        sortOrder: 1,
      }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "final_missing" });
    expect(streamOpenCount).toBe(0);
    expect(notifyAdminOfMissingFinalMock).toHaveBeenCalledWith({
      gallery: expect.objectContaining({ id: GALLERY_ID }),
      missingFilenames: ["missing.jpg"],
    });
  });

  it("never calls notifyAdminOfMissingFinal on the happy path", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow());
    store.set("finals/only.jpg", { data: Buffer.from("bytes") });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/only.jpg" }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(notifyAdminOfMissingFinalMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/galleries/[galleryId]/download-all — response shape", () => {
  it("names the archive from the gallery's own slugified title, as a real .zip a real unzip tool accepts", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow({ title: "Bautizo de María José" }));
    store.set("finals/only.jpg", { data: Buffer.from("bytes") });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/only.jpg" }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="bautizo-de-maria-jose-fotos.zip"',
    );
  });

  // Task #29's own note, mirroring #28's own fuzzed cases for
  // buildFinalDownloadFilename: a gallery title need not be safe HTTP-header
  // or filesystem input on its own. slugifyForFilename's ASCII-only output
  // alphabet is what actually guarantees safety here (there's nothing left
  // in the output a quote/CRLF/emoji could survive as) — these fuzz cases
  // exist to prove that holds for the NEW builder too, not just assert the
  // slugifier's own behavior a second time.
  it("never lets a quote in the gallery title break the Content-Disposition header", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow({ title: 'Boda "especial" de Ana' }));
    store.set("finals/only.jpg", { data: Buffer.from("bytes") });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/only.jpg" }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).not.toContain('"especial"');
    expect(disposition.match(/"/g)).toHaveLength(2); // exactly the two wrapping the filename
  });

  it("never lets a CRLF injection attempt in the gallery title leak a second header", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow({ title: "Boda\r\nX-Injected: evil" }));
    store.set("finals/only.jpg", { data: Buffer.from("bytes") });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/only.jpg" }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain("X-Injected");
  });

  it("falls back to a generic archive name for an emoji-only gallery title", async () => {
    authMock.mockResolvedValue(clientSession());
    const db = await seededDb();
    db.__rows.galleries.push(galleryRow({ title: "🎉🎉" }));
    store.set("finals/only.jpg", { data: Buffer.from("bytes") });
    db.__rows.assets.push(
      assetRow({ isSelected: true, isEdited: true, finalKey: "finals/only.jpg" }),
    );
    const { GET } = await import("./route");

    const response = await GET(requestFor(), paramsFor(GALLERY_ID));

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="galeria-fotos.zip"',
    );
  });
});

describe("buildZipDownloadFilename / buildZipEntryFilename", () => {
  it("dedupes two assets that share the same original filename with a numeric suffix", async () => {
    const { buildZipEntryFilename } = await import("./route");
    const used = new Set<string>();
    expect(buildZipEntryFilename("IMG_0001.JPG", "finals/a.jpg", used)).toBe("img-0001.jpg");
    expect(buildZipEntryFilename("IMG_0001.JPG", "finals/b.jpg", used)).toBe("img-0001-2.jpg");
    expect(buildZipEntryFilename("IMG_0001.JPG", "finals/c.jpg", used)).toBe("img-0001-3.jpg");
  });

  it("never produces a raw asset id as an entry name", async () => {
    const { buildZipEntryFilename } = await import("./route");
    const name = buildZipEntryFilename("IMG_0001.JPG", "finals/a.jpg", new Set());
    expect(name).not.toContain(ASSET_1_ID);
  });

  // Task #220's own required coverage, item #3: the entry name must carry
  // the REAL stored extension, driven by the asset's own `finalKey`, not a
  // hardcoded `.jpg` — the mixed-format-gallery case is the owner's actual
  // situation.
  it("ends in .png for a final stored at a .png key, not a hardcoded .jpg", async () => {
    const { buildZipEntryFilename } = await import("./route");
    const name = buildZipEntryFilename("IMG_0002.PNG", "finals/asset-2.png", new Set());
    expect(name).toBe("img-0002.png");
  });

  it("dedupes a .jpg and a .png entry that would otherwise share the same slugified base name", async () => {
    const { buildZipEntryFilename } = await import("./route");
    const used = new Set<string>();
    expect(buildZipEntryFilename("IMG_0001.JPG", "finals/a.jpg", used)).toBe("img-0001.jpg");
    // Same slug base ("img-0001"), different stored extension — must NOT
    // collide with the entry above just because the base matches; each
    // entry's OWN extension is what its candidate name is built from before
    // the collision check ever runs, so this lands as a genuinely distinct
    // name on the first try, not a numeric suffix.
    expect(buildZipEntryFilename("IMG_0001.PNG", "finals/b.png", used)).toBe("img-0001.png");
  });
});
