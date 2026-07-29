// One-off memory measurement for `processFinal` (src/lib/images.ts, task
// #26) — that task's own acceptance criterion is "full-resolution files do
// not blow the memory cap... report the peak observed", and explicitly
// warns against estimating instead of measuring. Run manually:
//   bun run measure:final:memory
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
import { processFinal } from "../src/lib/images";

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

  const before = process.resourceUsage().maxRSS;
  const result = await processFinal(fixture);
  const after = process.resourceUsage().maxRSS;
  const delta = after - before;

  // Bun's `maxRSS` mirrors the OS's raw `ru_maxrss`, whose UNIT differs by
  // platform: bytes on Darwin/macOS, kilobytes on Linux (the droplet this
  // app actually runs on). Labeled explicitly so nobody mistakes a macOS
  // byte count for a Linux kilobyte count when comparing against the
  // droplet's 768 MB `MemoryMax` cap — this script has only been run on
  // macOS dev machines so far; re-run it on the droplet before trusting an
  // absolute number against that cap.
  const unit = process.platform === "darwin" ? "bytes" : "KB (per Linux getrusage)";
  console.log(`maxRSS before: ${before} ${unit}`);
  console.log(`maxRSS after:  ${after} ${unit}`);
  console.log(`delta:         ${delta} ${unit}`);
  if (process.platform === "darwin") {
    console.log(`delta (MiB):   ${bytesToMiB(delta)}`);
  }
  console.log(`\nOutput final size: ${bytesToMiB(result.data.length)} MiB`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
