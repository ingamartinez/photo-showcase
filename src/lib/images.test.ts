import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PROOF_MAX_LONG_EDGE, assertTileHasInk, processProof } from "./images";
import type { ProcessedProof } from "./images";

// Fixtures are generated in-process with sharp's synthetic `create` input —
// no binary asset is committed to the repo, and "large" here means a real
// multi-megapixel photo-sized buffer (task #14's acceptance criteria calls
// out "not a synthetic 10x10 fixture").
const LARGE_WIDTH = 4000;
const LARGE_HEIGHT = 2667; // ~10.7 MP, roughly a full-frame camera's output

const EXIF_MARKER = "Definitely Not Stripped Copyright Marker";
const BACKGROUND = { r: 180, g: 180, b: 180 };

async function makeLargeFixture(): Promise<Buffer> {
  return sharp({
    create: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3, background: BACKGROUND },
  })
    .jpeg()
    .withExif({ IFD0: { Copyright: EXIF_MARKER } })
    .toBuffer();
}

/** Confirms a processed proof actually has watermark ink painted into its
 * pixels, not merely that `processProof` returned without throwing. Used for
 * small-canvas cases (finding 2's fix) where the tile is clamped down and a
 * dedicated grid-coverage assay (like the large-fixture ink test below)
 * would be overkill — here we only need to prove the mark is present at
 * all. */
async function assertHasWatermarkInk(
  result: ProcessedProof,
  background: { r: number; g: number; b: number },
): Promise<void> {
  const { data: raw, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const threshold = 10;
  let inkedPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      if (
        Math.abs(raw[offset] - background.r) > threshold ||
        Math.abs(raw[offset + 1] - background.g) > threshold ||
        Math.abs(raw[offset + 2] - background.b) > threshold
      ) {
        inkedPixels++;
      }
    }
  }

  expect(inkedPixels).toBeGreaterThan(0);
}

/** Rewrites a JPEG's declared SOF0 width/height without touching its actual
 * entropy-coded pixel data. Used to build cheap fixtures for the
 * `limitInputPixels` guard: sharp/libvips reads these header dimensions
 * before deciding whether to decode, so a 64x64 real JPEG can pose as a
 * declared 20000x20000 one without ever encoding a real 400-megapixel
 * image. */
function patchJpegDimensions(jpeg: Buffer, width: number, height: number): Buffer {
  const buf = Buffer.from(jpeg);
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xc0) {
      // SOF0 marker (2 bytes) + segment length (2 bytes) + sample precision
      // (1 byte) precede height (2 bytes, big-endian) then width (2 bytes).
      buf.writeUInt16BE(height, i + 5);
      buf.writeUInt16BE(width, i + 7);
      return buf;
    }
  }
  throw new Error("SOF0 marker not found in fixture JPEG");
}

