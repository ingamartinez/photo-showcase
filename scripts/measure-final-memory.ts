// One-off memory measurement for a final upload's sharp work
// (src/lib/images.ts) — task #26's acceptance criterion is "full-resolution
// files do not blow the memory cap... report the peak observed", and
// explicitly warns against estimating instead of measuring. Run manually:
//   bun run measure:final:memory
//
// Task #89 extended what "a final upload's sharp work" MEANS: the route
// (POST /api/assets/[assetId]/final) now runs `processFinal` and then
// `processDisplay` over the final's own output, so measuring `processFinal`
// alone would no longer describe the request. This script measures each pass
// separately AND the combined peak across both, in the order the route runs
// them. Both go through the shared `runExclusive` mutex in
// src/lib/images.ts, so the combined figure is the real per-request ceiling
// — the two never overlap, not even with a third request\'s own pass.
//
// It also reports the DISPLAY derivative's byte size, which is what task
// #89\'s "page weight for a 20-photo delivered gallery" criterion is
// measured from: twenty of those is the whole grid.
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
// reading taken immediately before `processFinal()` and one taken
// immediately after, not either absolute value on its own.
//
// Fixture: a synthetic 6000x4000 (~24 MP — a common full-frame sensor
// resolution) image built from RANDOM per-pixel noise, not a solid fill. A
// solid-color JPEG round-trips through DCT/entropy coding almost instantly
// and compresses to a few KB, which would understate both the file size and
// the encode cost of a real photographic export — actual detail compresses
// far less and is what a Lightroom export actually looks like on disk. EXIF
// (including a GPS tag, to mirror a real camera export) and an ICC profile
// are attached to the fixture too, so this run also exercises the same
// decode/re-encode path a real final upload would.
import sharp from "sharp";
import { processDisplay, processFinal, processProof } from "../src/lib/images";

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

  const beforeFinal = process.resourceUsage().maxRSS;
  const result = await processFinal(fixture);
  const afterFinal = process.resourceUsage().maxRSS;

  // Task #89: the SECOND pass the route now runs, on the final's own output
  // bytes. Measured from its own "before" reading so the two passes can be
  // attributed separately, and against `beforeFinal` for the combined
  // per-request peak.
  const beforeDisplay = process.resourceUsage().maxRSS;
  const display = await processDisplay(result.data);
  const afterDisplay = process.resourceUsage().maxRSS;

  const delta = afterFinal - beforeFinal;
  const displayDelta = afterDisplay - beforeDisplay;
  const combinedDelta = afterDisplay - beforeFinal;

  // Bun's `maxRSS` mirrors the OS's raw `ru_maxrss`, whose UNIT differs by
  // platform: bytes on Darwin/macOS, kilobytes on Linux (the droplet this
  // app actually runs on). Labeled explicitly so nobody mistakes a macOS
  // byte count for a Linux kilobyte count when comparing against the
  // droplet's 768 MB `MemoryMax` cap — this script has only been run on
  // macOS dev machines so far; re-run it on the droplet before trusting an
  // absolute number against that cap.
  const unit = process.platform === "darwin" ? "bytes" : "KB (per Linux getrusage)";
  console.log(`unit: ${unit}`);
  console.log(`processFinal   delta: ${delta}`);
  console.log(`processDisplay delta: ${displayDelta}`);
  console.log(`COMBINED       delta: ${combinedDelta}   <- the real per-request cost`);
  if (process.platform === "darwin") {
    console.log(`\nprocessFinal   delta (MiB): ${bytesToMiB(delta)}`);
    console.log(`processDisplay delta (MiB): ${bytesToMiB(displayDelta)}`);
    console.log(`COMBINED       delta (MiB): ${bytesToMiB(combinedDelta)}`);
  }

  console.log(`\nOutput final size:   ${bytesToMiB(result.data.length)} MiB`);
  console.log(
    `Output display size: ${(display.data.length / 1024).toFixed(0)} KiB ` +
      `(${display.width}x${display.height})`,
  );

  // The comparison task #89's page-weight criterion actually asks for: is a
  // delivered gallery's grid in the PROOFING view's size class, or in the
  // full-resolution finals' one? Run over the same fixture so the three
  // numbers are directly comparable.
  const proof = await processProof(fixture);
  const twenty = (bytes: number) => `${((bytes * 20) / (1024 * 1024)).toFixed(1)} MiB`;
  console.log(`\nPage weight for a 20-photo gallery, same fixture:`);
  console.log(`  proofing view (20 x proof):    ${twenty(proof.data.length)}`);
  console.log(`  delivered view (20 x display): ${twenty(display.data.length)}`);
  console.log(`  the WRONG implementation (20 x final): ${twenty(result.data.length)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
