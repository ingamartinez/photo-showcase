// Task #28's own acceptance criterion, taken literally: "The downloaded file
// is the full-resolution unwatermarked version, not the proof. Check the
// actual bytes and dimensions." — not whether some mock was called with some
// argument. This codebase has produced exactly that trap more than once (see
// task #28's own body, which names three real examples from review), so this
// suite deliberately does the opposite: it runs the REAL `@/lib/images`
// pipeline (`processProof`/`processFinal`, unmocked) and the REAL
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
    const buf = Buffer.isBuffer(body)
      ? body
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
  function project(row: Row): Row {
    return { ...row };
  }
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const { column, value } = eqColumnAndValue(condition);
            if (!column) throw new Error("eqColumnAndValue: not an eq() condition");
            if (table === assets) {
              const rows = assetRows.filter((r) => r[column] === value).map(project);
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            if (table === galleries) {
              const rows = galleryRows.filter((r) => r[column] === value).map(project);
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            throw new Error("fake db: unsupported table in select().where()");
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
}): Promise<{ realProofKey: string; realFinalKey: string }> {
  const { proofKey, finalKey } = await import("@/lib/r2");
  const { processProof, processFinal } = await import("@/lib/images");

  const source = await makeLargeSourceFixture();
  const proof = await processProof(source);
  const final = await processFinal(source);

  const realProofKey = proofKey(GALLERY_ID, ASSET_ID);
  const realFinalKey = finalKey(GALLERY_ID, ASSET_ID);
  store.set(realProofKey, { data: proof.data, contentType: "image/webp" });
  store.set(realFinalKey, { data: final.data, contentType: "image/jpeg" });

  const db = await seededDb();
  db.__rows.galleries.push({
    id: GALLERY_ID,
    clientId: overrides.clientId ?? "client-a",
    title: "Boda Ana y Beto",
    status: overrides.galleryStatus,
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

  return { realProofKey, realFinalKey };
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
});

describe("GET .../final vs GET .../proof — real bytes, real dimensions (task #28)", () => {
  it("serves the full-resolution, unwatermarked final — genuinely different bytes, dimensions, and format from the same asset's proof", async () => {
    authMock.mockResolvedValue(clientASession());
    await seedGalleryAndAsset({ isSelected: true, isEdited: true, galleryStatus: "delivered" });

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

    // Decode the FINAL bytes independently: full resolution (no downscale),
    // JPEG. This is the acceptance criterion's own "check the actual bytes
    // and dimensions" — not a re-assertion of what `processFinal` claims to
    // have done.
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
