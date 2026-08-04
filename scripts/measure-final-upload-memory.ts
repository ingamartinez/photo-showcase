// Memory measurement for the FULL final-upload request path (task #220
// review follow-up) — not just `processDisplay`'s own decode
// (scripts/measure-final-memory.ts already measures that pass in isolation).
// Run manually:
//   bun run measure:final:upload:memory
//
// WHY THIS SCRIPT EXISTS, AND WHY IT HAS ALREADY BEEN WRONG TWICE:
//
// v1 (reasoning, not measuring) claimed removing this route's
// `Buffer.from()` copy left ~150 MB resident for a 150 MB upload through the
// decode step. A reviewer measured it instead and found ~300 MB — a real
// `request.formData()` parse produces a `File` with its OWN backing buffer,
// separate from what `file.arrayBuffer()` copies out, and the route's first
// version kept both alive by reading `file.type` AFTER the decode.
//
// v2 (this script's OWN first version) built its `Request` with `body:
// formData` — a `FormData` OBJECT, not multipart bytes. Bun special-cases
// that: `request.formData()` on a `Request` built from a `FormData` body
// just returns the SAME object back, with NO parse and NO second copy. A
// REAL incoming HTTP request never arrives as a `FormData` object — it
// arrives as multipart-encoded BYTES off a socket, and `request.formData()`
// has to actually decode that boundary-delimited byte stream into a `File`
// with its own storage. v2's own numbers gave this away and nobody
// (including the human running it) caught it in review: `afterFormData` was
// only ~0.2 MiB above `afterBuildRequest` for a 136 MiB body — "parsing"
// something that had already been reduced to a no-op reference return. v2's
// header comment claimed this made the harness CONSERVATIVE (an extra copy
// the real server wouldn't pay). That claim was BACKWARDS: it skipped the
// single most expensive step in the real request path, making v2's numbers
// systematically LOW.
//
// v3 (this version) builds the body as REAL multipart bytes — a boundary,
// headers, the file's bytes, the closing boundary — handed to `Request` as a
// `ReadableStream<Uint8Array>` with an explicit `content-type:
// multipart/form-data; boundary=...` header, exactly the shape a browser's
// own `fetch(url, { body: formData })` produces on the wire and exactly what
// Next.js's route handler receives. `request.formData()` now has no object
// to hand back — it has to parse.
//
// "MEASURE, DO NOT REASON" now means measure the REAL WIRE SHAPE, not merely
// "call `process.memoryUsage()` somewhere." Two prior wrong numbers in this
// one slice were both caught by someone re-measuring, not re-reading — do
// not trust this comment either; re-run the script.
//
// TWO SHAPES measured side by side, each its own fresh subprocess (see the
// header comment on `spawnOneRun` for why — same `maxRSS`-contamination
// reasoning scripts/measure-zip-memory.ts already documents, extended here
// to `process.memoryUsage()` readings generally):
//   - OLD: `file`/`formData` stay referenced across the decode (the shape
//     that shipped first) — `contentType` is read from `file.type` AFTER
//     `processDisplay` returns, mirroring the original `putObject` call site
//     exactly.
//   - NEW: the read is isolated in its own function (`readUploadedFinalNew`
//     below, mirroring the route's real `readUploadedFinal`), returning only
//     the `ArrayBuffer` and a `contentType` STRING — never `file` or
//     `formData`.
//
// WHAT THE REAL WIRE SHAPE CHANGES ABOUT THAT COMPARISON: on a real
// multipart request, the PEAK does not move between OLD and NEW. The peak is
// the moment `file.arrayBuffer()` has just finished copying the parsed
// `File`'s bytes out and that `File` has not yet been collected — both
// shapes reach that exact same moment (NEW reaches it inside
// `readUploadedFinalNew`, OLD reaches it in the caller) with the SAME two
// buffers simultaneously resident (the parsed File's own storage + the fresh
// ArrayBuffer copy), so no amount of variable scoping removes that specific
// peak. What the NEW shape actually buys is what happens AFTER: `file`/
// `formData` are unreachable the moment `readUploadedFinalNew` returns, so
// the parsed File's storage becomes collectible immediately, instead of
// staying resident for the rest of the request (through the whole
// `processDisplay` decode) the way the OLD shape's lingering `file.type`
// read forces it to. That is a REDUCTION IN POST-DECODE RESIDENCY, not in
// peak — it matters for anything queued behind `processDisplay`'s
// process-wide `runExclusive` mutex (src/lib/images.ts): a second request
// waiting on that mutex sits behind however much memory the FIRST request is
// still holding, and the fix is what keeps that not include an extra
// upload's worth of dead File storage. It does NOT lower the single-request
// peak this comment (and `MAX_FINAL_UPLOAD_BYTES`'s own comment in the
// route) sizes the cap against.
//
// `process.memoryUsage()` (`rss`, `arrayBuffers`), NOT `process.resourceUsage
// ().maxRSS` — deliberately different from this script's siblings. `maxRSS`
// is a HIGH-WATER MARK that never goes back down, wrong for "does
// dereferencing `file` actually let the runtime reclaim its buffer". A
// `global.gc()` call (behind Bun's `--expose-gc` flag — `spawnOneRun` below
// always passes it) immediately before each snapshot answers that directly.
//
// THREE FIXTURE PROFILES — a third was added on this same review round,
// because summing two SEPARATELY measured worst cases (a big-file profile
// and a big-pixel-count profile) turned out not to be legitimate: decode
// cost varies with input SHAPE at the same pixel count (8-bit vs 16-bit
// alone was observed to differ ~2x), so the true worst case has to be
// measured as ONE fixture that is simultaneously near both limits, not
// inferred by adding two independent maxima:
//   - REALISTIC: a genuinely large, poorly-compressible 24.6 MP 8-bit RGB
//     PNG (random per-pixel noise, same "actual detail compresses far less"
//     reasoning scripts/measure-final-memory.ts's own header already uses
//     for its JPEG fixture) — comfortably under `MAX_FINAL_UPLOAD_BYTES`.
//   - CEILING: a highly-compressible, near-flat 16-bit RGB PNG at 96 MP —
//     just under `MAX_INPUT_PIXELS`'s 100 MP ceiling (src/lib/images.ts) —
//     only a few MiB on disk, because near-flat content crushes down almost
//     regardless of pixel count or bit depth. Demonstrates that the byte cap
//     alone does not bound decode cost.
//   - BOTH: the case CEILING and REALISTIC each miss on their own — 96 MP,
//     8-bit RGB, moderately compressible (a low-frequency gradient plus a
//     small tunable noise amplitude, tuned empirically to land close to
//     `MAX_FINAL_UPLOAD_BYTES` while staying under `MAX_INPUT_PIXELS`), so
//     the fixture is near BOTH limits AT ONCE. This is the profile that
//     actually stresses the cap; REALISTIC and CEILING bound it from two
//     directions that don't compose additively.
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
type Profile = "realistic" | "ceiling" | "both";

