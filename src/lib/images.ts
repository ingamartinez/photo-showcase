// Proof processing pipeline (PLAN.md §5): an uploaded original becomes a
// protected, web-sized proof. `processProof` is the ONLY export that produces
// PROOF bytes — there is deliberately no "resize only" or "watermark only"
// helper, so no caller can walk away with downscaled-but-unwatermarked bytes.
// Finals (full-res, unwatermarked, PLAN.md §5) are exactly the "different
// pipeline" this file anticipated: `processFinal` below is that pipeline's
// own function, built from scratch rather than by pulling pieces out of
// `processProof` — see its own section header further down for the full
// reasoning and task #26's EXIF-allowlist decision.
//
// A THIRD pipeline lives at the bottom of this file: `processDisplay` (task
// #89), the browsing-sized version of a FINAL. Read its section header
// before assuming it violates the paragraph above — the short version is
// that the prohibition protects PROOFS (pre-payment, the photographer's
// leverage), and `processDisplay`'s input is a final, an artifact that only
// exists after the commercial event. `processProof` is untouched by it: it
// does not call `processDisplay`, `processDisplay` does not call it, and
// neither grew an option to skip anything.
//
// Memory story (this droplet's main pressure source — 2 GB shared with
// findash, `photoshowcase.service` caps at 768 MB). Applies to BOTH pipelines
// in this file unless a bullet says otherwise:
// - `sharp.concurrency(1)` caps libvips' internal thread pool so a single
//   pipeline run doesn't fan out across cores and multiply peak memory.
// - `sharp.cache(false)` stops libvips from retaining decoded pixel data
//   across calls; this process handles unique images once each, so the
//   cache would only cost memory, never save time.
// - `runExclusive` below serializes calls to `processProof`, `processFinal`
//   AND `processDisplay` process-wide (one shared queue), so even if a future
//   caller (e.g. a multi-file upload route) fires several calls without
//   awaiting between them, only one full-size decode is ever resident at a
//   time. This is what keeps the final-upload route's now-TWO sharp passes
//   (`processFinal` then `processDisplay`, task #89) additive-in-sequence
//   rather than additive-in-peak: the two never overlap, not even with
//   another request's own pass.
// - `resize()` is called with explicit dimensions before any pixel op, which
//   lets libvips shrink-on-load JPEGs (decode at a reduced resolution
//   instead of full-size then downscale) — the single biggest win for peak
//   memory on a big camera JPEG. PROOF-ONLY: `processFinal` never resizes
//   (full resolution IS the product), so it cannot use this trick and
//   decodes the whole frame every time — see its own comment for why that
//   makes the shared mutex matter even more for finals.
// - `limitInputPixels` rejects anything above ~100 megapixels before it is
//   decoded at all, so a hostile or mis-exported huge image can't be used to
//   exhaust memory.
// - The resize step is decoded to a raw pixel buffer (not re-encoded to a
//   compressed format) before the watermark is composited on top of it. That
//   intermediate buffer is already capped at PROOF_MAX_LONG_EDGE, so it stays
//   small; the point is to read back its real width/height (see the pixel
//   guard note on `buildWatermarkTile` below) without paying for a second
//   lossy encode/decode round trip. PROOF-ONLY: `processFinal` has no
//   watermark step at all.
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
//
// Shared by `processFinal` below, not re-declared: the guard's reasoning
// (real cameras stay well under this, a hostile input doesn't get decoded at
// all) applies identically to a finished export as to an unedited original —
// only the pipeline AFTER this guard differs between the two.
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
const WATERMARK_TILE_WIDTH = 480;
const WATERMARK_TILE_HEIGHT = 240;
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
 * over both light and dark frames.
 *
 * Full decision trail, task #201 (real client complaints that the proof
 * watermark was too invasive) — two rounds of owner decisions, both dated
 * 2026-07-31:
 *
 * Round 1 (opacity — CURRENT, unchanged since): `fill-opacity` and
 * `stroke-opacity` were both turned down further than the task's own body
 * proposed, and the stroke was kept proportionally fainter than the fill
 * rather than dropped — a black outline at close-to-fill opacity reads as a
 * dirty border, not a lighter mark, so the two had to move together and the
 * stroke had to move further. These are not "moderate" values by design;
 * they are deliberately subdued. Do not lower them again without another
 * explicit owner decision — the mark is the photographer's pre-payment
 * leverage, and subtle is not the same request as invisible.
 *
 * Round 2 (tile size — CURRENT): after round 1 shipped, the owner was shown
 * three density options rendered against a real light-background sample —
 * not estimated, actually looked at — and chose the densest of the three
 * that still fit at 3 marks in the reference crop. 560x280 (round 1's tile
 * size) produced only 2 marks in that crop; 520x260 was tried and still
 * produced 2; 480x240 was the first size that produced 3, so that is what
 * shipped. Over a full 1400x933 photo this raises the mark count from ~8 to
 * ~11. If tile size is revisited again, treat "how many marks appear in a
 * rendered sample" as the thing that was actually decided, not the pixel
 * numbers themselves — the numbers are a byproduct of that visual count at
 * this specific font size/rotation, not an independently chosen quantity.
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
        fill-opacity="0.16"
        stroke="#000000"
        stroke-opacity="0.12"
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

