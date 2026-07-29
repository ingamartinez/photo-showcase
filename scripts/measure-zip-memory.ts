// Memory measurement for the download-all-as-zip route (task #29) — same
// role scripts/measure-final-memory.ts (task #26) plays for `processFinal`:
// "report the peak observed, don't estimate it." Run manually:
//   bun run measure:zip:memory
//
// THE QUESTION THIS SCRIPT ANSWERS: does building a gallery-wide zip on the
// droplet (768M `MemoryMax`, infra/systemd/photoshowcase.service, shared with
// `findash`) cost memory proportional to the WHOLE gallery, or something
// close to constant regardless of gallery size? The route's own header
// comment (src/app/api/galleries/[galleryId]/download-all/route.ts) argues
// for "close to constant" by construction — `zip-stream.ts` streams one R2
// object at a time, never buffering an entry or the archive — and this
// script measures that claim directly rather than trusting the argument.
//
// Two modes are measured and reported side by side, on purpose — kanban #29's
// own instruction: "streaming versus buffering changes the memory answer
// entirely... measure the shape you actually intend to ship":
//   - STREAMED: chunks are read from `buildZipStream` and immediately
//     discarded (byte-counted, never retained) — this is the shape the real
//     route actually ships (`toReadableStream` feeding a Next.js `Response`
//     body, which Next/the underlying HTTP server drains incrementally, the
//     same way this harness does).
//   - BUFFERED (NOT what ships — measured only for contrast): every chunk is
//     instead pushed onto an array and `Buffer.concat`-ed at the end, the
//     naive "build the whole zip in memory, then respond" shape this task's
//     own body warns is a "genuine memory and CPU event." Included so the
//     streamed number means something relative to the alternative, not in
//     isolation.
//
// SUBPROCESS-PER-RUN, deliberately, not "N loop iterations in one process":
// `process.resourceUsage().maxRSS` is a HIGH-WATER MARK for the WHOLE
// PROCESS's lifetime (measure-final-memory.ts's own comment already says
// this) — it never goes back down, even after memory is freed. Looping every
// configuration inside one long-lived process was tried first and produces
// exactly the artifact that comment warns about: once ANY run in the process
// has pushed the heap up, every SUBSEQUENT run's "before" reading already
// sits at that elevated baseline, so its measured delta silently UNDERSTATES
// that later run's own real cost — worse for whichever configuration happens
// to run later, which is backwards for a script whose whole point is
// comparing costs across configurations. Spawning a fresh `bun` subprocess
// per single run removes this contamination entirely: each run gets its own
// process, its own baseline, and its own honest high-water mark.
//
// Fixture: `FINAL_SIZE_BYTES` (~20 MiB) matches measure-final-memory.ts's own
// OBSERVED final output size for a 24 MP source (that script's own printed
// "Output final size: 17.3 MiB" — 20 MiB rounds up from it with margin, not a
// separate guess). Content is a single randomly-filled buffer, COPIED (never
// aliased) into each synthetic entry — real per-file byte CONTENT plays no
// role in this measurement at all: STORE-only zipping does no compression or
// image decode, only a running CRC-32 (content-dependent cost is negligible
// and content-independent either way) and a byte copy (cost depends on SIZE,
// not content) — so a synthetic fixture answers this exact question just as
// honestly as a real photo would, unlike processFinal's own measurement,
// where content structure (compressibility) genuinely matters.
//
// PLATFORM CAVEAT — copied from measure-final-memory.ts's own note, because
// it is just as true here: `process.resourceUsage().maxRSS` is bytes on
// Darwin, KILOBYTES on Linux (kanban #57's own finding). This script has only
// ever been run on a macOS dev machine as of this writing — the numbers
// printed below are NOT authoritative for the droplet's 768M cap without a
// real run there. Said plainly, not dressed up: this is a laptop measurement
// that supports the decision, not a droplet measurement that proves it.
import { randomFillSync } from "node:crypto";
import { buildZipStream, type ZipEntry } from "../src/lib/zip-stream";

const FINAL_SIZE_BYTES = 20 * 1024 * 1024;
const CHUNK_SIZE_BYTES = 64 * 1024; // a realistic network/R2-stream chunk size
const RUNS_PER_CONFIG = 3; // repeated, not single-shot — see this task's own
// note on run-to-run variance: a 45 MP fixture measured 150/258/307 MiB
// across three consecutive runs in a sibling measurement.
const FILE_COUNTS = [5, 20, 40];

type Mode = "streamed" | "buffered";
type RunResult = { deltaMaxRss: number; totalBytes: number };

function bytesToMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function sourceBuffer(): Buffer {
  const buf = Buffer.allocUnsafe(FINAL_SIZE_BYTES);
  randomFillSync(buf);
  return buf;
}

/** Streams `data` out in `CHUNK_SIZE_BYTES` pieces — stands in for a real R2
 * object's `.stream()` (src/lib/r2.ts's `getObjectStream`), which never hands
 * back its whole body in one chunk either. */
function chunkedStream(data: Buffer): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK_SIZE_BYTES, data.length);
      // A fresh COPY per chunk, not a subarray view over the shared source —
      // a real R2 stream hands back its own freshly-allocated chunks, not
      // views into some other buffer this harness happens to hold onto.
      controller.enqueue(new Uint8Array(data.subarray(offset, end)));
      offset = end;
    },
  });
}

