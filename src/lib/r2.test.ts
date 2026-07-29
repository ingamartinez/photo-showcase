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

class FakeS3Client {
  write = write;
  presign = presign;
  delete = del;
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
});

describe("deleteObject", () => {
  it("deletes the given key", async () => {
    const { deleteObject } = await import("./r2");
    await deleteObject("galleries/g/proofs/a.webp");
    expect(del).toHaveBeenCalledWith("galleries/g/proofs/a.webp");
  });
});
