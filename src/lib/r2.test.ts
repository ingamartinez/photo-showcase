// vitest test workers run under Node, not Bun — the global `Bun` namespace
// src/lib/r2.ts constructs `Bun.S3Client` off (see that file's header
// comment for why it's a global reference and not a value `import { S3Client
// } from "bun"`) only exists inside the real Bun runtime. Any test that
// imports r2.ts, even transitively, must stub the `Bun` global before
// `getClient()` is ever called or it fails with "Bun is not defined".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const write = vi.fn().mockResolvedValue(0);
const presign = vi.fn().mockReturnValue("https://example.com/presigned-url");
const del = vi.fn().mockResolvedValue(undefined);
// Task #29: `getObjectStream` calls `getClient().file(key).stream()` — the
// fake's `.file()` returns a stand-in for Bun's `S3File`, minimal enough to
// exercise ONLY what that function actually touches.
const fileStream = vi.fn().mockReturnValue("fake-stream");
const file = vi.fn().mockReturnValue({ stream: fileStream });
// Task #29 review follow-up: `getObjectSize` calls `getClient().size(key)` —
// Bun's own HEAD-request-only size lookup (see r2.ts's own comment on why
// this never reads the object's bytes).
const size = vi.fn().mockResolvedValue(1024);
// Task #89: `objectExists` calls `getClient().exists(key)` — Bun's own
// HEAD-request-only existence check, the same mechanism `size` above uses.
const exists = vi.fn().mockResolvedValue(true);

class FakeS3Client {
  write = write;
  presign = presign;
  delete = del;
  file = file;
  size = size;
  exists = exists;
}