function galleryEntries(fileCount: number): ZipEntry[] {
  const source = sourceBuffer();
  return Array.from({ length: fileCount }, (_, i) => ({
    name: `foto-${i + 1}.jpg`,
    openStream: () => chunkedStream(source),
  }));
}

/** Drains the zip stream, discarding every chunk immediately after counting
 * its bytes — this IS the shape the real route ships (see this file's own
 * header comment). */
async function runStreamed(fileCount: number): Promise<RunResult> {
  const before = process.resourceUsage().maxRSS;
  let totalBytes = 0;
  for await (const chunk of buildZipStream(galleryEntries(fileCount))) {
    totalBytes += chunk.byteLength;
  }
  const after = process.resourceUsage().maxRSS;
  return { deltaMaxRss: after - before, totalBytes };
}

/** NOT what ships — see this file's own header comment. Accumulates every
 * chunk instead of discarding it, then `Buffer.concat`s the whole archive,
 * the naive "build it all in memory first" shape this task's own body warns
 * against. Measured only so the streamed number above has something real to
 * compare against. */
async function runBuffered(fileCount: number): Promise<RunResult> {
  const before = process.resourceUsage().maxRSS;
  const chunks: Uint8Array[] = [];
  for await (const chunk of buildZipStream(galleryEntries(fileCount))) {
    chunks.push(chunk);
  }
  const wholeArchive = Buffer.concat(chunks);
  const after = process.resourceUsage().maxRSS;
  return { deltaMaxRss: after - before, totalBytes: wholeArchive.byteLength };
}

// --- Worker mode: run exactly ONE measurement, print exactly one JSON line,
// exit. Invoked by the orchestrator below as its own fresh subprocess per
// run — see this file's own header comment for why that matters. ---
async function runWorker(mode: Mode, fileCount: number): Promise<void> {
  const result = mode === "streamed" ? await runStreamed(fileCount) : await runBuffered(fileCount);
  process.stdout.write(JSON.stringify(result));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Spawns one fresh subprocess to perform a single (mode, fileCount) run,
 * parses its one-line JSON result. Uses `Bun.spawnSync` — this script only
 * ever runs under `bun run` (package.json's own `measure:zip:memory`
 * script), same runtime assumption src/lib/r2.ts's own header comment makes
 * about this whole app. */
function spawnOneRun(mode: Mode, fileCount: number): RunResult {
  const result = Bun.spawnSync([
    "bun",
    "run",
    import.meta.path,
    "--worker",
    mode,
    String(fileCount),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `worker subprocess failed (mode=${mode}, fileCount=${fileCount}): ${result.stderr.toString()}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as RunResult;
}

function reportConfig(mode: Mode, fileCount: number): void {
  const results = Array.from({ length: RUNS_PER_CONFIG }, () => spawnOneRun(mode, fileCount));
  const deltas = results.map((r) => r.deltaMaxRss);
  const totalBytes = results[0]!.totalBytes;

  const unit = process.platform === "darwin" ? "bytes" : "KB (per Linux getrusage)";
  const asMiB = (v: number) => (process.platform === "darwin" ? ` (${bytesToMiB(v)} MiB)` : "");
  console.log(
    `${mode}: ${fileCount} files, ~${bytesToMiB(totalBytes)} MiB archive\n` +
      `  maxRSS delta per run: ${deltas.map((d) => `${d}${asMiB(d)}`).join(", ")} ${unit}\n` +
      `  min/median/max: ${Math.min(...deltas)}${asMiB(Math.min(...deltas))} / ` +
      `${median(deltas)}${asMiB(median(deltas))} / ${Math.max(...deltas)}${asMiB(Math.max(...deltas))} ${unit}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    const mode = args[1] as Mode;
    const fileCount = Number(args[2]);
    await runWorker(mode, fileCount);
    return;
  }

  console.log(
    `Platform: ${process.platform} — maxRSS unit is ${
      process.platform === "darwin" ? "BYTES (Darwin)" : "KILOBYTES (Linux getrusage)"
    }.`,
  );
  console.log(
    process.platform === "darwin"
      ? "This is a laptop run. The droplet is Linux — these numbers support the decision, they do not prove it there. Re-run on the droplet before treating them as authoritative.\n"
      : "Running on Linux — closer to the droplet's own shape, but still not the droplet's own cgroup/MemoryMax accounting unless run there directly.\n",
  );
  console.log(
    `Fixture: ${bytesToMiB(FINAL_SIZE_BYTES)} MiB per synthetic final (matches measure-final-memory.ts's own observed ~17 MiB output, rounded up), streamed in ${bytesToMiB(CHUNK_SIZE_BYTES)} MiB chunks. Each of the ${RUNS_PER_CONFIG} runs per configuration below is its own fresh subprocess (see this file's own header comment on maxRSS contamination).\n`,
  );

  console.log("--- STREAMED (what actually ships) ---");
  for (const fileCount of FILE_COUNTS) {
    reportConfig("streamed", fileCount);
  }

  console.log("--- BUFFERED (NOT what ships — measured only for contrast) ---");
  for (const fileCount of FILE_COUNTS) {
    reportConfig("buffered", fileCount);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
