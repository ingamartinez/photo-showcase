// One-off memory measurement for a final upload's sharp work
// (src/lib/images.ts) — task #26's original acceptance criterion was "full-
// resolution files do not blow the memory cap... report the peak observed",
// and explicitly warns against estimating instead of measuring. Run manually:
//   bun run measure:final:memory
//
// TASK #218 rewrote what this script measures. The final upload route (POST
// /api/assets/[assetId]/final) used to run TWO sharp passes — `processFinal`
// (a full-frame decode/re-encode, unable to shrink-on-load) then
// `processDisplay` over its output. `processFinal` is deleted: the final is
// now stored byte-for-byte, no sharp pass at all on that path. The route's
// ONLY remaining sharp work is `processDisplay`, fed the raw uploaded bytes
// directly — so this script now measures exactly that one pass, which is
// strictly CHEAPER than what it used to measure (no full-frame decode; see
// `processDisplay`'s own shrink-on-load comment in src/lib/images.ts).
//
// It also reports the DISPLAY derivative's byte size, which is what task
// #89's "page weight for a 20-photo delivered gallery" criterion is measured
// from: twenty of those is the whole grid.
//
// Not wired into any route, build step, or CI job — this is a verification
// tool for a human to re-run whenever the pipeline's quality setting or
// input assumptions change, the same role scripts/check-r2.ts and
// scripts/check-resend.ts play for their own subsystems.
//
// Methodology: `process.resourceUsage().maxRSS` is a monotonically
// non-decreasing HIGH-WATER MARK for the whole process's lifetime (it can
// never go down, even after the memory is freed) — so the number that
// actually answers "how much did this one call cost" is the DELTA between a
// reading taken immediately before `processDisplay()` and one taken
// immediately after, not either absolute value on its own.
//
// Fixture: a synthetic 6000x4000 (~24 MP — a common full-frame sensor
// resolution) image built from RANDOM per-pixel noise, not a solid fill. A
// solid-color JPEG round-trips through DCT/entropy coding almost instantly
// and compresses to a few KB, which would understate both the file size and
// the encode cost of a real photographic export — actual detail compresses
// far less and is what a Lightroom export actually looks like on disk. EXIF
// (including a GPS-shaped tag, to mirror a real camera export) and an ICC
// profile are attached to the fixture too, so this run also exercises the
// same decode path a real final upload would — even though task #218 means
// none of that metadata is stripped from the STORED FINAL any more, only
// from `processDisplay`'s own output.
import sharp from "sharp";
import { processDisplay, processProof } from "../src/lib/images";

const WIDTH = 6000;
const HEIGHT = 4000;

function bytesToMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function buildFixture(): Promise<Buffer> {
  const noise = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);

  return sharp(noise, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .jpeg({ quality: 92 })
    .withExif({ IFD0: { Copyright: "Fixture Camera Export", GPSLatitude: "40.7128" } })
    .withIccProfile("srgb")
    .toBuffer();
}

async function main(): Promise<void> {
  const megapixels = ((WIDTH * HEIGHT) / 1_000_000).toFixed(1);
  console.log(
    `Building a ${WIDTH}x${HEIGHT} (~${megapixels} MP) synthetic full-resolution fixture...`,
  );
  const fixture = await buildFixture();
  console.log(`Fixture size: ${bytesToMiB(fixture.length)} MiB\n`);

  // TASK #218: this fixture IS what gets stored at `finalKey` now — no sharp
  // pass runs on it. The only remaining request cost is this one pass.
  const beforeDisplay = process.resourceUsage().maxRSS;
  const display = await processDisplay(fixture);
  const afterDisplay = process.resourceUsage().maxRSS;

  const displayDelta = afterDisplay - beforeDisplay;

  // Bun's `maxRSS` mirrors the OS's raw `ru_maxrss`, whose UNIT differs by
  // platform: bytes on Darwin/macOS, kilobytes on Linux (the droplet this
  // app actually runs on). Labeled explicitly so nobody mistakes a macOS
  // byte count for a Linux kilobyte count when comparing against the
  // droplet's 768 MB `MemoryMax` cap — this script has only been run on
  // macOS dev machines so far; re-run it on the droplet before trusting an
  // absolute number against that cap.
  const unit = process.platform === "darwin" ? "bytes" : "KB (per Linux getrusage)";
  console.log(`unit: ${unit}`);
  console.log(`processDisplay delta: ${displayDelta}   <- the real per-request cost (task #218)`);
  if (process.platform === "darwin") {
    console.log(`processDisplay delta (MiB): ${bytesToMiB(displayDelta)}`);
  }

  console.log(
    `\nOutput display size: ${(display.data.length / 1024).toFixed(0)} KiB ` +
      `(${display.width}x${display.height})`,
  );
  console.log(
    `Stored final size (byte-for-byte, no processing): ${bytesToMiB(fixture.length)} MiB`,
  );

  // The comparison task #89's page-weight criterion actually asks for: is a
  // delivered gallery's grid in the PROOFING view's size class, or in the
  // full-resolution finals' one? Run over the same fixture so the numbers are
  // directly comparable.
  const proof = await processProof(fixture);
  const twenty = (bytes: number) => `${((bytes * 20) / (1024 * 1024)).toFixed(1)} MiB`;
  console.log(`\nPage weight for a 20-photo gallery, same fixture:`);
  console.log(`  proofing view (20 x proof):        ${twenty(proof.data.length)}`);
  console.log(`  delivered view (20 x display):     ${twenty(display.data.length)}`);
  console.log(`  the WRONG implementation (20 x raw final): ${twenty(fixture.length)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
