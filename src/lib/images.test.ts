import { describe, expect, it } from "vitest";
import sharp from "sharp";
import * as imagesModule from "./images";
import {
  FINAL_EXIF_ARTIST,
  FINAL_EXIF_COPYRIGHT,
  PROOF_MAX_LONG_EDGE,
  assertTileHasInk,
  processDisplay,
  processProof,
} from "./images";
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

/** Deterministic PRNG (mulberry32). `Math.random()` has no place in a fixture
 * a test asserts size RATIOS against: the margin would differ run to run, and
 * a thin one would flake in CI on a schedule nobody could reproduce. Fixed
 * seed, so the numbers below are the same on every machine and every run. */
function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PHOTOGRAPHIC full-resolution fixture: low-frequency colour structure
 * (built small and upscaled by sharp, i.e. in C++ rather than in a JS loop)
 * with film-like grain composited over it.
 *
 * Why not per-pixel random noise, which is the obvious way to build a
 * "detailed" fixture and is what this test used first: noise is the
 * pathological worst case for any DCT/VP8 encoder — maximum entropy, nothing
 * to predict — and this suite used to run every fixture through the
 * now-deleted `processFinal` (task #218), which encoded with `mozjpeg: true`;
 * its trellis quantization then explored the whole search space. Measured on
 * the same machine, that one call took 1829ms of the test's 2521ms total, and
 * at ~5x on `ubuntu-latest` it blew the (then 5000ms) timeout and turned CI
 * red. This fixture is FASTER (~1650ms end to end vs ~2520ms), and it is not
 * a trade of rigour for speed — it is strictly the better measurement:
 *
 *   - It is what the assertion is actually about. At identical dimensions
 *     noise inflates page-weight figures ~2x over photographic content
 *     (final 2.66x, display 2.08x, proof 1.95x, all measured at 4000x2667
 *     with the same seed), so the ratios were being measured against
 *     content no client will ever upload.
 *   - It makes the assertion STRICTER, not looser. Holding dimensions
 *     fixed at 4000x2667, noise scores a 2.79x margin and photographic
 *     2.18x — the content change costs margin. The gain from 1.39x to
 *     2.18x comes entirely from the SIZE change (3000x2000 -> 4000x2667);
 *     photographic at the old 3000x2000 scores 1.35x, the same as the
 *     noise fixture it replaces. Both changes were needed and they pull
 *     in opposite directions.
 *
 * Sized at LARGE_WIDTH x LARGE_HEIGHT — the same ~4000x2667 the rest of this
 * file uses and the dimensions task #28 measured a real final at. That size
 * is load-bearing, not cosmetic: `processDisplay` caps at
 * PROOF_MAX_LONG_EDGE, so a source anywhere near that cap would barely
 * downscale and `display < final / 4` would stop proving anything. */
async function makePhotographicFixture(): Promise<Buffer> {
  const random = seededRandom(20260729);

  const smallWidth = 240;
  const smallHeight = Math.round((smallWidth * LARGE_HEIGHT) / LARGE_WIDTH);
  const seedField = Buffer.alloc(smallWidth * smallHeight * 3);
  for (let i = 0; i < seedField.length; i++) seedField[i] = Math.floor(random() * 256);

  const base = await sharp(seedField, {
    raw: { width: smallWidth, height: smallHeight, channels: 3 },
  })
    .resize(LARGE_WIDTH, LARGE_HEIGHT, { kernel: "cubic" })
    .blur(4)
    .raw()
    .toBuffer();

  // Grain over the smooth base: a real photo has high-frequency detail, and
  // without it this would compress like a gradient and understate every size.
  const grain = Buffer.alloc(LARGE_WIDTH * LARGE_HEIGHT * 3);
  for (let i = 0; i < grain.length; i++) grain[i] = 110 + Math.floor(random() * 36);

  return sharp(base, { raw: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3 } })
    .composite([
      {
        input: grain,
        raw: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3 },
        blend: "overlay",
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Counts how many sampled pixels differ from `background` — the same ink
 * assay `assertHasWatermarkInk` above performs, extracted so task #89's
 * display tests can assert BOTH directions with one instrument. Sampling
 * every 8th pixel across a 6x6 grid of cells is exactly the existing tests'
 * stride; a return of 0 means nothing painted onto a flat frame, a positive
 * return means something did. */
async function countInkedSamples(
  bytes: Buffer,
  background: { r: number; g: number; b: number },
): Promise<number> {
  const { data: raw, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const threshold = 10;
  const gridSize = 6;
  const cellWidth = Math.floor(width / gridSize);
  const cellHeight = Math.floor(height / gridSize);
  let inked = 0;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      for (let sy = 0; sy < cellHeight; sy += 8) {
        for (let sx = 0; sx < cellWidth; sx += 8) {
          const offset = ((row * cellHeight + sy) * width + (col * cellWidth + sx)) * channels;
          if (
            Math.abs(raw[offset] - background.r) > threshold ||
            Math.abs(raw[offset + 1] - background.g) > threshold ||
            Math.abs(raw[offset + 2] - background.b) > threshold
          ) {
            inked++;
          }
        }
      }
    }
  }

  return inked;
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
    // down the exact tile phase against the grid. The ratio was lowered from
    // 0.6 to 0.45 for task #201 (owner decision, 2026-08-01), and the drop
    // has TWO causes, not one — attributing it to tile size alone
    // understates what this assay is actually sensitive to:
    //   - Mostly the tile size: growing it from 320x160 to 640x320 means far
    //     fewer repetitions across a ~1600px-long-edge proof canvas, which
    //     alone (holding opacity at its ORIGINAL 0.35/0.30) drops coverage
    //     from 36/36 to 22/36. This is the dominant effect.
    //   - Also the opacity drop: going from 0.35/0.30 down to this task's
    //     shipped 0.16/0.12 costs 3 more cells on top of that (22/36 ->
    //     19/36). White fill at 0.16 composited over this fixture's 180-gray
    //     background lands around 192 — a difference of ~12, just over this
    //     assay's own +/-10 threshold — so some sampled pixels near a tile's
    //     fainter edges now fall under it. That is a GOOD property of this
    //     assay, not a weakness to gloss over: it is exactly what would
    //     catch a future opacity drop that crosses the threshold outright.
    // Measured directly against the current fixture/tile/opacity: 19/36
    // cells (~0.53). 0.45 keeps a real margin below that measured value
    // rather than pinning to it exactly, while still failing loudly if a
    // future change collapses coverage back down toward one corner.
    expect(cellsWithInk).toBeGreaterThanOrEqual(Math.ceil(gridSize * gridSize * 0.45));
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
  // Before the fix, any image narrower than the watermark tile's width or
  // shorter than its height made processProof throw an opaque libvips error
  // — including an ordinary 300x400 portrait crop, not an exotic input. That
  // bug was originally found when the tile was 320x160 (its size at the
  // time): the "does not upscale..." case above (400x300) sat just above
  // the threshold on both axes at that size (400>320, 300>160), which is
  // why a narrower case was needed to catch the bug at all.
  //
  // Task #201 (2026-07-31/08-01) grew the tile well past that point. At the
  // CURRENT 640x320, the 400x300 case above ALSO falls under the tile on
  // both axes now (400<640, 300<320) — not a bug, `Math.min`'s per-axis
  // clamp does not care how far under the threshold a dimension is, but it
  // does mean that case no longer demonstrates "tile fits, no clamp" the
  // way this comment used to say it did. The 300x400 and 100x100 cases
  // below are what actually pin the single-axis and both-axes clamp paths
  // at the current tile size.
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

// Fixtures below carry BOTH an EXIF Copyright marker AND a GPS-shaped tag —
// used directly as `processDisplay` INPUT now (task #218 deleted
// `processFinal`; a stored final is the raw upload, so `processDisplay`'s own
// real input is exactly this kind of fixture, not a pre-filtered
// intermediate). The GPS-shaped marker specifically proves the allowlist, not
// just "some EXIF is gone": task #26's whole reason to choose an allowlist
// over a blocklist is that location leaks through more than a hand-picked
// "strip GPS" rule would catch (see images.ts's own comment on
// `processDisplay`, now the only function in the module that applies this
// allowlist). If GPS survived while Copyright/Artist were merely OVERWRITTEN
// with the app's own values, a test that only checked for the app's own
// constants being present could still pass with a location leak sitting
// right next to them.
// A free-text field, not a structured GPS tag: sharp's `Exif` type only
// covers IFD0-IFD3, with no separate GPS-IFD support, so a raw
// `GPSLatitude` string round-trips unreliably through `withExif()`. An
// `ImageDescription` carrying a plain-text location is a REALISTIC stand-in
// for the same risk task #26 calls out — some cameras/editing software do
// write free-text descriptions, and this is exactly the kind of field a
// blocklist that only special-cased "the GPS IFD" would still let through.
const LOCATION_LEAK_MARKER = "Shot at 123 Main St, Client Hometown";
const ORIGINAL_COPYRIGHT_MARKER = "Some Other Photographer Studio";

/** A fixture shaped like what an admin actually uploads for a final (task
 * #218: raw camera/Lightroom bytes, untouched — there is no `processFinal`
 * step to run this through any more). Carries a third-party copyright marker
 * and a location leak so `processDisplay` tests below can prove it strips
 * both, not merely that its own constants appear. */
async function makeLargeFinalFixture(): Promise<Buffer> {
  return sharp({
    create: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3, background: BACKGROUND },
  })
    .jpeg()
    .withExif({
      IFD0: { Copyright: ORIGINAL_COPYRIGHT_MARKER, ImageDescription: LOCATION_LEAK_MARKER },
    })
    .withIccProfile("srgb")
    .toBuffer();
}

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

  // Shared guard: `MAX_INPUT_PIXELS` in images.ts is deliberately declared
  // once and reused by both pipelines (see its own comment) — this is the
  // proof that `processDisplay` actually inherits it too, not just
  // `processProof`.
  it("rejects the same pixel bomb via processDisplay, not just processProof", async () => {
    const tiny = await sharp({
      create: { width: 64, height: 64, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();
    const bomb = patchJpegDimensions(tiny, 20000, 20000);

    await expect(processDisplay(bomb)).rejects.toThrow(/exceeds pixel limit/i);
  });
});

// Task #89's second pipeline: the browsing-sized, UNWATERMARKED derivative a
// delivered gallery shows. Fixtures here are fed directly to `processDisplay`
// — task #218 deleted `processFinal`, so a stored final's own bytes ARE the
// raw upload, and that is exactly what the route now hands this function.
describe("processDisplay", () => {
  it("downscales a full-resolution final to the display cap and outputs WebP", async () => {
    const result = await processDisplay(await makeLargeFinalFixture());

    const outputMeta = await sharp(result.data).metadata();
    expect(outputMeta.format).toBe("webp");
    expect(Math.max(outputMeta.width!, outputMeta.height!)).toBeLessThanOrEqual(
      PROOF_MAX_LONG_EDGE,
    );
    // The fixture is landscape and far above the cap, so the long edge lands
    // exactly ON it, not merely under it — this is what would break if the
    // resize were ever dropped and the full-resolution final served instead
    // (the exact mistake task #89 exists to avoid).
    expect(outputMeta.width).toBe(PROOF_MAX_LONG_EDGE);
    expect(outputMeta.width).toBeLessThan(LARGE_WIDTH);

    // Reported dimensions must match the actual bytes — re-decoded
    // independently, same discipline as processProof's own accounting test.
    expect(result.width).toBe(outputMeta.width);
    expect(result.height).toBe(outputMeta.height);
  });

  // THE acceptance criterion, asserted the way #14 and #26 assert theirs: on
  // the real output pixels, not on the absence of a `composite()` call. A
  // flat-background final must come out flat — any pixel that differs from
  // the background is ink something painted onto it, and the only thing in
  // this module that paints is the watermark.
  it("paints NO watermark ink — the output pixels match the flat background it started from", async () => {
    const flatFixture = await sharp({
      create: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const result = await processDisplay(flatFixture);

    expect(await countInkedSamples(result.data, BACKGROUND)).toBe(0);
  });

  // The inverse control for the test above: it must be capable of DETECTING
  // ink at this size and quality setting, or "0 inked samples" would be
  // evidence of nothing. Same fixture dimensions, same WebP quality, run
  // through `processProof` instead — that one does composite the mark, and
  // the assay finds it.
  it("and the same assay DOES find ink when the very same picture goes through processProof", async () => {
    const watermarked = await processProof(
      await sharp({
        create: { width: LARGE_WIDTH, height: LARGE_HEIGHT, channels: 3, background: BACKGROUND },
      })
        .jpeg()
        .toBuffer(),
    );

    expect(await countInkedSamples(watermarked.data, BACKGROUND)).toBeGreaterThan(0);
  });

  // TASK #218's own invariant, pinned directly at this function: with
  // `processFinal` gone, `processDisplay` is the ONLY place left that strips
  // metadata from a final-shaped image, so this has to be tested against a
  // RAW, unfiltered fixture (third-party copyright AND a location leak, both
  // still present going in) rather than a pre-filtered one — feeding it an
  // already-clean fixture (the old shape of this test) could no longer tell
  // "processDisplay stripped this" apart from "it was never there".
  it("strips the raw upload's own EXIF down to the authorship allowlist, drops the location leak, and keeps the ICC profile", async () => {
    const fixture = await makeLargeFinalFixture();
    // Sanity-check the fixture itself: it really carries a third-party
    // marker and a location leak, so proving them gone below proves
    // something instead of restating an already-clean input.
    expect(fixture.includes(ORIGINAL_COPYRIGHT_MARKER)).toBe(true);
    expect(fixture.includes(LOCATION_LEAK_MARKER)).toBe(true);

    const result = await processDisplay(fixture);

    const outputMeta = await sharp(result.data).metadata();
    expect(outputMeta.exif).toBeDefined();
    expect(outputMeta.icc).toBeDefined();
    expect(result.data.includes(FINAL_EXIF_COPYRIGHT)).toBe(true);
    expect(result.data.includes(FINAL_EXIF_ARTIST)).toBe(true);

    // The requirement task #218 exists to protect: these bytes are
    // unwatermarked and sit in an <img> a phone can long-press and save, so
    // this is what keeps the delivered gallery's GRID free of GPS even
    // though the downloadable FINAL, as of this task, is not.
    expect(result.data.includes(LOCATION_LEAK_MARKER)).toBe(false);
    expect(result.data.includes(ORIGINAL_COPYRIGHT_MARKER)).toBe(false);
  });

  it("does not upscale a final that is already smaller than the display cap", async () => {
    const small = await sharp({
      create: { width: 400, height: 300, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const result = await processDisplay(small);

    expect(result.width).toBe(400);
    expect(result.height).toBe(300);
  });

  // The page weight claim task #89 asks to be stated with a number: a
  // display derivative must be in the PROOF's size class, not a
  // full-resolution final's. Asserted as a ratio rather than an absolute
  // byte count so it stays meaningful if sharp's encoder output shifts
  // between versions. `final` below is the RAW fixture bytes themselves
  // (task #218: that is what a stored final actually is now, byte-for-byte).
  it("produces bytes in the proof's size class, not the full-resolution final's", async () => {
    const original = await makePhotographicFixture();

    const display = await processDisplay(original);
    const proof = await processProof(original);

    expect(display.data.length).toBeLessThan(original.length / 4);
    expect(display.data.length).toBeLessThan(proof.data.length * 3);
  });

  it("does not leak an unhandled rejection when a queued call fails, and still serves the next call", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const garbage = Buffer.from("not an image, just garbage bytes");
      await expect(processDisplay(garbage)).rejects.toThrow();

      const validFixture = await sharp({
        create: { width: 400, height: 300, channels: 3, background: BACKGROUND },
      })
        .jpeg()
        .toBuffer();
      const result = await processDisplay(validFixture);
      expect(result.width).toBe(400);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  // The shared mutex is what keeps concurrent requests' sharp passes from
  // ever being resident in memory at the same time, under the same 768 MB
  // cap. `runExclusive` is module-private, so this proves membership
  // behaviourally: interleave calls to both pipelines and check every one
  // still returns its own correct answer, which a broken queue (shared state
  // leaking between calls) would not.
  it("shares the process-wide mutex with processProof", async () => {
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

    const [proof, displayA, displayB] = await Promise.all([
      processProof(landscape),
      processDisplay(landscape),
      processDisplay(portrait),
    ]);

    expect(proof.width).toBe(PROOF_MAX_LONG_EDGE);
    expect(displayA.width).toBe(PROOF_MAX_LONG_EDGE);
    expect(displayA.height).toBe(800);
    expect(displayB.height).toBe(PROOF_MAX_LONG_EDGE);
    expect(displayB.width).toBe(800);
  });
});

// Task #89's second acceptance criterion, stated as a standing guarantee
// rather than a one-off review note: "processProof is unchanged and still
// cannot emit unwatermarked bytes. Prove it."
//
// The behavioural half of that proof is the existing watermark-ink tests
// above — remove `.composite()` and they go red. What those tests CANNOT
// catch is the specific regression task #89 warns about: someone adding an
// OPTION to `processProof` so a caller can ask it to skip the mark. The
// ink tests would keep passing, because they never pass such an option. The
// three tests here close exactly that gap.
describe("processProof's no-unwatermarked-bytes guarantee (task #89)", () => {
  // `Function.length` counts declared parameters before the first default or
  // rest. Adding an `options` parameter — the exact temptation task #89 and
  // task #26 both forbid — makes this 2 and turns this test red on the same
  // commit that introduces it.
  it("takes exactly one parameter, so there is no options object to smuggle a bypass through", () => {
    expect(processProof.length).toBe(1);
  });

  // Belt to that braces, from the caller's side: even handed the shapes a
  // bypass would most plausibly take, it watermarks anyway. This is what
  // stays true no matter how the signature is written.
  it("still watermarks when called with an extra argument shaped like a bypass", async () => {
    const fixture = await sharp({
      create: { width: 800, height: 600, channels: 3, background: BACKGROUND },
    })
      .jpeg()
      .toBuffer();

    const asIfOptions = processProof as unknown as (
      input: Buffer,
      options?: unknown,
    ) => Promise<ProcessedProof>;

    for (const bypass of [{ watermark: false }, { skipWatermark: true }, false]) {
      const result = await asIfOptions(fixture, bypass);
      await assertHasWatermarkInk(result, BACKGROUND);
    }
  });

  // The module's exported SURFACE is itself part of the guarantee (#14's
  // review called this out: no default export, no `sharp` re-export,
  // `buildWatermarkTile` module-private). Pinning it to an exact list means
  // any new export — including a "just a small resize helper" someone adds
  // for convenience — cannot land without a deliberate edit here, which is
  // the moment to ask whether it hands out downscaled-unwatermarked PROOF
  // bytes.
  it("exports exactly the known surface — a new byte-emitting helper cannot appear unnoticed", () => {
    expect(Object.keys(imagesModule).sort()).toEqual([
      "FINAL_EXIF_ARTIST",
      "FINAL_EXIF_COPYRIGHT",
      "PROOF_MAX_LONG_EDGE",
      "WATERMARK_TEXT",
      "assertTileHasInk",
      "processDisplay",
      "processProof",
    ]);
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
