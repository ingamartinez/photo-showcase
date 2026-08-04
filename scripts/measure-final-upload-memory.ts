// Memory measurement for the FULL final-upload request path (task #220
// review follow-up) — not just `processDisplay`'s own decode
// (scripts/measure-final-memory.ts already measures that pass in isolation).
// Run manually:
//   bun run measure:final:upload:memory
//
// WHY THIS SCRIPT EXISTS: task #220's own report reasoned that removing the
// route's `Buffer.from()` copy left ~150 MB resident for a 150 MB upload
// through the decode step. That reasoning was WRONG — a reviewer measured
// it instead and found ~300 MB, not 150 MB, and this script is the fix: it
// measures the SAME thing, end to end, so the number in the route's own
// `MAX_FINAL_UPLOAD_BYTES` comment is observed, not reasoned about a second
// time. "Measure, do not reason" is now a project rule for this exact
// number, not a suggestion — see that constant's own comment for the
// figures this script produced.
//
// THE ACTUAL BUG: `request.formData()` parses a multipart body into a
// `FormData` whose `File` entry holds its OWN backing buffer, roughly the
// size of the upload — a SEPARATE allocation from the `ArrayBuffer`
// `file.arrayBuffer()` copies out of it. Calling `.arrayBuffer()` does NOT
// free the first copy; nothing does until every reference to
// `file`/`formData` is gone and the runtime actually reclaims it. The
// route's first version kept `file` referenced AFTER the decode (at
// `putObject(..., { contentType: file.type })`), so BOTH copies sat
// resident through the whole request, not one.
//
// FIXTURES ARE BUILT ONCE, TO A TEMP FILE, BEFORE ANY MEASUREMENT RUNS —
// deliberately NOT inside the measured worker subprocess. An earlier version
// of this script built each fixture inline, and the CEILING fixture (a raw
// 16-bit pixel buffer piped through a sharp ENCODE pipeline —
// `.toColourspace('rgb16').png()`) turned out not to release its own
// internal/native buffers promptly even after repeated explicit `gc()`
// calls, ballooning "before any real work has happened" RSS past a GiB and
// making every downstream reading meaningless. That is a property of
// sharp's ENCODE path (which nothing in production ever runs — an upload
// arrives ALREADY PNG-encoded, the server only ever DECODES it), not of the
// DECODE path this script actually cares about, so it does not belong
// inside what gets measured. Each worker below reads its fixture's bytes
// straight off disk (`Bun.file(path).arrayBuffer()`) — cheap, and it is
// exactly what a real request handler starts from too: bytes that already
// exist, not bytes it just finished encoding itself.
//
// TWO SHAPES measured side by side, each its own fresh subprocess (see the
// header comment on `spawnOneRun` for why — same `maxRSS`-contamination
// reasoning scripts/measure-zip-memory.ts already documents, extended here
// to `process.memoryUsage()` readings generally: a long-lived process's
// heap/RSS only trends up across runs unless a full GC happens to reclaim it
// between them, and this script wants to know whether that reclaim actually
// happens, not whether it could):
//   - OLD: `file`/`formData` stay referenced across the decode (the shape
//     that shipped first) — `contentType` is read from `file.type` AFTER
//     `processDisplay` returns, mirroring the original `putObject` call site
//     exactly.
//   - NEW: the read is isolated in its own function (`readUploadedFinalNew`
//     below, mirroring the route's real `readUploadedFinal`), returning only
//     the `ArrayBuffer` and a `contentType` STRING — never `file` or
//     `formData` — so neither is reachable from the caller once that
//     function returns.
//
// `process.memoryUsage()` (`rss`, `arrayBuffers`), NOT
// `process.resourceUsage().maxRSS` — deliberately different from this
// script's siblings. `maxRSS` is a HIGH-WATER MARK that never goes back
// down, which is exactly wrong for the question THIS script asks ("does
// dereferencing `file` actually let the runtime reclaim its buffer before
// the decode runs?"). `process.memoryUsage()` reports CURRENT usage, so a
// `global.gc()` call (behind Bun's `--expose-gc` flag — `spawnOneRun` below
// always passes it) immediately before each snapshot answers that question
// directly: if the OLD shape's post-decode reading is still ~1 upload-size
// higher than the NEW shape's, post-GC, the extra copy is real and
// reclaimable-but-not-reclaimed; if the two collapse to the same number,
// dereferencing was already enough.
//
// TWO FIXTURE PROFILES, because "the exact file the cap raise exists for"
// turned out to have two different dangerous shapes, not one:
//   - REALISTIC: a genuinely large, poorly-compressible 45 MP 8-bit RGB PNG
//     (random per-pixel noise, same "actual detail compresses far less"
//     reasoning scripts/measure-final-memory.ts's own header already uses
//     for its JPEG fixture) — what an actual detailed photograph exported
//     as PNG looks like on disk. Lands UNDER `MAX_FINAL_UPLOAD_BYTES`
//     (150 MB) because noise-like content barely compresses, so file size
//     tracks raw size closely.
//   - CEILING: a highly-compressible, near-flat 16-bit RGB PNG at just under
//     `MAX_INPUT_PIXELS` (100,000,000 px, src/lib/images.ts) — chosen
//     because PNG's filters+deflate crush near-flat content down to a TINY
//     file almost regardless of pixel count or bit depth, which is the
//     actual danger this profile demonstrates: `MAX_FINAL_UPLOAD_BYTES`
//     gates the COMPRESSED file size, not the DECODED buffer size, and a
//     highly compressible image can carry far more decoded bytes per
//     uploaded byte than an incompressible one of the SAME file size. A
//     96 MP 16-bit image decodes to ~549 MiB raw (96,000,000 px × 3
//     channels × 2 bytes) — well past what `MAX_INPUT_PIXELS`'s own comment
//     in src/lib/images.ts assumes as its "4 bytes/pixel" 8-bit worst case,
//     and reachable through a file that comfortably fits under the current
//     byte cap. This is not a scare number picked to make a point — it is a
//     real PNG a real export tool could plausibly produce (a smooth
//     product/sky background at high resolution, exported at 16 bits for
//     later colour grading), fed through the ACTUAL decode path.
//
// PLATFORM CAVEAT — same as this script's siblings: this has only ever been
// run on a macOS laptop. The droplet is Linux, 2 GB total, `MemoryMax=768M`
// for `photoshowcase.service`. These numbers support the decision; they do
// not prove it there.
import { randomFillSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { processDisplay } from "../src/lib/images";

type Shape = "old" | "new";
type Profile = "realistic" | "ceiling";

// 45,000,000 px, 8-bit RGB (no alpha) — a common full-frame-class resolution.
const REALISTIC_WIDTH = 7500;
const REALISTIC_HEIGHT = 6000;

// 96,000,000 px — just under MAX_INPUT_PIXELS (100,000,000, src/lib/images.ts;
// NOT reproduced as an import — this script deliberately does not depend on
// that constant so a future change to it doesn't silently change what this
// script measures without a human noticing and re-checking the fixture).
const CEILING_WIDTH = 12000;
const CEILING_HEIGHT = 8000;

function bytesToMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** REALISTIC fixture: genuinely large, poorly-compressible 8-bit RGB PNG —
 * random per-pixel noise, same reasoning as measure-final-memory.ts's own
 * JPEG fixture ("actual detail compresses far less" than a solid fill).
 * Lands under MAX_FINAL_UPLOAD_BYTES because noise barely compresses via
 * PNG's filters+deflate, so file size tracks raw size closely. */
async function buildRealisticFixture(): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(REALISTIC_WIDTH * REALISTIC_HEIGHT * 3);
  randomFillSync(raw);
  return sharp(raw, { raw: { width: REALISTIC_WIDTH, height: REALISTIC_HEIGHT, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/** CEILING fixture: near-flat, highly-compressible 16-bit RGB PNG at just
 * under MAX_INPUT_PIXELS — see this file's own header for why near-flat
 * content at high pixel count/bit depth is the actually dangerous shape,
 * not a maximally detailed one. The small per-pixel increment keeps this
 * from being a literal single-colour fill (which some encoders/tools might
 * special-case) while still compressing to a tiny file. */
async function buildCeilingFixture(): Promise<Buffer> {
  const raw = new Uint16Array(CEILING_WIDTH * CEILING_HEIGHT * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 32768 + (i % 32);
  return sharp(raw, { raw: { width: CEILING_WIDTH, height: CEILING_HEIGHT, channels: 3 } })
    .toColourspace("rgb16")
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function buildFixture(profile: Profile): Promise<Buffer> {
  return profile === "realistic" ? buildRealisticFixture() : buildCeilingFixture();
}

type MemSnapshot = { rss: number; arrayBuffers: number; heapUsed: number };

/** Forces a full GC via Bun's `--expose-gc` global, then reads
 * `process.memoryUsage()`. Called MULTIPLE times per snapshot — a single
 * `gc()` call was observed NOT to fully reclaim a large recently-allocated
 * buffer in this exact harness (see this file's own header comment on why
 * fixture-building was moved out of the measured process entirely); three
 * calls is a cheap, empirically-sufficient margin, not a documented
 * guarantee from the runtime. Throws with an actionable message if
 * `--expose-gc` was not passed, rather than silently reading un-GC'd (and
 * therefore meaningless for this script's whole question) numbers. */
function snapshot(): MemSnapshot {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    throw new Error(
      "global.gc() is not available — this script must run with --expose-gc " +
        "(spawnOneRun below already passes it; if you're invoking bun directly, " +
        "add --expose-gc).",
    );
  }
  gc();
  gc();
  gc();
  const usage = process.memoryUsage();
  return { rss: usage.rss, arrayBuffers: usage.arrayBuffers, heapUsed: usage.heapUsed };
}

function buildUploadRequest(pngBytes: ArrayBuffer): Request {
  const formData = new FormData();
  formData.set("file", new File([new Uint8Array(pngBytes)], "edit.png", { type: "image/png" }));
  return new Request("http://localhost/api/assets/x/final", { method: "POST", body: formData });
}

/** Mirrors the route's REAL `readUploadedFinal` (final/route.ts) — the fix.
 * `file`/`formData` are local to THIS function and never returned; only the
 * ArrayBuffer and a plain string escape. */
async function readUploadedFinalNew(
  request: Request,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const formData = await request.formData();
  const file = formData.get("file") as File;
  const bytes = await file.arrayBuffer();
  return { bytes, contentType: file.type };
}

type RunResult = Record<string, MemSnapshot>;

/** OLD shape — what the route's first version actually did: `file` stays
 * referenced in the CALLER's own scope all the way past the decode, read
 * again at the very end (mirroring `putObject(..., { contentType: file.type
 * })`, the real call site that kept it alive). */
async function runOldShape(pngBytes: ArrayBuffer): Promise<RunResult> {
  const base = snapshot();

  const request = buildUploadRequest(pngBytes);
  const afterBuildRequest = snapshot();

  const formData = await request.formData();
  const file = formData.get("file") as File;
  const afterFormData = snapshot();

  const uploadedBytes = await file.arrayBuffer();
  const afterArrayBuffer = snapshot();

  const display = await processDisplay(uploadedBytes);
  const afterDecode = snapshot();

  // The bug, reproduced exactly: `file` is still alive HERE, after the
  // decode, because the real route read `file.type` at the `putObject` call
  // site below its own decode step.
  const contentType = file.type;
  void contentType;
  void display;
  const afterHandlerEnd = snapshot();

  return { base, afterBuildRequest, afterFormData, afterArrayBuffer, afterDecode, afterHandlerEnd };
}

/** NEW shape — the fix: the read is isolated in `readUploadedFinalNew`
 * above. By the time this function has its result back, `file`/`formData`
 * are unreachable from here — there is no "afterFormData"/"afterArrayBuffer"
 * checkpoint in the caller at all, because the caller never sees either
 * object. */
async function runNewShape(pngBytes: ArrayBuffer): Promise<RunResult> {
  const base = snapshot();

  const request = buildUploadRequest(pngBytes);
  const afterBuildRequest = snapshot();

  const { bytes: uploadedBytes, contentType } = await readUploadedFinalNew(request);
  const afterRead = snapshot();

  const display = await processDisplay(uploadedBytes);
  const afterDecode = snapshot();

  void contentType;
  void display;
  const afterHandlerEnd = snapshot();

  return { base, afterBuildRequest, afterRead, afterDecode, afterHandlerEnd };
}

/** DECODE-ONLY cross-check, deliberately using the SAME `process.resourceUsage
 * ().maxRSS`-delta methodology as scripts/measure-final-memory.ts (this
 * script's own sibling) instead of the `process.memoryUsage()`/forced-GC
 * approach the request-path measurements above use — a second, independent
 * measurement technique landing on the same qualitative answer is stronger
 * evidence than one technique run twice. Isolates `processDisplay` alone,
 * fed straight from the fixture's own bytes on disk, with NO
 * `Request`/`FormData`/`File` harness in the way at all — this is what
 * answers "how much does the DECODE ITSELF cost", independent of anything
 * this script's own request-building machinery adds on top. */
async function runDecodeOnly(pngBytes: ArrayBuffer): Promise<{ maxRssDelta: number }> {
  const before = process.resourceUsage().maxRSS;
  const display = await processDisplay(pngBytes);
  const after = process.resourceUsage().maxRSS;
  void display;
  return { maxRssDelta: after - before };
}

// --- Worker mode: read ONE pre-built fixture off disk, run ONE measurement,
// print exactly one JSON line, exit. Invoked by the orchestrator below as
// its own fresh subprocess — see this file's own header comment for why a
// fresh process matters here (same reasoning measure-zip-memory.ts's own
// header gives for `maxRSS`, extended to `process.memoryUsage()`). ---
async function runWorker(shape: Shape | "decode-only", fixturePath: string): Promise<void> {
  const fixture = await Bun.file(fixturePath).arrayBuffer();
  if (shape === "decode-only") {
    const result = await runDecodeOnly(fixture);
    process.stdout.write(JSON.stringify({ fixtureBytes: fixture.byteLength, ...result }));
    return;
  }
  const result = shape === "old" ? await runOldShape(fixture) : await runNewShape(fixture);
  process.stdout.write(JSON.stringify({ fixtureBytes: fixture.byteLength, ...result }));
}

/** Spawns one fresh `bun --expose-gc` subprocess to perform a single (shape,
 * fixturePath) run, parses its one-line JSON result. SINGLE run per
 * configuration, not repeated 3x like this script's siblings — this is a
 * diagnostic tool, not a CI gate, and the numbers below are reported as
 * single observations, not a min/median/max spread; the report that cites
 * them says so explicitly. */
function spawnOneRun(shape: Shape | "decode-only", fixturePath: string): Record<string, unknown> {
  const result = Bun.spawnSync([
    "bun",
    "--expose-gc",
    "run",
    import.meta.path,
    "--worker",
    shape,
    fixturePath,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `worker subprocess failed (shape=${shape}, fixture=${fixturePath}): ${result.stderr.toString()}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

function printCheckpoints(result: RunResult): void {
  for (const [label, snap] of Object.entries(result)) {
    console.log(
      `    ${label.padEnd(18)} rss=${bytesToMiB(snap.rss)} MiB   ` +
        `arrayBuffers=${bytesToMiB(snap.arrayBuffers)} MiB   ` +
        `heapUsed=${bytesToMiB(snap.heapUsed)} MiB`,
    );
  }
}

function peakRss(result: RunResult): number {
  return Math.max(...Object.values(result).map((s) => s.rss));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    const shape = args[1] as Shape | "decode-only";
    const fixturePath = args[2]!;
    await runWorker(shape, fixturePath);
    return;
  }

  console.log(
    `Platform: ${process.platform}. This is a laptop run — see this file's own header for the droplet caveat.\n`,
  );

  const dir = mkdtempSync(path.join(tmpdir(), "final-upload-memory-"));
  try {
    for (const profile of ["realistic", "ceiling"] as const) {
      console.log(`=== ${profile.toUpperCase()} fixture ===`);
      const fixtureBytes = await buildFixture(profile);
      const fixturePath = path.join(dir, `${profile}.png`);
      await Bun.write(fixturePath, fixtureBytes);
      console.log(`  fixture file: ${bytesToMiB(fixtureBytes.byteLength)} MiB on disk\n`);

      const results: Record<Shape, RunResult> = { old: {}, new: {} };
      for (const shape of ["old", "new"] as const) {
        const raw = spawnOneRun(shape, fixturePath);
        const { fixtureBytes: _readBack, ...checkpoints } = raw;
        results[shape] = checkpoints as RunResult;
        console.log(`  ${shape} shape:`);
        printCheckpoints(results[shape]);
      }
      console.log(
        `  peak RSS — old: ${bytesToMiB(peakRss(results.old))} MiB, ` +
          `new: ${bytesToMiB(peakRss(results.new))} MiB`,
      );

      // Independent cross-check (see runDecodeOnly's own comment): the SAME
      // maxRSS-delta methodology scripts/measure-final-memory.ts already
      // uses, isolating processDisplay alone with no request-building
      // harness in the way at all.
      const decodeOnly = spawnOneRun("decode-only", fixturePath) as { maxRssDelta: number };
      const unit = process.platform === "darwin" ? "bytes" : "KB (per Linux getrusage)";
      console.log(
        `  decode-only maxRSS delta (independent methodology): ${decodeOnly.maxRssDelta} ${unit}` +
          (process.platform === "darwin" ? ` (${bytesToMiB(decodeOnly.maxRssDelta)} MiB)` : "") +
          "\n",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