// r2Env() validates presence via zod; it doesn't care whether the values are
// real, so dummy strings are enough to exercise the client factory without
// touching the real bucket.
//
// APP_ENV (not NODE_ENV — see src/lib/r2.ts's header comment on why NODE_ENV
// is unusable here: Next/Turbopack constant-folds it at build time and dead-
// code-eliminates the non-production branch out of the compiled server
// bundle) defaults to "production" here so the pre-existing assertions below
// keep exercising the exact key shape that is already live in the bucket
// (task #38: production must keep resolving unprefixed `galleries/…` keys).
// The dedicated "environment namespacing" block below flips APP_ENV per test
// to cover the dev-prefixed side.
beforeEach(() => {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET = "test-bucket";
  vi.stubEnv("APP_ENV", "production");
  vi.stubGlobal("Bun", { S3Client: FakeS3Client });
  write.mockClear();
  presign.mockClear();
  del.mockClear();
  file.mockClear();
  fileStream.mockClear();
  size.mockClear();
  exists.mockClear();
  exists.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("key builders", () => {
  it("builds the proof key under galleries/{galleryId}/proofs/{assetId}.webp", async () => {
    const { proofKey } = await import("./r2");
    expect(proofKey("gallery-1", "asset-1")).toBe("galleries/gallery-1/proofs/asset-1.webp");
  });

  it("builds the final key under galleries/{galleryId}/finals/{assetId}.jpg", async () => {
    const { finalKey } = await import("./r2");
    expect(finalKey("gallery-1", "asset-1")).toBe("galleries/gallery-1/finals/asset-1.jpg");
  });

  it("keeps proof and final keys distinct for the same gallery/asset pair", async () => {
    const { proofKey, finalKey } = await import("./r2");
    expect(proofKey("g", "a")).not.toBe(finalKey("g", "a"));
  });

  // Task #89: the browsing-sized, unwatermarked derivative of a final.
  it("builds the display key under galleries/{galleryId}/display/{assetId}.webp", async () => {
    const { displayKey } = await import("./r2");
    expect(displayKey("gallery-1", "asset-1")).toBe("galleries/gallery-1/display/asset-1.webp");
  });

  it("keeps the display key distinct from BOTH the proof and the final for the same pair", async () => {
    const { proofKey, finalKey, displayKey } = await import("./r2");
    expect(displayKey("g", "a")).not.toBe(proofKey("g", "a"));
    expect(displayKey("g", "a")).not.toBe(finalKey("g", "a"));
  });

  // The property task #89 rests its "no migration needed" argument on, and
  // the ticket asks to be CONFIRMED rather than assumed: `displayKey` is a
  // pure function of (galleryId, assetId), exactly like its two siblings.
  // Same inputs, same string, every time and in any order — so a display
  // object's existence is fully implied by facts already on the asset row
  // (`final_key` set, `is_edited` true) and there is nothing per-row left for
  // a column to remember.
  it("is deterministic per (galleryId, assetId), which is why no display_key column exists", async () => {
    const { proofKey, finalKey, displayKey } = await import("./r2");

    const first = displayKey("g", "a");
    // Interleave other key builders and another pair, so a hidden counter or
    // any call-order dependence would show up as a different second result.
    proofKey("g", "a");
    finalKey("other-gallery", "other-asset");
    displayKey("other-gallery", "other-asset");

    expect(displayKey("g", "a")).toBe(first);
    expect(displayKey("g", "b")).not.toBe(first);
    expect(displayKey("h", "a")).not.toBe(first);
  });

  it("uses the exact ids given, without normalizing or trimming", async () => {
    const { proofKey } = await import("./r2");
    expect(proofKey("Gallery_1", "Asset-1")).toBe("galleries/Gallery_1/proofs/Asset-1.webp");
  });
});

describe("environment namespacing (task #38)", () => {
  it("prefixes proof keys with dev/ outside production", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { proofKey } = await import("./r2");
    expect(proofKey("gallery-1", "asset-1")).toBe("dev/galleries/gallery-1/proofs/asset-1.webp");
  });

  it("prefixes final keys with dev/ outside production", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { finalKey } = await import("./r2");
    expect(finalKey("gallery-1", "asset-1")).toBe("dev/galleries/gallery-1/finals/asset-1.jpg");
  });

  // Task #89's new key builder inherits the namespacing "for free by
  // construction" the same way its siblings do — it has to call
  // `namespacedKey` for its path to end up in the bucket at all (see r2.ts's
  // own comment). Asserted rather than assumed: a dev process writing an
  // unwatermarked derivative straight into a production prefix is exactly
  // the accident task #38 exists to prevent.
  it("prefixes display keys with dev/ outside production, and fails closed when APP_ENV is unset", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { displayKey } = await import("./r2");
    expect(displayKey("g", "a")).toBe("dev/galleries/g/display/a.webp");

    vi.stubEnv("APP_ENV", undefined);
    expect(displayKey("g", "a")).toBe("dev/galleries/g/display/a.webp");

    vi.stubEnv("APP_ENV", "production");
    expect(displayKey("g", "a")).toBe("galleries/g/display/a.webp");
  });

  it("also prefixes when APP_ENV is set to something other than production, so a non-production process never lands on a bare key", async () => {
    vi.stubEnv("APP_ENV", "test");
    const { proofKey } = await import("./r2");
    expect(proofKey("g", "a")).toBe("dev/galleries/g/proofs/a.webp");
  });

  it("fails CLOSED to the dev/ prefix when APP_ENV is entirely unset — the property the whole design rests on", async () => {
    vi.stubEnv("APP_ENV", undefined);
    const { proofKey, finalKey } = await import("./r2");
    expect(proofKey("g", "a")).toBe("dev/galleries/g/proofs/a.webp");
    expect(finalKey("g", "a")).toBe("dev/galleries/g/finals/a.jpg");
  });

  it("never prefixes in production, so keys written before this change keep resolving", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { proofKey, finalKey } = await import("./r2");
    expect(proofKey("g", "a")).toBe("galleries/g/proofs/a.webp");
    expect(finalKey("g", "a")).toBe("galleries/g/finals/a.jpg");
  });

  it("keeps a dev-built key and a prod-built key distinct for the same gallery/asset pair, so a dev process can never address a production object", async () => {
    const { proofKey } = await import("./r2");

    vi.stubEnv("APP_ENV", "development");
    const devKey = proofKey("g", "a");

    vi.stubEnv("APP_ENV", "production");
    const prodKey = proofKey("g", "a");

    expect(devKey).not.toBe(prodKey);
  });
});

describe("putObject", () => {
  it("writes to the given key with the given content type", async () => {
    const { putObject } = await import("./r2");
    await putObject("galleries/g/proofs/a.webp", "bytes", { contentType: "image/webp" });
    expect(write).toHaveBeenCalledWith("galleries/g/proofs/a.webp", "bytes", {
      type: "image/webp",
    });
  });
});

