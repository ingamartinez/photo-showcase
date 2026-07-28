// vitest test workers run under Node, not Bun — the global `Bun` namespace
// src/lib/r2.ts constructs `Bun.S3Client` off (see that file's header
// comment for why it's a global reference and not a value `import { S3Client
// } from "bun"`) only exists inside the real Bun runtime. Any test that
// imports r2.ts, even transitively, must stub the `Bun` global before
// `getClient()` is ever called or it fails with "Bun is not defined".
import { beforeEach, describe, expect, it, vi } from "vitest";

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
beforeEach(() => {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET = "test-bucket";
  vi.stubGlobal("Bun", { S3Client: FakeS3Client });
  write.mockClear();
  presign.mockClear();
  del.mockClear();
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