// Serializes calls to `processProof` AND `processFinal` across the whole
// process — one shared queue, not one per function. Not a per-call
// optimization — it exists so this module never has more than one full-size
// decode resident at once, no matter how a future caller (a multi-file
// upload route, say) invokes it, and no matter which of the two pipelines it
// calls. This matters at least as much for finals as for proofs: finals are
// larger to begin with (task #26) and `processFinal` skips the one thing
// that shrinks `processProof`'s memory the most — resizing before any pixel
// op — so two finals decoding concurrently would be the worst case this
// mutex exists to prevent. See the memory story above.
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

// ---------------------------------------------------------------------------
// Final processing pipeline (task #26, PLAN.md §5's "Final upload" section):
// turns an admin-uploaded, ALREADY-EDITED full-resolution export (Lightroom
// or similar, finished locally by the photographer) into the stored
// deliverable. This is a DIFFERENT pipeline from `processProof` above, not a
// variant of it built by pulling pieces out of that one — see this file's
// header comment for why `processProof` must never grow a flag to skip its
// watermark. `processFinal` is the only function that can ever emit final
// bytes, the same "one function, one guarantee" shape as `processProof`: a
// caller has no lower-level export to compose around either guarantee.
//
// What this pipeline deliberately does NOT do:
//   - No resize. Full resolution IS the product (PLAN.md §5) — finals are
//     the finished, edited export the client paid for, not a derivative sized
//     for browsing. This also means it CANNOT benefit from `processProof`'s
//     shrink-on-load trick (resizing before any pixel op, decoding straight
//     to a smaller raster) — the full frame is always decoded. That is
//     exactly why finals need the shared mutex above more than proofs do,
//     not less.
//   - No watermark. These are the paid deliverables, not a selection aid.
//
// EXIF policy — allowlist, not blocklist (owner decision, 2026-07-28, task
// #26's third appended note, closing the open question in its body):
// `sharp` strips every EXIF/XMP/IPTC field by default, same as
// `processProof` above (see its own "no `.withMetadata()` call" comment) —
// `withExif()` below then re-adds ONLY the two authorship tags named here,
// nothing else. A blocklist ("strip the GPS tags") only covers what you
// anticipated: location leaks through more than the GPS IFD alone (XMP
// location fields, IPTC, whatever else the editing software wrote), and an
// allowlist cannot leak a field it never copied in the first place. This
// risk is bigger here than for proofs: finals are downloaded and forwarded
// on by the client, and a session photo routinely carries the GPS
// coordinates of wherever it was shot — often a client's own home.
//
// `Copyright`/`Artist` are CONSTANTS, never read from the uploaded file and
// never made per-gallery configuration — the photographer is always the same
// person (same "no invented brand asset" stance as `WATERMARK_TEXT` above;
// reusing that exact string here rather than inventing a second one).
// Deliberately NOT preserved this round: camera/lens/aperture/ISO/shutter
// (the capture data) — the owner chose authorship-only for now. Additive
// later: reading those fields from the upload and copying them across needs
// no migration and touches no already-delivered file.
//
// `keepIccProfile()` is a SEPARATE call, not folded into the EXIF decision
// above: the ICC profile is colour fidelity, not metadata, and colour
// fidelity is part of what the client paid for.
// Plain ASCII, deliberately — the EXIF `Copyright`/`Artist` tags are typed
// ASCII by the TIFF/EXIF spec, and libvips' own EXIF writer transliterates a
// "©" character down to "(C)" on write rather than preserving it (verified
// directly against the actual output bytes, not assumed). Writing plain
// ASCII here means the stored value is exactly this string, not a
// silently-rewritten one a future reader would have to know to expect.
export const FINAL_EXIF_ARTIST = WATERMARK_TEXT;
export const FINAL_EXIF_COPYRIGHT = `Copyright ${WATERMARK_TEXT}`;

