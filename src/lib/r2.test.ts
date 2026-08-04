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

  it("builds the final key under galleries/{galleryId}/finals/{assetId}.{extension}", async () => {
    const { finalKey } = await import("./r2");
    expect(finalKey("gallery-1", "asset-1", "jpg")).toBe("galleries/gallery-1/finals/asset-1.jpg");
  });

  // Task #220: the extension is no longer hardcoded to `.jpg` — it comes
  // from the caller (the final upload route's own MIME-type allowlist).
  it("uses whatever extension the caller passes, e.g. png", async () => {
    const { finalKey } = await import("./r2");
    expect(finalKey("gallery-1", "asset-1", "png")).toBe("galleries/gallery-1/finals/asset-1.png");
  });

  // Task #220: same (galleryId, assetId) pair, different extension, must
  // produce a DIFFERENT key — this is the property the final route's
  // stale-object cleanup depends on to even know an old object exists.
  it("produces a different key for the same gallery/asset pair when the extension differs", async () => {
    const { finalKey } = await import("./r2");
    expect(finalKey("g", "a", "jpg")).not.toBe(finalKey("g", "a", "png"));
  });

  it("keeps proof and final keys distinct for the same gallery/asset pair", async () => {
    const { proofKey, finalKey } = await import("./r2");
    expect(proofKey("g", "a")).not.toBe(finalKey("g", "a", "jpg"));
  });

  // Task #220's own acceptance criterion, pinned the same way task #78's
  // `R2Key` branding is (see the "branding" describe block near the end of
  // this file): `extension` must be a REQUIRED argument, not defaulted to
  // `"jpg"` — a default would let a future caller silently reproduce the
  // exact bug #220 exists to fix. `@ts-expect-error` fails `tsc --noEmit` in
  // BOTH directions: today, because the 2-argument call is missing a required
  // parameter, and forever after, because if a future change ever gave
  // `extension` a default (silently un-doing this requirement), the
  // `@ts-expect-error` comment would stop being needed and typecheck would
  // fail on THAT instead.
  it("requires an extension argument at compile time — see the @ts-expect-error immediately below", async () => {
    const { finalKey } = await import("./r2");

    // @ts-expect-error — `extension` is required; omitting it would silently
    // reproduce #218's hardcoded-`.jpg` bug for every future caller.
    const key = finalKey("g", "a");

    expect(key).toBe("galleries/g/finals/a.undefined");
  });

  // Task #89: the browsing-sized, unwatermarked derivative of a final.
  it("builds the display key under galleries/{galleryId}/display/{assetId}.webp", async () => {
    const { displayKey } = await import("./r2");
    expect(displayKey("gallery-1", "asset-1")).toBe("galleries/gallery-1/display/asset-1.webp");
  });

  it("keeps the display key distinct from BOTH the proof and the final for the same pair", async () => {
    const { proofKey, finalKey, displayKey } = await import("./r2");
    expect(displayKey("g", "a")).not.toBe(proofKey("g", "a"));
    expect(displayKey("g", "a")).not.toBe(finalKey("g", "a", "jpg"));
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
    finalKey("other-gallery", "other-asset", "jpg");
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
    expect(finalKey("gallery-1", "asset-1", "jpg")).toBe(
      "dev/galleries/gallery-1/finals/asset-1.jpg",
    );
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
    expect(finalKey("g", "a", "jpg")).toBe("dev/galleries/g/finals/a.jpg");
  });

  it("never prefixes in production, so keys written before this change keep resolving", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { proofKey, finalKey } = await import("./r2");
    expect(proofKey("g", "a")).toBe("galleries/g/proofs/a.webp");
    expect(finalKey("g", "a", "jpg")).toBe("galleries/g/finals/a.jpg");
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

describe("nonGalleryKey (task #78)", () => {
  it("namespaces a non-gallery-shaped key exactly like the builders above, in production", async () => {
    const { nonGalleryKey } = await import("./r2");
    expect(nonGalleryKey("_healthcheck/123.txt")).toBe("_healthcheck/123.txt");
  });

  it("prefixes with dev/ outside production, same as every builder above", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { nonGalleryKey } = await import("./r2");
    expect(nonGalleryKey("_healthcheck/123.txt")).toBe("dev/_healthcheck/123.txt");
  });
});