// 24.6 MP, 8-bit RGB (no alpha), random noise — lands well under
// MAX_FINAL_UPLOAD_BYTES (80 MB, task #220's 2026-08-04 decision) because
// noise barely compresses, so file size tracks raw size closely.
const REALISTIC_WIDTH = 5600;
const REALISTIC_HEIGHT = 4400;

// 96,000,000 px — just under MAX_INPUT_PIXELS (100,000,000, src/lib/images.ts;
// NOT imported here — this script deliberately does not depend on that
// constant so a future change to it doesn't silently change what this script
// measures without a human noticing and re-checking the fixture). Shared by
// the CEILING and BOTH profiles below.
const CEILING_WIDTH = 12000;
const CEILING_HEIGHT = 8000;

// Empirically tuned so the BOTH fixture lands close to
// MAX_FINAL_UPLOAD_BYTES — not an exact science, PNG compression ratio for
// "real photo-like content" isn't a closed-form function of this amplitude,
// this is the value that produced ~76 MiB in the run that shipped with this
// comment.
const BOTH_NOISE_AMPLITUDE = 13;

function bytesToMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** REALISTIC fixture: genuinely large, poorly-compressible 8-bit RGB PNG —
 * random per-pixel noise, same reasoning as measure-final-memory.ts's own
 * JPEG fixture ("actual detail compresses far less" than a solid fill). */