// A full re-encode is unavoidable here — writing the EXIF allowlist and
// keeping the ICC profile both happen at encode time, so there is no
// "pass the bytes through untouched" option once even one metadata field
// changes. 92 with `mozjpeg: true` is "optimised" (PLAN.md §5's own word for
// this step): visually indistinguishable from a high-quality Lightroom
// export at 100, while mozjpeg's encoder produces a meaningfully smaller
// file than libjpeg-turbo's default would at the same quality, for zero
// additional pixel loss.
const FINAL_JPEG_QUALITY = 92;

export type ProcessedFinal = {
  data: Buffer;
};

/** Turns an admin-uploaded, already-edited full-resolution export into the
 * stored final: EXIF stripped down to the authorship allowlist above, ICC
 * profile kept, re-encoded as JPEG. No resize, no watermark — see the
 * section header above for why. Shares `processProof`'s process-wide mutex
 * (`runExclusive`) rather than getting its own: see the queue's own comment
 * for why serializing matters at least as much here. */
export async function processFinal(
  input: Buffer | ArrayBuffer | Uint8Array,
): Promise<ProcessedFinal> {
  return runExclusive(async () => {
    const source = Buffer.isBuffer(input)
      ? input
      : input instanceof ArrayBuffer
        ? Buffer.from(input)
        : Buffer.from(input.buffer, input.byteOffset, input.byteLength);

    const data = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
      // Bakes any EXIF Orientation into the pixels before metadata is
      // stripped below — same reasoning as `processProof`'s own `.rotate()`
      // call above: once the Orientation tag itself is gone (it is not on
      // the allowlist), a viewer that correctly ignores metadata-less
      // orientation must still see the photo upright.
      .rotate()
      .withExif({ IFD0: { Copyright: FINAL_EXIF_COPYRIGHT, Artist: FINAL_EXIF_ARTIST } })
      .keepIccProfile()
      .jpeg({ quality: FINAL_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    return { data };
  });
}

// ---------------------------------------------------------------------------
// Display processing pipeline (task #89): the browsing-sized version of a
// FINAL. A client who has paid and received their gallery should stop seeing
// the watermark in the grid and the lightbox — not only in the file they
// download.
//
// WHY THIS IS NOT THE THING THIS FILE'S HEADER FORBIDS. That header says
// there is deliberately no "resize only" helper "so no caller can walk away
// with downscaled-but-unwatermarked bytes", and this function is, literally,
// downscale-without-watermark. The distinction is the INPUT, and it is the
// same one task #26 drew for `processFinal`:
//   - The prohibition protects PROOFS. A proof is what a client browses
//     BEFORE paying and BEFORE selecting; the watermark is the photographer's
//     leverage over exactly those bytes, and the guarantee that protects it
//     is that `processProof` — the only function that produces proof-shaped
//     bytes — cannot be talked out of compositing the mark. That is still
//     true: `processProof` is untouched by this section, has no options
//     parameter to pass a `watermark: false` through, does not call anything
//     below, and is not called by anything below.
//   - `processDisplay`'s input is a FINAL: an artifact that only exists
//     because the photographer uploaded an edited export for an asset the
//     client had already selected. The commercial event has happened. There
//     is nothing left to protect with a watermark on that photo, which is why
//     `processFinal` (unwatermarked, full-res) was allowed to exist at all —
//     this is the same artifact at browsing size, not a new class of bytes.
//   - It is a THIRD named pipeline, not a primitive the other two are
//     composed from. Deleting it would not change one line of `processProof`
//     or `processFinal`. #26 faced this same temptation ("just add a flag to
//     processProof") and correctly wrote a separate path; this follows that
//     precedent rather than reopening it.
// The gate that actually keeps these bytes away from an unpaid client is not
// in this module at all — it is the same gate the download uses (gallery
// `delivered`, asset selected AND edited, session owns the gallery), shared
// through src/lib/final-access.ts so the display route and the download route
// cannot drift apart. See that module and GET
// /api/assets/[assetId]/display/route.ts.
//
// Sizing: the SAME cap as a proof (`PROOF_MAX_LONG_EDGE`, reused rather than
// re-declared with a different name and an identical value). The watermark
// was the problem; the proof's dimensions never were. Serving `finalKey`
// itself in the grid would put ~4000x2667 multi-MB JPEGs on the phone where
// most clients open this — roughly 100 MB for a twenty-photo gallery. WebP at
// the same quality as a proof keeps a delivered gallery's page weight in the
// same class as the proofing view it replaces.
//
// Metadata: the same authorship allowlist and ICC handling as `processFinal`
// — deliberately reusing that decision's constants (`FINAL_EXIF_COPYRIGHT` /
// `FINAL_EXIF_ARTIST`) rather than inventing a second policy. These bytes are
// unwatermarked and sit in an <img> a phone can long-press and save, so they
// are the one place left where authorship is worth carrying; and since the
// input is a final that already went through that allowlist, this can never
// re-introduce a field the final itself had already dropped. sharp writes
// both an EXIF chunk and an ICC chunk into WebP (verified against the actual
// output bytes, not assumed).
const DISPLAY_WEBP_QUALITY = WEBP_QUALITY;

export type ProcessedDisplay = {
  data: Buffer;
  width: number;
  height: number;
};

/** Turns a FINAL's bytes into the browsing-sized, unwatermarked derivative a
 * delivered gallery shows in its grid and lightbox: downscaled to
 * `PROOF_MAX_LONG_EDGE`, WebP, authorship EXIF only, ICC kept. Read this
 * section's header before calling it with anything other than a final —
 * `processFinal`'s output (or the bytes already stored at `finalKey`) is the
 * only input this pipeline is for.
 *
 * `width`/`height` come back from the actual output bytes for the same
 * reason `processProof` re-reads its own: a caller must never have to trust
 * arithmetic done earlier in the pipeline. (Nothing persists them today —
 * the grid still reserves each tile from `assets.proof_width`/`proof_height`,
 * see the display route and the client gallery page for why that needs no
 * new column — but a caller that wants them should not have to re-decode.)
 *
 * Shares `processProof`/`processFinal`'s process-wide mutex (`runExclusive`)
 * rather than getting its own: the final-upload route calls `processFinal`
 * and then this, so without the shared queue those two passes could overlap
 * with a THIRD request's own pass under the same 768 MB cap. */
export async function processDisplay(
  input: Buffer | ArrayBuffer | Uint8Array,
): Promise<ProcessedDisplay> {
  return runExclusive(async () => {
    const source = Buffer.isBuffer(input)
      ? input
      : input instanceof ArrayBuffer
        ? Buffer.from(input)
        : Buffer.from(input.buffer, input.byteOffset, input.byteLength);

    const data = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
      // Same reasoning as both pipelines above. A stored final always comes
      // out of `processFinal` already baked upright, so this is a no-op on
      // that path — kept because it costs nothing and this function must not
      // silently depend on its caller having rotated first.
      .rotate()
      // Declared BEFORE any pixel op so libvips can shrink-on-load the JPEG
      // (decode straight to a reduced resolution instead of decoding the full
      // frame and then downscaling) — the same trick that keeps
      // `processProof` cheap, and the reason this second pass costs far less
      // than `processFinal`'s own full-frame decode. See the memory story at
      // the top of this file.
      .resize(PROOF_MAX_LONG_EDGE, PROOF_MAX_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .withExif({ IFD0: { Copyright: FINAL_EXIF_COPYRIGHT, Artist: FINAL_EXIF_ARTIST } })
      .keepIccProfile()
      .webp({ quality: DISPLAY_WEBP_QUALITY })
      .toBuffer();

    const output = await sharp(data).metadata();
    if (!output.width || !output.height) {
      throw new Error("Processed display derivative is missing dimensions");
    }

    return { data, width: output.width, height: output.height };
  });
}