describe("processProof", () => {
  it("downscales, watermarks, strips EXIF, and outputs WebP for a real large photo", async () => {
    const fixture = await makeLargeFixture();

    // Sanity-check the fixture itself: it really does carry EXIF, so the
    // later assertion that it's gone actually proves something.
    const fixtureMeta = await sharp(fixture).metadata();
    expect(fixtureMeta.exif).toBeDefined();
    expect(fixture.includes(EXIF_MARKER)).toBe(true);

    const result = await processProof(fixture);

    // WebP, long edge capped at PROOF_MAX_LONG_EDGE.
    const outputMeta = await sharp(result.data).metadata();
    expect(outputMeta.format).toBe("webp");
    expect(Math.max(outputMeta.width!, outputMeta.height!)).toBeLessThanOrEqual(
      PROOF_MAX_LONG_EDGE,
    );
    // The fixture is landscape and much larger than the cap, so the long
    // edge should land exactly on it, not merely under it.
    expect(outputMeta.width).toBe(PROOF_MAX_LONG_EDGE);

    // The dimensions processProof reports must match the actual output
    // bytes — re-decode independently rather than trusting processProof's
    // own accounting.
    expect(result.width).toBe(outputMeta.width);
    expect(result.height).toBe(outputMeta.height);

    // EXIF is gone: checked both via the structured metadata field and via
    // a raw byte search for the exact marker string embedded above.
    expect(outputMeta.exif).toBeUndefined();
    expect(result.data.includes(EXIF_MARKER)).toBe(false);
  });

  it("actually paints watermark ink into the output pixels, spread across the image", async () => {
    const fixture = await makeLargeFixture();
    const result = await processProof(fixture);

    const { data: raw, info } = await sharp(result.data)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    function differsFromBackground(x: number, y: number): boolean {
      const offset = (y * width + x) * channels;
      const threshold = 10;
      return (
        Math.abs(raw[offset] - BACKGROUND.r) > threshold ||
        Math.abs(raw[offset + 1] - BACKGROUND.g) > threshold ||
        Math.abs(raw[offset + 2] - BACKGROUND.b) > threshold
      );
    }

    // Sample a grid of cells across the whole image. The watermark tiles
    // repeatedly, so most cells should contain at least one painted pixel —
    // this is what proves the mark is actually in the pixel data (not just
    // that `composite()` was called) and that it reaches across the whole
    // image rather than sitting in one crop-able corner.
    const gridSize = 6;
    const cellWidth = Math.floor(width / gridSize);
    const cellHeight = Math.floor(height / gridSize);
    let cellsWithInk = 0;

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        let found = false;
        for (let sy = 0; sy < cellHeight && !found; sy += 8) {
          for (let sx = 0; sx < cellWidth && !found; sx += 8) {
            if (differsFromBackground(col * cellWidth + sx, row * cellHeight + sy)) {
              found = true;
            }
          }
        }
        if (found) cellsWithInk++;
      }
    }

    // Loose bound: this is about proving broad tiling coverage, not pinning
    // down the exact tile phase against the grid.
    expect(cellsWithInk).toBeGreaterThanOrEqual(Math.ceil(gridSize * gridSize * 0.6));
  });

  it("does not upscale an image already smaller than the max long edge", async () => {
    const width = 400;
    const height = 300;
    const fixture = await sharp({
      create: { width, height, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const result = await processProof(fixture);

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
  });

  // Regression coverage for a real bug found in review: `composite({ tile:
  // true })` requires the overlay to fit within the canvas on both axes.
  // Before the fix, any image narrower than WATERMARK_TILE_WIDTH (320) or
  // shorter than WATERMARK_TILE_HEIGHT (160) made processProof throw an
  // opaque libvips error — including an ordinary 300x400 portrait crop, not
  // an exotic input. The existing 400x300 case above sits just above the
  // threshold on both axes, which is why the bug was invisible until now.
  it("watermarks a 300x400 portrait smaller than the watermark tile instead of throwing", async () => {
    const width = 300;
    const height = 400;
    const fixture = await sharp({
      create: { width, height, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const result = await processProof(fixture);

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    await assertHasWatermarkInk(result, BACKGROUND);
  });

  it("watermarks a 100x100 image smaller than the watermark tile on both axes instead of throwing", async () => {
    const width = 100;
    const height = 100;
    const fixture = await sharp({
      create: { width, height, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const result = await processProof(fixture);

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    await assertHasWatermarkInk(result, BACKGROUND);
  });

  it("processes concurrent calls correctly despite internal serialization", async () => {
    const landscape = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();
    const portrait = await sharp({
      create: { width: 1000, height: 2000, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const [landscapeResult, portraitResult] = await Promise.all([
      processProof(landscape),
      processProof(portrait),
    ]);

    expect(landscapeResult.width).toBe(PROOF_MAX_LONG_EDGE);
    expect(landscapeResult.height).toBeLessThan(landscapeResult.width);
    expect(portraitResult.height).toBe(PROOF_MAX_LONG_EDGE);
    expect(portraitResult.width).toBeLessThan(portraitResult.height);
  });

  // Regression coverage for a real bug found in review: the mutex's release
  // (`queue = result.then(() => undefined, () => undefined)`) must attach a
  // rejection handler, or a failed call leaves a rejected promise assigned
  // to `queue` with nothing (yet) handling it. A sequential
  // "reject-then-resolve" test alone can't catch a dropped rejection
  // handler here — `queue.then(fn, fn)` on the *next* call still runs `fn`
  // regardless of whether `queue` is fulfilled or rejected, so the next
  // call succeeds either way. What a dropped handler actually produces is
  // an `unhandledRejection` on the Node process itself, which is what this
  // test listens for directly (verified against the exact mutation the
  // reviewer described: it turns this test red while a plain
  // reject-then-resolve assertion stays green).
  it("does not leak an unhandled rejection when a queued call fails, and still serves the next call", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const garbage = Buffer.from("not an image, just garbage bytes");
      await expect(processProof(garbage)).rejects.toThrow();

      const validFixture = await sharp({
        create: { width: 400, height: 300, channels: 3, background: BACKGROUND },
      })
        .jpeg()
        .toBuffer();
      const result = await processProof(validFixture);
      expect(result.width).toBe(400);
      expect(result.height).toBe(300);

      // Give the event loop a couple of ticks so a genuinely unhandled
      // rejection has a chance to surface before we assert none did.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

describe("limitInputPixels guard", () => {
  it("rejects an image whose declared dimensions exceed the pixel limit, before decoding it", async () => {
    const tiny = await sharp({
      create: { width: 64, height: 64, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();
    // Declared 20000x20000 = 400,000,000 pixels, well above the guard.
    // The actual JPEG entropy data is still the real 64x64 image -- this
    // crafted header lets the guard prove itself without ever encoding or
    // decoding a real 400-megapixel image.
    const bomb = patchJpegDimensions(tiny, 20000, 20000);

    await expect(processProof(bomb)).rejects.toThrow(/exceeds pixel limit/i);
  });

  it("does not trip the pixel-limit guard for declared dimensions under the threshold", async () => {
    const tiny = await sharp({
      create: { width: 64, height: 64, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();
    // Declared 9000x9000 = 81,000,000 pixels, under the 100,000,000 guard.
    // The header/data mismatch still makes this an invalid JPEG (the real
    // entropy data is only 64x64), so processProof is expected to reject —
    // the point is pinning the boundary: it must not be the pixel-limit
    // guard doing the rejecting.
    const underLimit = patchJpegDimensions(tiny, 9000, 9000);

    // Not a try/catch: if `processProof` ever RESOLVED here, a catch block
    // would simply never run and the test would assert nothing at all.
    // Capturing the rejection makes the assertion unconditional.
    const error = await processProof(underLimit).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/exceeds pixel limit/i);
  });
});

describe("assertTileHasInk", () => {
  it("throws when the tile's alpha channel is fully transparent (the fontless-render failure mode)", async () => {
    // Simulates exactly what librsvg produces when no font is installed for
    // fontconfig/pango to render text with: a fully transparent raster,
    // rather than trying to reproduce a fontless environment in CI.
    const blankTile = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    await expect(assertTileHasInk(blankTile)).rejects.toThrow(/no visible ink/i);
  });

  it("does not throw for a tile that actually carries visible ink", async () => {
    const inkedTile = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 128 },
      },
    })
      .png()
      .toBuffer();

    await expect(assertTileHasInk(inkedTile)).resolves.toBeUndefined();
  });
});