async function buildRealisticFixture(): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(REALISTIC_WIDTH * REALISTIC_HEIGHT * 3);
  randomFillSync(raw);
  return sharp(raw, { raw: { width: REALISTIC_WIDTH, height: REALISTIC_HEIGHT, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/** CEILING fixture: near-flat, highly-compressible 16-bit RGB PNG at just
 * under MAX_INPUT_PIXELS — see this file's own header for why near-flat
 * content at high pixel count/bit depth is dangerous even at a tiny file
 * size. The small per-pixel increment keeps this from being a literal
 * single-colour fill (which some encoders/tools might special-case) while
 * still compressing to a tiny file. */
async function buildCeilingFixture(): Promise<Buffer> {
  const raw = new Uint16Array(CEILING_WIDTH * CEILING_HEIGHT * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 32768 + (i % 32);
  return sharp(raw, { raw: { width: CEILING_WIDTH, height: CEILING_HEIGHT, channels: 3 } })
    .toColourspace("rgb16")
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** BOTH fixture: 96 MP, 8-bit RGB, moderately compressible (low-frequency
 * gradient + small per-pixel noise) — tuned to land close to
 * MAX_FINAL_UPLOAD_BYTES while staying under MAX_INPUT_PIXELS. This is what
 * REALISTIC and CEILING each miss on their own: a fixture near BOTH limits
 * simultaneously, which is the case that actually stresses the cap (see this
 * file's own header for why summing the other two profiles' maxima is not a
 * legitimate substitute for measuring this one directly). */
async function buildBothFixture(): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(CEILING_WIDTH * CEILING_HEIGHT * 3);
  let idx = 0;
  for (let y = 0; y < CEILING_HEIGHT; y++) {
    const gy = Math.sin((y / CEILING_HEIGHT) * Math.PI * 2) * 60 + 128;
    for (let x = 0; x < CEILING_WIDTH; x++) {
      const gx = Math.cos((x / CEILING_WIDTH) * Math.PI * 3) * 40;
      const noise = (Math.random() - 0.5) * BOTH_NOISE_AMPLITUDE;
      const value = Math.max(0, Math.min(255, Math.round(gy + gx + noise)));
      raw[idx++] = value;
      raw[idx++] = value;
      raw[idx++] = value;
    }
  }
  return sharp(raw, { raw: { width: CEILING_WIDTH, height: CEILING_HEIGHT, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function buildFixture(profile: Profile): Promise<Buffer> {
  if (profile === "realistic") return buildRealisticFixture();
  if (profile === "ceiling") return buildCeilingFixture();
  return buildBothFixture();
}

type MemSnapshot = { rss: number; arrayBuffers: number; heapUsed: number };

/** Forces a full GC via Bun's `--expose-gc` global, then reads
 * `process.memoryUsage()`. Called MULTIPLE times per snapshot — a single
 * `gc()` call was observed NOT to fully reclaim a large recently-allocated
 * buffer in this exact harness; three calls is a cheap, empirically-
 * sufficient margin, not a documented guarantee from the runtime. Throws
 * with an actionable message if `--expose-gc` was not passed. */
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

const MULTIPART_BOUNDARY = "----FinalUploadMemoryBoundary";

function multipartHead(filename: string, contentType: string): Uint8Array {
  const head =
    `--${MULTIPART_BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  return new TextEncoder().encode(head);
}

function multipartTail(): Uint8Array {
  return new TextEncoder().encode(`\r\n--${MULTIPART_BOUNDARY}--\r\n`);
}

/** Builds the REAL multipart/form-data byte stream for `pngBytes` — the fix
 * for this script's own v2 bug (see this file's own header). Chunked in
 * `CHUNK_SIZE`-sized pieces to look like a real network body rather than one
 * giant enqueue, though — noted honestly — this enqueues everything eagerly
 * inside `start()` rather than lazily via `pull()`: an earlier attempt at a
 * lazily-pulled stream reproducibly stalled Bun's own multipart parser for a
 * body this large (a genuine runtime quirk, not this script's bug — a
 * `pull()`-based stream worked fine at small sizes and stalled specifically
 * at real-fixture scale). Eager `start()` still produces a real
 * `ReadableStream<Uint8Array>` of head + chunked body + tail — the parser
 * still has to consume and decode it chunk by chunk — it just isn't
 * BACKPRESSURE-paced the way a real socket read would be. That does not
 * change what gets measured here (peak resident bytes during/after the
 * parse), only how the bytes are scheduled into the stream. */
const CHUNK_SIZE = 64 * 1024;

function buildMultipartStream(pngBytes: ArrayBuffer): ReadableStream<Uint8Array> {
  const head = multipartHead("edit.png", "image/png");
  const tail = multipartTail();
  const body = new Uint8Array(pngBytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
      let offset = 0;
      while (offset < body.length) {
        const end = Math.min(offset + CHUNK_SIZE, body.length);
        controller.enqueue(body.subarray(offset, end));
        offset = end;
      }
      controller.enqueue(tail);
      controller.close();
    },
  });
}

/** Builds a `Request` carrying REAL multipart/form-data bytes — not a
 * `FormData` object (see this file's own header for why that was the bug).
 * `duplex: "half"` is required by the Fetch spec whenever `body` is a
 * `ReadableStream`; the DOM lib types this project's `tsc` uses don't yet
 * know that option, hence the cast. */
function buildUploadRequest(pngBytes: ArrayBuffer): Request {
  return new Request("http://localhost/api/assets/x/final", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
    body: buildMultipartStream(pngBytes),
    duplex: "half",
  } as RequestInit);
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
 * approach above — a second, independent measurement technique landing on
 * the same qualitative answer is stronger evidence than one technique run
 * twice. Isolates `processDisplay` alone, fed straight from the fixture's
 * own bytes on disk, with NO `Request`/multipart harness in the way. */
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
    for (const profile of ["realistic", "ceiling", "both"] as const) {
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
