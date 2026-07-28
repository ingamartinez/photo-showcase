// Proof processing pipeline (PLAN.md §5): an uploaded original becomes a
// protected, web-sized proof. `processProof` is the ONLY export that produces
// bytes — there is deliberately no "resize only" or "watermark only" helper,
// so no caller can walk away with downscaled-but-unwatermarked bytes. If a
// future need (e.g. finals, which are full-res and unwatermarked per
// PLAN.md §5) requires a different pipeline, it gets its own function; it
// must never be built by composing pieces pulled out of this one.
//
// Memory story (this droplet's main pressure source — 2 GB shared with
// findash, `photoshowcase.service` caps at 768 MB):
// - `sharp.concurrency(1)` caps libvips' internal thread pool so a single
//   pipeline run doesn't fan out across cores and multiply peak memory.
// - `sharp.cache(false)` stops libvips from retaining decoded pixel data
//   across calls; this process handles unique images once each, so the
//   cache would only cost memory, never save time.
// - `runExclusive` below serializes calls to `processProof` process-wide, so
//   even if a future caller (e.g. a multi-file upload route) fires several
//   calls without awaiting between them, only one full-size decode is ever
//   resident at a time.
// - `resize()` is called with explicit dimensions before any pixel op, which
//   lets libvips shrink-on-load JPEGs (decode at a reduced resolution
//   instead of full-size then downscale) — the single biggest win for peak
//   memory on a big camera JPEG.
// - `limitInputPixels` rejects anything above ~100 megapixels before it is
//   decoded at all, so a hostile or mis-exported huge image can't be used to
//   exhaust memory.
// - The resize step is decoded to a raw pixel buffer (not re-encoded to a
//   compressed format) before the watermark is composited on top of it. That
//   intermediate buffer is already capped at PROOF_MAX_LONG_EDGE, so it stays
//   small; the point is to read back its real width/height (see the pixel
//   guard note on `buildWatermarkTile` below) without paying for a second
//   lossy encode/decode round trip.
import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);

/** Longest edge of a processed proof, in pixels (PLAN.md §5: "~1600px"). */
export const PROOF_MAX_LONG_EDGE = 1600;

/** The watermark's exact text (owner decision, 2026-07-28 — see task #14's
 * second note). Lowercase, no domain suffix, no logo: the photographer has
 * no brand asset and does not want one invented. This is the real
 * watermark, not a placeholder. */
export const WATERMARK_TEXT = "alejoframes";

// Guards against a hostile or mis-exported huge upload consuming the
// droplet's memory before we even get to resize it. ~100 megapixels covers
// every real camera (full-frame mirrorless tops out well under this) with
// room to spare, while keeping a worst-case raw decode (a format libvips
// can't shrink-on-load, e.g. PNG, at 4 bytes/pixel) around ~400 MB — painful
// but survivable under the 768 MB service cap, and rejected outright above
// this line.
const MAX_INPUT_PIXELS = 100_000_000;

// Output quality for the WebP proof. 82 is a standard "visually lossless
// enough for a low-res proof, meaningfully smaller than 90+" webp setting —
// proofs exist for the client to pick photos, not as deliverables, so file
// size matters more than perfect fidelity here.
const WEBP_QUALITY = 82;

// The watermark is a single SVG tile, rasterized once per call and then
// repeated across the whole canvas via sharp's `tile: true` composite
// option. Tiling (rather than one mark in a corner) is deliberate: it is
// far harder to crop out without destroying the photo, and it survives
// screenshots/crops of any region.
const WATERMARK_TILE_WIDTH = 320;
const WATERMARK_TILE_HEIGHT = 160;
const WATERMARK_ROTATION_DEG = -28;
const WATERMARK_FONT_SIZE = 30;

// The watermark's ink assay: sharp/librsvg render this SVG through
// fontconfig/pango, and sharp bundles that text stack but ships NO font
// files — on Linux it resolves fonts from the HOST'S fontconfig. If the
// droplet has no font package installed, librsvg silently rasterizes fully
// transparent glyphs: `composite()` still succeeds, producing valid WebP
// bytes with zero ink and no exception. That is exactly the "stored proof
// with no watermark" outcome this task exists to prevent, so it cannot be
// left to fail silently. `assertTileHasInk` makes it a loud, thrown error
// instead. Exported (not used outside this module) so it can be exercised
// directly with a synthetic blank tile in tests, without needing to
// reproduce a fontless environment.
//
// Server prerequisite: the droplet must have a font package installed for
// fontconfig to resolve (e.g. `fonts-dejavu-core` on Debian/Ubuntu) — see
// infra/README.md.
export async function assertTileHasInk(tile: Buffer): Promise<void> {
  const stats = await sharp(tile).stats();
  const alphaChannel = stats.channels[stats.channels.length - 1];
  if (stats.channels.length === 4 && alphaChannel.max === 0) {
    throw new Error(
      "Watermark tile rendered with no visible ink (alpha channel is fully " +
        "transparent). This almost always means no font is installed for " +
        "librsvg/pango/fontconfig to render text with — see infra/README.md " +
        "for the fonts-dejavu-core server prerequisite. Refusing to produce " +
        "an unwatermarked proof.",
    );
  }
}

