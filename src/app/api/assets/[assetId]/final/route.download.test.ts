// Task #28's own acceptance criterion, taken literally: "The downloaded file
// is the full-resolution unwatermarked version, not the proof. Check the
// actual bytes and dimensions." — not whether some mock was called with some
// argument. This codebase has produced exactly that trap more than once (see
// task #28's own body, which names three real examples from review), so this
// suite deliberately does the opposite: it runs the REAL `@/lib/images`
// pipeline (`processProof`/`processDisplay`, unmocked) and the REAL
// `@/lib/r2` module (key builders + `getPresignedUrl`, unmocked) through the
// ACTUAL `GET /api/assets/[assetId]/final` and `GET
// /api/assets/[assetId]/proof` route handlers, backed only by an in-memory
// fake object store standing in for R2 — the same "stub the `Bun` global,
// not the module" technique src/lib/r2.test.ts already uses (see that file's
// own header comment for why `Bun.S3Client` needs stubbing at all under
// vitest). It then decodes whatever bytes each route's returned presigned
// URL resolves to with `sharp`, independently, and asserts on the REAL
// width/height/format — proving the final route serves a genuinely
// different object from the proof route for the SAME asset, not merely a
// same-shaped response.
//
// TASK #218: the final object this suite seeds at `finalKey` is now written
// EXACTLY as an admin upload would land there — the raw fixture bytes,
// untouched, no `processFinal` call (that function is deleted; there is no
// sharp pass on the final's own write path any more). See
// `seedGalleryAndAsset` below.
//
// Only the DB and the `Bun` global are faked; everything from the route
// handler down to the encoded bytes is real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import sharp from "sharp";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// In-memory stand-in for the R2 bucket, keyed EXACTLY like the real bucket
// would be — `write` records real bytes under the real (env-namespaced) key,
// `presign` returns a URL this suite can resolve straight back to those same
// bytes without any real network call ever happening.
type StoredObject = { data: Buffer; contentType: string };
const store = new Map<string, StoredObject>();

class FakeS3Client {
  async write(key: string, body: unknown, opts: { type: string }): Promise<number> {
    // Task #220: the real route no longer copies the upload into a `Buffer`
    // before calling `putObject` — it passes the raw `ArrayBuffer`
    // `file.arrayBuffer()` returns (see that route's own comment on why).
    // This fake must accept the SAME shapes Bun's real `S3Client.write`
    // does, so this suite keeps exercising what the route actually sends,
    // not a shape only the OLD `Buffer.from()` copy ever produced.
    const buf = Buffer.isBuffer(body)
      ? body
      : body instanceof ArrayBuffer
        ? Buffer.from(body)
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : Buffer.from(String(body));
    store.set(key, { data: buf, contentType: opts.type });
    return buf.byteLength;
  }
  presign(key: string): string {
    return `https://fake-r2.test/${encodeURIComponent(key)}`;
  }
  async delete(key: string): Promise<void> {
    store.delete(key);
  }
  // Task #93: GET .../final now confirms the R2 object actually exists
  // (a HEAD-request-only check, `objectExists` — see src/lib/r2.ts, which
  // calls `getClient().exists(key)` directly, not `.file(key)`) before
  // presigning it. This suite's fake bucket needs the SAME "is it really
  // there" answer `store` already gives every other method here.
  async exists(key: string): Promise<boolean> {
    return store.has(key);
  }
}

function keyFromFakeUrl(url: string): string {
  const prefix = "https://fake-r2.test/";
  if (!url.startsWith(prefix)) throw new Error(`not a fake R2 url: ${url}`);
  return decodeURIComponent(url.slice(prefix.length));
}