describe("getPresignedUrl", () => {
  it("presigns the given key with the named TTL constant", async () => {
    const { getPresignedUrl, PRESIGNED_URL_TTL_SECONDS } = await import("./r2");
    const url = getPresignedUrl("galleries/g/finals/a.jpg");
    expect(url).toBe("https://example.com/presigned-url");
    expect(presign).toHaveBeenCalledWith("galleries/g/finals/a.jpg", {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });
  });

  it("has a positive, finite TTL measured in seconds", async () => {
    const { PRESIGNED_URL_TTL_SECONDS } = await import("./r2");
    expect(PRESIGNED_URL_TTL_SECONDS).toBeGreaterThan(0);
    expect(Number.isFinite(PRESIGNED_URL_TTL_SECONDS)).toBe(true);
  });

  // Task #28: the `contentDisposition` override is what makes a phone
  // browser download a final instead of just displaying it — see the
  // function's own comment in r2.ts. Forwarded straight through to the S3
  // client's own `presign()` as `contentDisposition`, which is what actually
  // becomes the signed `response-content-disposition` query parameter.
  it("forwards contentDisposition to the underlying presign call when given", async () => {
    const { getPresignedUrl, PRESIGNED_URL_TTL_SECONDS } = await import("./r2");
    getPresignedUrl("galleries/g/finals/a.jpg", {
      contentDisposition: 'attachment; filename="foto.jpg"',
    });
    expect(presign).toHaveBeenCalledWith("galleries/g/finals/a.jpg", {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      contentDisposition: 'attachment; filename="foto.jpg"',
    });
  });

  // A proof URL (src/app/api/assets/[assetId]/proof/route.ts) never passes
  // this option — proofs are meant to be BROWSED inline in a grid, not
  // downloaded. Confirms the option is genuinely optional: no key is added
  // to the presign call at all when it's omitted, not an override set to
  // `undefined`.
  it("omits contentDisposition entirely from the presign call when not given", async () => {
    const { getPresignedUrl, PRESIGNED_URL_TTL_SECONDS } = await import("./r2");
    getPresignedUrl("galleries/g/proofs/a.webp");
    expect(presign).toHaveBeenCalledWith("galleries/g/proofs/a.webp", {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });
    const callArgs = presign.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.hasOwn(callArgs, "contentDisposition")).toBe(false);
  });
});

describe("deleteObject", () => {
  it("deletes the given key", async () => {
    const { deleteObject } = await import("./r2");
    await deleteObject("galleries/g/proofs/a.webp");
    expect(del).toHaveBeenCalledWith("galleries/g/proofs/a.webp");
  });
});

// Task #29 (download-all-as-zip): the ONE function in this module that
// returns a stream instead of a buffered value or a URL — see its own
// comment for why, and src/lib/zip-stream.ts for the caller that depends on
// this never buffering.
describe("getObjectStream", () => {
  it("resolves an S3File for the given key and returns its .stream()", async () => {
    const { getObjectStream } = await import("./r2");
    const result = getObjectStream("galleries/g/finals/a.jpg");
    expect(file).toHaveBeenCalledWith("galleries/g/finals/a.jpg");
    expect(fileStream).toHaveBeenCalledTimes(1);
    expect(result).toBe("fake-stream");
  });
});

// Task #29 review follow-up: the download-all route's pre-flight capacity
// check needs every entry's byte size WITHOUT reading the object itself —
// this is the one function in this module that answers that via a HEAD
// request (`getClient().size(key)`), never `.file(key).stream()`.
describe("getObjectSize", () => {
  it("resolves the given key's size via the client's own HEAD-request size lookup, not .file().stream()", async () => {
    size.mockResolvedValueOnce(20 * 1024 * 1024);
    const { getObjectSize } = await import("./r2");

    const result = await getObjectSize("galleries/g/finals/a.jpg");

    expect(size).toHaveBeenCalledWith("galleries/g/finals/a.jpg");
    expect(result).toBe(20 * 1024 * 1024);
    expect(file).not.toHaveBeenCalled();
    expect(fileStream).not.toHaveBeenCalled();
  });
});

// Task #89: the display route's ONE R2 probe. A final uploaded before that
// task shipped has no display object until the backfill script runs, and
// handing back a presigned URL for something absent would render a broken
// image instead of falling back to the proof.
describe("objectExists", () => {
  it("answers via the client's own HEAD-request existence check, never by reading the object", async () => {
    const { objectExists } = await import("./r2");

    await expect(objectExists("galleries/g/display/a.webp")).resolves.toBe(true);

    expect(exists).toHaveBeenCalledWith("galleries/g/display/a.webp");
    expect(file).not.toHaveBeenCalled();
    expect(fileStream).not.toHaveBeenCalled();
  });

  it("propagates a false answer rather than coercing it", async () => {
    exists.mockResolvedValueOnce(false);
    const { objectExists } = await import("./r2");
    await expect(objectExists("galleries/g/display/missing.webp")).resolves.toBe(false);
  });
});