describe("storedKey (task #78)", () => {
  it("returns the given string unchanged — it re-attaches the brand, it does not namespace", async () => {
    const { storedKey } = await import("./r2");
    expect(storedKey("galleries/g/proofs/a.webp")).toBe("galleries/g/proofs/a.webp");
  });

  // The property `nonGalleryKey` above deliberately does NOT have: a value
  // read back from the `assets` table was ALREADY namespaced by whichever
  // `APP_ENV` was active when it was originally written by
  // `proofKey`/`finalKey`. Re-namespacing it here would double the prefix.
  it("does NOT re-apply the dev/ prefix to an already-namespaced key, unlike nonGalleryKey", async () => {
    vi.stubEnv("APP_ENV", "development");
    const { storedKey } = await import("./r2");
    expect(storedKey("dev/galleries/g/proofs/a.webp")).toBe("dev/galleries/g/proofs/a.webp");
  });
});

// putObject/getPresignedUrl/deleteObject below all take an `R2Key` (task
// #78), never a bare string — every key in this section is built through
// `proofKey`/`finalKey` rather than a string literal, the same as any real
// caller would have to. See the "branding" describe block further down for
// the compile-time half of this guarantee (a literal DOES fail typecheck).
describe("putObject", () => {
  it("writes to the given key with the given content type", async () => {
    const { proofKey, putObject } = await import("./r2");
    const key = proofKey("g", "a");
    await putObject(key, "bytes", { contentType: "image/webp" });
    expect(write).toHaveBeenCalledWith(key, "bytes", {
      type: "image/webp",
    });
  });
});

describe("getPresignedUrl", () => {
  it("presigns the given key with the named TTL constant", async () => {
    const { finalKey, getPresignedUrl, PRESIGNED_URL_TTL_SECONDS } = await import("./r2");
    const key = finalKey("g", "a", "jpg");
    const url = getPresignedUrl(key);
    expect(url).toBe("https://example.com/presigned-url");
    expect(presign).toHaveBeenCalledWith(key, {
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
    const { finalKey, getPresignedUrl, PRESIGNED_URL_TTL_SECONDS } = await import("./r2");
    const key = finalKey("g", "a", "jpg");
    getPresignedUrl(key, {
      contentDisposition: 'attachment; filename="foto.jpg"',
    });
    expect(presign).toHaveBeenCalledWith(key, {
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
    const { getPresignedUrl, PRESIGNED_URL_TTL_SECONDS, proofKey } = await import("./r2");
    const key = proofKey("g", "a");
    getPresignedUrl(key);
    expect(presign).toHaveBeenCalledWith(key, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });
    const callArgs = presign.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.hasOwn(callArgs, "contentDisposition")).toBe(false);
  });
});

describe("deleteObject", () => {
  it("deletes the given key", async () => {
    const { deleteObject, proofKey } = await import("./r2");
    const key = proofKey("g", "a");
    await deleteObject(key);
    expect(del).toHaveBeenCalledWith(key);
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

// Task #78's acceptance criterion #1, pinned literally: "passing a raw
// string literal to `putObject` fails `bun run typecheck`". This repo had
// no prior `@ts-expect-error`-based type-level test to follow as a
// convention (checked before writing this), so this establishes one.
//
// `@ts-expect-error` requires TypeScript to raise a type error on the very
// next statement — if it does NOT, TS itself reports "Unused
// '@ts-expect-error' directive" as a compile error. That means this test
// fails `tsc --noEmit` in BOTH directions: today, because a bare string
// isn't an `R2Key`, and forever after, because if a future change ever
// widened `putObject`'s parameter back to `string` (silently un-doing this
// task), the `@ts-expect-error` comment would stop being needed and `tsc
// --noEmit` would fail on THAT instead. Either way, `bun run typecheck`
// cannot pass while this line's error status changes.
//
// The runtime assertion below is secondary — branding is fully erased at
// runtime (`R2Key` really is just `string`), so the call executes exactly
// like any other `putObject` call once type-stripped. It's here so the test
// isn't silently skipped/dead code and so `write` being called is itself
// proof the line actually ran, not just parsed.
describe("branding (task #78)", () => {
  it("rejects a bare string literal at compile time — see the @ts-expect-error immediately below", async () => {
    const { putObject } = await import("./r2");

    // @ts-expect-error — a bare string is not an `R2Key`. Use a builder
    // (proofKey/finalKey/displayKey) or a named escape hatch
    // (nonGalleryKey/storedKey) instead.
    await putObject("galleries/g/proofs/a.webp", "bytes", { contentType: "image/webp" });

    expect(write).toHaveBeenCalledWith("galleries/g/proofs/a.webp", "bytes", {
      type: "image/webp",
    });
  });
});