/** Builds the watermark tile as a rasterized PNG buffer, sized exactly
 * `tileWidth x tileHeight` regardless of how the SVG renderer interprets
 * density/units (the trailing `.resize()` forces the pixel size so tiling
 * math never depends on that assumption). White fill over a black stroke
 * (`paint-order="stroke"` draws the stroke first) keeps the text legible
 * over both light and dark frames; both are kept at moderate opacity so the
 * mark reads as a watermark, not a censor bar.
 *
 * `tileWidth`/`tileHeight` default to the design size but can be smaller —
 * `processProof` clamps them to the output canvas, since sharp's
 * `composite({ tile: true })` requires the overlay to fit within the canvas
 * on both axes (see the pixel-guard note at the call site). */
async function buildWatermarkTile(
  tileWidth: number = WATERMARK_TILE_WIDTH,
  tileHeight: number = WATERMARK_TILE_HEIGHT,
): Promise<Buffer> {
  const cx = tileWidth / 2;
  const cy = tileHeight / 2;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${tileHeight}">
      <text
        x="${cx}"
        y="${cy}"
        transform="rotate(${WATERMARK_ROTATION_DEG} ${cx} ${cy})"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="sans-serif"
        font-weight="bold"
        font-size="${WATERMARK_FONT_SIZE}"
        fill="#ffffff"
        fill-opacity="0.35"
        stroke="#000000"
        stroke-opacity="0.30"
        stroke-width="1.5"
        paint-order="stroke"
      >${WATERMARK_TEXT}</text>
    </svg>
  `;

  const tile = await sharp(Buffer.from(svg)).resize(tileWidth, tileHeight).png().toBuffer();

  await assertTileHasInk(tile);

  return tile;
}

export type ProcessedProof = {
  data: Buffer;
  width: number;
  height: number;
};

// Serializes calls to `processProof` across the whole process. Not a
// per-call optimization — it exists so this module never has more than one
// full-size decode resident at once, no matter how a future caller (a
// multi-file upload route, say) invokes it. See the memory story above.
let queue: Promise<void> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Turns an original image into a protected, web-sized proof: downscaled to
 * a max long edge of `PROOF_MAX_LONG_EDGE`, watermarked, EXIF-stripped,
 * WebP. This is the only function in this module that returns image bytes —
 * see the file header for why there is no lower-level "resize only" export.
 *
 * `width`/`height` are read back from the actual output bytes (not computed
 * from the input's metadata), so they can never drift from what a client
 * decoding the stored proof will actually see — which is exactly what
 * `assets.proof_width` / `proof_height` need to be trustworthy for. */
export async function processProof(
  input: Buffer | ArrayBuffer | Uint8Array,
): Promise<ProcessedProof> {
  return runExclusive(async () => {
    const source = Buffer.isBuffer(input)
      ? input
      : input instanceof ArrayBuffer
        ? Buffer.from(input)
        : Buffer.from(input.buffer, input.byteOffset, input.byteLength);

    // Decode + rotate + resize first, to a raw pixel buffer, so the actual
    // output canvas size is known before the watermark tile is built.
    // `composite({ tile: true })` requires the overlay to fit within the
    // canvas on both axes — an ordinary portrait or small crop (not an
    // exotic input; `withoutEnlargement` deliberately supports images
    // smaller than PROOF_MAX_LONG_EDGE) can be narrower than
    // WATERMARK_TILE_WIDTH or shorter than WATERMARK_TILE_HEIGHT, which
    // would otherwise make sharp throw an opaque libvips error.
    const { data: resized, info: resizedInfo } = await sharp(source, {
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      // Bakes the EXIF Orientation into the pixels before metadata is
      // stripped below — otherwise a viewer that (correctly) ignores
      // metadata-less orientation would render the proof sideways.
      .rotate()
      // "inside" + withoutEnlargement: the longer of width/height becomes
      // PROOF_MAX_LONG_EDGE, the other scales to match; images already
      // smaller are left at their original size, never upscaled.
      .resize(PROOF_MAX_LONG_EDGE, PROOF_MAX_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Clamp the tile to the canvas — never skip or shrink the guarantee
    // itself. A small image must still come out watermarked; the tile just
    // repeats at a smaller size instead of a fixed 320x160.
    const tileWidth = Math.min(WATERMARK_TILE_WIDTH, resizedInfo.width);
    const tileHeight = Math.min(WATERMARK_TILE_HEIGHT, resizedInfo.height);
    const watermarkTile = await buildWatermarkTile(tileWidth, tileHeight);

    const { data } = await sharp(resized, {
      raw: {
        width: resizedInfo.width,
        height: resizedInfo.height,
        channels: resizedInfo.channels,
      },
    })
      .composite([{ input: watermarkTile, tile: true, blend: "over" }])
      // No `.withMetadata()` call: sharp strips all metadata (EXIF, ICC,
      // XMP) by default. This is the EXIF-stripping step.
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    // Re-read the dimensions from the bytes we are about to return, rather
    // than trusting anything computed earlier in the pipeline.
    const output = await sharp(data).metadata();
    if (!output.width || !output.height) {
      throw new Error("Processed proof is missing dimensions");
    }

    return { data, width: output.width, height: output.height };
  });
}