// Minimal fake DB — same "always return a FRESH COPY on select, mutate the
// shared row array on update" shape as ./route.test.ts's own fake (the FIXED
// version — see that file's own comment on `project` for why it must never
// return the live row reference).
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
  const { assets, galleries, galleryClients } = await import("@/lib/db/schema");
  const assetRows: Row[] = [];
  const galleryRows: Row[] = [];
  const galleryClientRows: Row[] = [];
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
      // TASK #218: the new real-pipeline POST tests below need this — the
      // route's own POST handler calls `db.update(assets).set(...).where(...)`
      // after a successful upload. Same shape as ./route.test.ts's own fake.
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

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function paramsFor(assetId: string) {
  return { params: Promise.resolve({ assetId }) };
}

// A real, multi-megapixel photo-sized fixture — "not a synthetic 10x10
// fixture" (task #14's own acceptance criteria, reused here so the
// full-resolution-vs-downscaled comparison is between two REAL sizes, not a
// trivially small one that could pass by accident).
const LARGE_WIDTH = 4000;
const LARGE_HEIGHT = 2667;

async function makeLargeSourceFixture(): Promise<Buffer> {
  return sharp({
    create: {
      width: LARGE_WIDTH,
      height: LARGE_HEIGHT,
      channels: 3,
      background: { r: 120, g: 140, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function seedGalleryAndAsset(overrides: {
  isSelected: boolean;
  isEdited: boolean;
  galleryStatus: string;
  clientId?: string;
  // TASK #218: lets a test seed the final with a SPECIFIC fixture (e.g. one
  // carrying a location-leak marker) instead of the plain default. Defaults
  // to `makeLargeSourceFixture()` when omitted.
  sourceOverride?: Buffer;
}): Promise<{ realProofKey: string; realFinalKey: string; sourceBytes: Buffer }> {
  const { proofKey, finalKey } = await import("@/lib/r2");
  const { processProof } = await import("@/lib/images");

  const source = overrides.sourceOverride ?? (await makeLargeSourceFixture());
  const proof = await processProof(source);

  const realProofKey = proofKey(GALLERY_ID, ASSET_ID);
  const realFinalKey = finalKey(GALLERY_ID, ASSET_ID, "jpg");
  store.set(realProofKey, { data: proof.data, contentType: "image/webp" });
  // TASK #218: the final is stored EXACTLY as an admin upload would land
  // here — `source` itself, untouched. There is no `processFinal` call any
  // more; the POST route's own contract (proven in route.test.ts's byte-
  // identity test) is that `finalKey`'s bytes ARE the upload's bytes, so this
  // fake-R2 seed reproduces that contract directly rather than routing
  // through a function that no longer exists.
  store.set(realFinalKey, { data: source, contentType: "image/jpeg" });

  const db = await seededDb();
  db.__rows.galleries.push({
    id: GALLERY_ID,
    title: "Boda Ana y Beto",
    status: overrides.galleryStatus,
  });
  // Task #94: ownership is now a `gallery_clients` row, not a `clientId`
  // column on the gallery itself.
  db.__rows.galleryClients.push({
    galleryId: GALLERY_ID,
    userId: overrides.clientId ?? "client-a",
  });
  db.__rows.assets.push({
    id: ASSET_ID,
    galleryId: GALLERY_ID,
    originalFilename: "IMG_0001.JPG",
    proofKey: realProofKey,
    finalKey: realFinalKey,
    isSelected: overrides.isSelected,
    isEdited: overrides.isEdited,
  });

  return { realProofKey, realFinalKey, sourceBytes: source };
}

beforeEach(async () => {
  authMock.mockReset();
  store.clear();
  vi.stubGlobal("Bun", { S3Client: FakeS3Client });
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET = "test-bucket";
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  // Every test re-seeds its own gallery/asset row via `seedGalleryAndAsset`
  // — this suite's fake db never resets rows on its own (unlike
  // ./route.test.ts's own fake, which is torn down and rebuilt with a fresh
  // module registry per test file, not per test), so without this explicit
  // clear the SAME (galleryId, assetId) pair would accumulate multiple rows
  // across tests and `.limit(1)` would silently return the FIRST one ever
  // pushed instead of the one the current test just seeded.
  const db = await seededDb();
  db.__rows.assets.length = 0;
  db.__rows.galleries.length = 0;
  db.__rows.galleryClients.length = 0;
});

describe("GET .../final vs GET .../proof — real bytes, real dimensions (task #28)", () => {
  it("serves the full-resolution, unwatermarked final — genuinely different bytes, dimensions, and format from the same asset's proof", async () => {
    authMock.mockResolvedValue(clientASession());
    const { sourceBytes } = await seedGalleryAndAsset({
      isSelected: true,
      isEdited: true,
      galleryStatus: "delivered",
    });

    const { GET: getFinal } = await import("./route");
    const { GET: getProof } = await import("../proof/route");

    const finalResponse = await getFinal(
      new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`),
      paramsFor(ASSET_ID),
    );
    expect(finalResponse.status).toBe(200);
    const { url: finalUrl } = (await finalResponse.json()) as { url: string };

    const proofResponse = await getProof(
      new NextRequest(`http://localhost/api/assets/${ASSET_ID}/proof`),
      paramsFor(ASSET_ID),
    );
    expect(proofResponse.status).toBe(200);
    const { url: proofUrl } = (await proofResponse.json()) as { url: string };

    // Resolve each returned URL back to the actual stored bytes — standing
    // in for the real HTTP GET a browser would make against R2.
    const servedFinal = store.get(keyFromFakeUrl(finalUrl));
    const servedProof = store.get(keyFromFakeUrl(proofUrl));
    if (!servedFinal || !servedProof) throw new Error("object missing from fake store");

    // The two routes resolve to DIFFERENT R2 objects entirely.
    expect(keyFromFakeUrl(finalUrl)).not.toBe(keyFromFakeUrl(proofUrl));
    expect(Buffer.compare(servedFinal.data, servedProof.data)).not.toBe(0);

    // TASK #218's own acceptance criterion, at the real-pipeline layer: the
    // served final is `Buffer.equals` to what was "uploaded" (the fixture
    // this suite seeded), not merely a same-format/same-size re-encode.
    expect(servedFinal.data.equals(sourceBytes)).toBe(true);

    // Decode the FINAL bytes independently: full resolution (no downscale),
    // JPEG. This is the acceptance criterion's own "check the actual bytes
    // and dimensions" — not a re-assertion of what the route claims to have
    // done.
    const finalMeta = await sharp(servedFinal.data).metadata();
    expect(finalMeta.format).toBe("jpeg");
    expect(finalMeta.width).toBe(LARGE_WIDTH);
    expect(finalMeta.height).toBe(LARGE_HEIGHT);

    // Decode the PROOF bytes independently: downscaled, WebP — genuinely
    // smaller than the final, not just labeled differently.
    const proofMeta = await sharp(servedProof.data).metadata();
    expect(proofMeta.format).toBe("webp");
    expect(Math.max(proofMeta.width!, proofMeta.height!)).toBeLessThan(LARGE_WIDTH);

    // The Content-Disposition sent along with the presigned URL is what
    // makes a phone browser download rather than display the final (see
    // src/lib/r2.ts's own comment) — this suite has no real HTTP layer to
    // observe the actual response header through, but the filename it
    // carries is exercised directly in ./route.test.ts's own
    // `buildFinalDownloadFilename` suite and the header's presence is
    // exercised in src/lib/r2.test.ts's own `getPresignedUrl` suite.
  });

  it("refuses the SAME real bytes to a client who does not own the gallery — a direct request, not a mocked ownership check", async () => {
    await seedGalleryAndAsset({ isSelected: true, isEdited: true, galleryStatus: "delivered" });
    authMock.mockResolvedValue(clientBSession());

    const { GET: getFinal } = await import("./route");
    const response = await getFinal(
      new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`),
      paramsFor(ASSET_ID),
    );

    expect(response.status).toBe(403);
  });

  it("refuses an unauthenticated direct request for the same asset", async () => {
    await seedGalleryAndAsset({ isSelected: true, isEdited: true, galleryStatus: "delivered" });
    authMock.mockResolvedValue(null);

    const { GET: getFinal } = await import("./route");
    const response = await getFinal(
      new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`),
      paramsFor(ASSET_ID),
    );

    expect(response.status).toBe(401);
  });

  it("refuses the owning client the same final before the gallery is delivered", async () => {
    await seedGalleryAndAsset({ isSelected: true, isEdited: true, galleryStatus: "selected" });
    authMock.mockResolvedValue(clientASession());

    const { GET: getFinal } = await import("./route");
    const response = await getFinal(
      new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`),
      paramsFor(ASSET_ID),
    );

    expect(response.status).toBe(404);
  });
});

// TASK #218's own required coverage, run through the REAL POST handler, REAL
// `@/lib/images` pipeline and REAL `@/lib/r2` key builders — only the DB and
// the `Bun` global (the fake bucket) are faked, same discipline as the GET
// suite above. This is deliberately NOT covered only at ./route.test.ts's
// mocked boundary: a mock can assert "the route called putObject with X" even
// if X were computed wrong, but it cannot lie about what a REAL sharp pass
// actually produced.
describe("POST /api/assets/[assetId]/final — byte-for-byte storage and metadata (task #218)", () => {
  // A location-leak marker stands in for a GPS tag — sharp's `Exif` type has
  // no separate GPS-IFD support (only IFD0-3), so a raw `GPSLatitude` string
  // round-trips unreliably through `withExif()`; an `ImageDescription`
  // carrying a plain-text location is what src/lib/images.test.ts already
  // uses for the identical reason, kept consistent here.
  const LOCATION_LEAK_MARKER = "Shot at 123 Main St, Client Hometown";
  const ORIGINAL_COPYRIGHT_MARKER = "Some Other Photographer Studio";

  async function makeGpsFixture(): Promise<Buffer> {
    return sharp({
      create: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .withExif({
        IFD0: { Copyright: ORIGINAL_COPYRIGHT_MARKER, ImageDescription: LOCATION_LEAK_MARKER },
      })
      .toBuffer();
  }

  const BACKGROUND = { r: 120, g: 140, b: 160 };

  function jpegFile(bytes: Buffer, name = "IMG_0001-edit.jpg"): File {
    // `Buffer`'s `ArrayBufferLike` backing is not assignable to `BlobPart`
    // (`SharedArrayBuffer` is a valid `Buffer` backing store but not a valid
    // `File`/`Blob` part) — a `Uint8Array` view over the same bytes is.
    return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
  }

  async function postFinal(bytes: Buffer) {
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", jpegFile(bytes));
    const request = new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`, {
      method: "POST",
      body: formData,
    });
    return POST(request, paramsFor(ASSET_ID));
  }

  beforeEach(async () => {
    const db = await seededDb();
    db.__rows.galleries.push({ id: GALLERY_ID, title: "Boda Ana y Beto", status: "delivered" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a" });
    db.__rows.assets.push({
      id: ASSET_ID,
      galleryId: GALLERY_ID,
      originalFilename: "IMG_0001.JPG",
      isSelected: true,
      isEdited: false,
      finalKey: null,
    });
    authMock.mockResolvedValue(adminSession());
  });

  // Required coverage #1 (task #218's own list): byte-for-byte identity, at
  // the real R2/pipeline layer this time (the mocked-boundary version lives
  // in ./route.test.ts). MUTATION PROOF: reverting the route's
  // `putObject(key, finalBytes, ...)` call to write `display.data` instead
  // turns this test red — the stored bytes decode as WebP, not JPEG, and
  // `Buffer.equals` against the uploaded JPEG fails outright.
  it("stores the uploaded bytes at finalKey byte-for-byte, no re-encode", async () => {
    const { finalKey } = await import("@/lib/r2");
    const uploaded = await makeGpsFixture();

    const response = await postFinal(uploaded);

    expect(response.status).toBe(200);
    const stored = store.get(finalKey(GALLERY_ID, ASSET_ID, "jpg"));
    if (!stored) throw new Error("final object missing from fake store");
    expect(stored.data.equals(uploaded)).toBe(true);
  });

  // Required coverage #2: EXIF survives on the stored final — this is the
  // owner's accepted trade (task #218), pinned by a test so nobody "fixes"
  // it later without another explicit decision.
  it("keeps the full, unfiltered EXIF on the stored final — including the location leak (owner's accepted trade)", async () => {
    const { finalKey } = await import("@/lib/r2");
    const uploaded = await makeGpsFixture();

    const response = await postFinal(uploaded);

    expect(response.status).toBe(200);
    const stored = store.get(finalKey(GALLERY_ID, ASSET_ID, "jpg"));
    if (!stored) throw new Error("final object missing from fake store");
    const storedMeta = await sharp(stored.data).metadata();
    expect(storedMeta.exif).toBeDefined();
    expect(stored.data.includes(LOCATION_LEAK_MARKER)).toBe(true);
    expect(stored.data.includes(ORIGINAL_COPYRIGHT_MARKER)).toBe(true);
  });

  // Required coverage #3: the invariant that still matters after task #218 —
  // the display derivative must NOT carry what the final now does.
  // MUTATION PROOF: feeding `processDisplay` the wrong thing would not catch
  // this (there is no wrong thing left to feed it — the route has exactly one
  // buffer), but reverting `processDisplay`'s own `.withExif()` allowlist
  // call in src/lib/images.ts to a no-op (or removing it) turns this red: the
  // location marker would then survive into the display bytes too.
  it("does NOT carry the location leak (or the original studio's copyright) on the display derivative", async () => {
    const { displayKey } = await import("@/lib/r2");
    const uploaded = await makeGpsFixture();

    const response = await postFinal(uploaded);

    expect(response.status).toBe(200);
    const storedDisplay = store.get(displayKey(GALLERY_ID, ASSET_ID));
    if (!storedDisplay) throw new Error("display object missing from fake store");
    expect(storedDisplay.data.includes(LOCATION_LEAK_MARKER)).toBe(false);
    expect(storedDisplay.data.includes(ORIGINAL_COPYRIGHT_MARKER)).toBe(false);
    // And it DOES carry the app's own authorship allowlist — proving the
    // absence above is `processDisplay` actively filtering, not merely sharp
    // stripping everything (which would also make the negative assertions
    // above trivially true for the wrong reason).
    const { FINAL_EXIF_ARTIST, FINAL_EXIF_COPYRIGHT } = await import("@/lib/images");
    expect(storedDisplay.data.includes(FINAL_EXIF_COPYRIGHT)).toBe(true);
    expect(storedDisplay.data.includes(FINAL_EXIF_ARTIST)).toBe(true);
  });

  // Required coverage #4 (task #218's list; the format itself widened by
  // #220): a format outside the allowlist is still rejected with 415,
  // exercised through the REAL route (not the mocked one) so nothing about
  // the fake pipeline could mask the gate being skipped.
  it("rejects an unsupported image format (GIF) with 415 and writes nothing to the real fake bucket", async () => {
    const { POST } = await import("./route");
    const gif = new File(["not-a-real-gif-but-has-the-right-mime"], "edit.gif", {
      type: "image/gif",
    });
    const formData = new FormData();
    formData.set("file", gif);
    const request = new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`, {
      method: "POST",
      body: formData,
    });

    const response = await POST(request, paramsFor(ASSET_ID));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "not_an_image" });
    expect(store.size).toBe(0);
  });
});

// TASK #220's own required coverage, run through the REAL POST handler, REAL
// `@/lib/images` pipeline (unmocked `processDisplay`) and REAL `@/lib/r2` key
// builders — same discipline as the #218 describe block above, extended to
// the format this task actually adds: PNG. This is deliberately NOT covered
// only at ./route.test.ts's mocked boundary — a mock can assert "the route
// called processDisplay with a PNG" without proving sharp can actually decode
// one, downscale it, and still strip metadata correctly.
describe("POST /api/assets/[assetId]/final — PNG finals, real pipeline (task #220)", () => {
  const PNG_LOCATION_LEAK_MARKER = "Shot at 456 Second St, Client Hometown";
  const BACKGROUND = { r: 90, g: 110, b: 200 };

  async function makePngGpsFixture(): Promise<Buffer> {
    return sharp({
      create: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3, background: BACKGROUND },
    })
      .png()
      .withExif({ IFD0: { ImageDescription: PNG_LOCATION_LEAK_MARKER } })
      .toBuffer();
  }

  function pngFile(bytes: Buffer, name = "IMG_0002-edit.png"): File {
    return new File([new Uint8Array(bytes)], name, { type: "image/png" });
  }

  async function postPngFinal(bytes: Buffer) {
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", pngFile(bytes));
    const request = new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`, {
      method: "POST",
      body: formData,
    });
    return POST(request, paramsFor(ASSET_ID));
  }

  beforeEach(async () => {
    const db = await seededDb();
    db.__rows.galleries.push({ id: GALLERY_ID, title: "Boda Ana y Beto", status: "delivered" });
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a" });
    db.__rows.assets.push({
      id: ASSET_ID,
      galleryId: GALLERY_ID,
      originalFilename: "IMG_0002.PNG",
      isSelected: true,
      isEdited: false,
      finalKey: null,
    });
    authMock.mockResolvedValue(adminSession());
  });

  // Required coverage #1/#2: byte-for-byte identity AND the key really ends
  // in .png, at the real R2/pipeline layer. MUTATION PROOF: reverting
  // `ACCEPTED_FINAL_FORMATS["image/png"]` to some other extension (or
  // removing the entry) turns this red — either the key stops ending in
  // `.png` or the upload 415s outright.
  it("stores a PNG upload byte-for-byte at a key ending in .png", async () => {
    const { finalKey } = await import("@/lib/r2");
    const uploaded = await makePngGpsFixture();

    const response = await postPngFinal(uploaded);

    expect(response.status).toBe(200);
    const expectedKey = finalKey(GALLERY_ID, ASSET_ID, "png");
    expect(expectedKey.endsWith(".png")).toBe(true);
    const stored = store.get(expectedKey);
    if (!stored) throw new Error("final object missing from fake store");
    expect(stored.data.equals(uploaded)).toBe(true);
    expect(stored.contentType).toBe("image/png");
  });

  // Required coverage #7: the display derivative from a PNG upload is still
  // WebP, downscaled, and GPS-free — the invariant #218 established for JPEG
  // finals must survive the new input format. MUTATION PROOF: reverting
  // `processDisplay`'s `.withExif()` allowlist call (src/lib/images.ts) to a
  // no-op turns the GPS-free assertion red for a PNG input exactly the same
  // way it would for a JPEG one — the leak marker would survive into the
  // display bytes.
  it("still produces a downscaled, WebP, GPS-free display derivative from a PNG upload", async () => {
    const { displayKey } = await import("@/lib/r2");
    const uploaded = await makePngGpsFixture();

    const response = await postPngFinal(uploaded);

    expect(response.status).toBe(200);
    const storedDisplay = store.get(displayKey(GALLERY_ID, ASSET_ID));
    if (!storedDisplay) throw new Error("display object missing from fake store");

    const displayMeta = await sharp(storedDisplay.data).metadata();
    expect(displayMeta.format).toBe("webp");
    expect(Math.max(displayMeta.width!, displayMeta.height!)).toBeLessThan(LARGE_WIDTH);
    expect(storedDisplay.data.includes(PNG_LOCATION_LEAK_MARKER)).toBe(false);
  });

  // Task #220's own required coverage, item #3 — a MIXED-format gallery is
  // the owner's actual situation: one asset's final is JPEG, another's is
  // PNG, driven end-to-end through the real route/pipeline for both.
  it("keeps a mixed-format gallery honest: one asset's final .jpg, another's .png, each with its own extension", async () => {
    const { finalKey, proofKey } = await import("@/lib/r2");
    const { processProof } = await import("@/lib/images");
    const JPEG_ASSET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const jpegSource = await makeLargeSourceFixture();
    const jpegProof = await processProof(jpegSource);
    store.set(proofKey(GALLERY_ID, JPEG_ASSET_ID), {
      data: jpegProof.data,
      contentType: "image/webp",
    });
    const db = await seededDb();
    db.__rows.assets.push({
      id: JPEG_ASSET_ID,
      galleryId: GALLERY_ID,
      originalFilename: "IMG_0001.JPG",
      proofKey: proofKey(GALLERY_ID, JPEG_ASSET_ID),
      isSelected: true,
      isEdited: false,
      finalKey: null,
    });

    const pngUploaded = await makePngGpsFixture();
    const jpegFormData = new FormData();
    jpegFormData.set(
      "file",
      new File([new Uint8Array(jpegSource)], "IMG_0001.jpg", {
        type: "image/jpeg",
      }),
    );
    const { POST } = await import("./route");
    const jpegResponse = await POST(
      new NextRequest(`http://localhost/api/assets/${JPEG_ASSET_ID}/final`, {
        method: "POST",
        body: jpegFormData,
      }),
      paramsFor(JPEG_ASSET_ID),
    );
    const pngResponse = await postPngFinal(pngUploaded);

    expect(jpegResponse.status).toBe(200);
    expect(pngResponse.status).toBe(200);

    const jpegStored = store.get(finalKey(GALLERY_ID, JPEG_ASSET_ID, "jpg"));
    const pngStored = store.get(finalKey(GALLERY_ID, ASSET_ID, "png"));
    if (!jpegStored || !pngStored) throw new Error("expected both finals in the fake store");
    expect((await sharp(jpegStored.data).metadata()).format).toBe("jpeg");
    expect((await sharp(pngStored.data).metadata()).format).toBe("png");
  });

  // Task #220's own required coverage, item #4, at the real R2/pipeline
  // layer: re-uploading with a different extension (a .jpg final replaced by
  // a .png one — the owner's actual situation) must leave no orphaned
  // object, and the old key must genuinely be gone from the (fake) bucket
  // afterward. MUTATION PROOF: this is the same claim ./route.test.ts's
  // mocked-boundary test proves via `deleteObjectMock`; here the proof is
  // that `store.has(oldKey)` actually flips to `false` against a REAL
  // (fake-backed) `deleteObject` call, not merely that a mock was invoked
  // with the right argument.
  it("re-uploading in a different format leaves the old real object deleted from the store", async () => {
    const { finalKey } = await import("@/lib/r2");
    const jpegSource = await makeLargeSourceFixture();
    const jpegFormData = new FormData();
    jpegFormData.set(
      "file",
      new File([new Uint8Array(jpegSource)], "IMG_0002.jpg", { type: "image/jpeg" }),
    );
    const { POST } = await import("./route");
    const firstResponse = await POST(
      new NextRequest(`http://localhost/api/assets/${ASSET_ID}/final`, {
        method: "POST",
        body: jpegFormData,
      }),
      paramsFor(ASSET_ID),
    );
    expect(firstResponse.status).toBe(200);
    const jpgKey = finalKey(GALLERY_ID, ASSET_ID, "jpg");
    expect(store.has(jpgKey)).toBe(true);

    const pngUploaded = await makePngGpsFixture();
    const secondResponse = await postPngFinal(pngUploaded);

    expect(secondResponse.status).toBe(200);
    const pngKey = finalKey(GALLERY_ID, ASSET_ID, "png");
    expect(store.has(pngKey)).toBe(true);
    expect(store.has(jpgKey)).toBe(false);
  });
});
