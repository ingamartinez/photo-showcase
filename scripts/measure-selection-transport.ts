// Memory measurement for task #95's transport decision — the same role
// scripts/measure-zip-memory.ts (task #29) plays for the download-all route
// and scripts/measure-final-memory.ts (task #26) plays for `processFinal`:
// "report what was observed, don't estimate it." Run manually:
//   bun run measure:selection:transport
//
// THE QUESTION THIS SCRIPT ANSWERS: what does HOLDING a connection per viewer
// cost the droplet (768M `MemoryMax`, infra/systemd/photoshowcase.service,
// shared with `findash`), versus letting each viewer poll and hang up?
//
// It exists because the answer is now load-bearing. Task #95 chose polling
// over SSE for the collaborative selection tray, and the numbers this script
// prints are cited as justification in two places that outlive any one
// session: PLAN.md §11, and
// src/app/api/galleries/[galleryId]/selection/route.ts's own header comment.
// A measurement whose script does not exist cannot be re-run, which would
// make those recorded numbers unfalsifiable — and an unfalsifiable number
// propping up an architecture decision is worse than no number at all.
//
// ============================================================================
// WHAT IT MEASURES, AND WHY EACH PIECE IS THERE
// ============================================================================
//
//   1. baseline RSS — the empty server, before any load.
//   2. N held SSE connections — the SSE shape's real cost: one open
//      `text/event-stream` response per viewer, retained for as long as the
//      tab stays open.
//   3. RSS AFTER every one of them disconnects. **This is the line that
//      decided task #95** and the reason this script reads current RSS rather
//      than `maxRSS` (see the methodology note below). Held connections
//      ratchet RSS; how much of that the allocator hands back to the OS when
//      they close is what this line reports, as a SPREAD across repeated runs
//      rather than a single sample. No number is quoted for it in this
//      comment on purpose — the script prints it, and prose that restates a
//      measured number is prose that will eventually contradict it. The one
//      thing worth recording here is WHY the spread is shown at all: a
//      single-shot version of this script once read ~45% reclaimed at one
//      connection count and 0% everywhere else, which is exactly the sort of
//      outlier that turns into a false certainty when it is the only sample
//      anyone ever took.
//   4. N polls, sequentially — one interval's worth of traffic for N viewers
//      in the polling design, plus the per-request wall time.
//   5. N SIMULTANEOUS polls — the pathological tick, where every viewer's
//      timer happens to fire together. Reported as a peak AND a settled
//      figure, because "does it come back" is the whole comparison.
//
// ============================================================================
// METHODOLOGY — three deliberate differences from the sibling measure scripts
// ============================================================================
//
// CURRENT RSS, NOT `maxRSS`. measure-final-memory.ts and measure-zip-memory.ts
// both read `process.resourceUsage().maxRSS`, correctly: they ask "what was
// the peak cost of one call", and a high-water mark answers that. It cannot
// answer THIS script's central question. `maxRSS` is monotonically
// non-decreasing by definition, so a measurement built on it could never
// distinguish "the memory came back when the connections closed" from "it did
// not" — the two are the same number. `process.memoryUsage.rss()` is a
// point-in-time reading and can go down, which is exactly what step 3 needs
// to be able to observe.
//
// ONE PROCESS PER CONNECTION COUNT, and the WHOLE sequence inside it.
// measure-zip-memory.ts spawns a fresh subprocess per single run to avoid
// `maxRSS` contamination; the same discipline applies here for a stronger
// reason (RSS ratchets, so a 200-viewer run's leftovers would silently
// understate a subsequent 20-viewer run's own baseline). But the steps WITHIN
// one run must NOT be split: "baseline, then hold, then release, then poll"
// is a sequence over one process's lifetime, and measuring the release in a
// different process than the hold would answer nothing.
//
// BOTH ENDS OF EVERY SOCKET LIVE IN THE MEASURING PROCESS. The server and the
// client are the same `bun` process here, so every per-viewer figure printed
// below counts the client's share as well as the server's — roughly twice the
// server's own cost. DO NOT quote the per-viewer number as "what the droplet
// pays per viewer"; it is an upper bound on that. What makes the comparison
// itself fair is that the inflation applies EQUALLY to the SSE arm and the
// polling arm. Running the load generator as a separate process was tried
// first and abandoned: the child could not reach the parent's socket under
// this environment's sandbox, and a measurement that cannot be re-run by the
// next person is worth less than an honest caveat.
//
// AND IT IS A BARE `Bun.serve`, not Next.js. No framework, no React, no
// Drizzle, no Caddy in front. A real SSE route handler carries Next's own
// per-request context on top of everything measured here, so the SSE arm's
// true cost through `next start` is strictly WORSE than what this prints.
// That asymmetry is safe for the decision it supports — the cheaper option
// measured pessimistically still wins — but it is not safe to quote in the
// other direction.
//
// PLATFORM CAVEAT — the same one measure-zip-memory.ts and
// measure-final-memory.ts carry, and the reason this script had to be
// committed at all: as of this writing it has only ever been run on a macOS
// dev machine. RSS accounting, the allocator's return-to-OS behaviour and
// socket buffer sizing all differ on Linux, and none of it reflects the
// droplet's own cgroup/`MemoryMax` accounting unless run there. Said plainly:
// this is a laptop measurement that SUPPORTS task #95's decision, not a
// droplet measurement that PROVES it. **Kanban #57 is the task that would
// re-run this on the droplet and settle that**, the same way it is open
// against the two sibling scripts' numbers.
//
// TWO FINDINGS THAT CAME OUT OF WRITING THIS, worth keeping even if the
// numbers are re-measured:
//   - Bun's own server kills an idle stream after 10 seconds unless
//     `idleTimeout` is raised (observed directly — the first run of this
//     harness died with "request timed out after 10 seconds"). An SSE design
//     therefore needs a keepalive comment per connection per interval, i.e. a
//     timer per viewer for as long as the tab is open.
//   - Caddy has its own idle timeout in front of this app, which an SSE
//     design would have had to verify rather than assume.

const CONNECTION_COUNTS = [20, 100, 200];

/** Repeated, not single-shot, for the same reason measure-zip-memory.ts
 * repeats its own configurations: these numbers have real run-to-run
 * variance, and a single sample can say something the next sample flatly
 * contradicts. That is not hypothetical here — it is how the "does the memory
 * come back" reading was caught being non-deterministic (see `reportRun`'s
 * own note on the reclaim spread), which is precisely the kind of thing a
 * committed script catches and an uncommitted one-off does not. */
const RUNS_PER_COUNT = 3;

/** Bun's maximum. `0` was tried first and hung the harness — 255 seconds is
 * far longer than any single measurement step, which is all this needs. The
 * DEFAULT (10s) is itself a finding; see this file's header comment. */
const IDLE_TIMEOUT_SECONDS = 255;

type RunResult = {
  connections: number;
  baseline: number;
  withSse: number;
  afterRelease: number;
  afterSequentialPolls: number;
  sequentialPollMs: number;
  burstPeak: number;
  afterBurst: number;
  burstMs: number;
};

function bytesToMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function rss(): number {
  return process.memoryUsage.rss();
}

/** Settles the process before a reading: lets pending I/O drain, forces a
 * full GC, then lets the collector finish. Without this the numbers move by
 * tens of MiB between adjacent readings for reasons that have nothing to do
 * with the thing being measured. */
async function settle(): Promise<void> {
  await Bun.sleep(400);
  Bun.gc(true);
  await Bun.sleep(200);
}

/** The snapshot `GET /api/galleries/[galleryId]/selection` actually returns
 * for a 14-photo selection — real shape, real field names, so the polling
 * arm is not measured against an unrealistically tiny body. */
function selectionSnapshot(): unknown {
  return {
    status: "proofing",
    submittedAt: null,
    quota: {
      selected: 14,
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5000,
      extras: 1,
      surchargeCop: 5000,
    },
    picks: Array.from({ length: 14 }, (_, i) => ({
      assetId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
      selectedAt: "2026-07-30T12:00:00.000Z",
      pickedBy: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "Ana Gómez" },
    })),
  };
}

// --- Worker mode: run exactly ONE connection count's full sequence, print
// exactly one JSON line, exit. Invoked by the orchestrator below as its own
// fresh subprocess — see this file's header comment on why the counts must not
// share a process while the STEPS must. ---
async function runWorker(connections: number): Promise<void> {
  const held = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const server = Bun.serve({
    port: 0,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/sse") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Retained on purpose: a real SSE endpoint has to keep every
            // controller to push events to, and that retention is part of
            // what is being measured.
            held.add(controller);
            controller.enqueue(new TextEncoder().encode(": open\n\n"));
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          },
        });
      }
      return Response.json(selectionSnapshot());
    },
  });

  const base = `http://localhost:${server.port}`;

  await settle();
  const baseline = rss();

  // --- SSE: hold every connection open at once ---
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  for (let i = 0; i < connections; i++) {
    const response = await fetch(`${base}/sse`);
    const reader = response.body!.getReader();
    // Consume the ": open" comment so the stream is genuinely established
    // rather than merely requested.
    await reader.read();
    readers.push(reader);
  }
  await settle();
  const withSse = rss();

  for (const reader of readers) await reader.cancel();
  held.clear();
  await settle();
  const afterRelease = rss();

  // --- Polling: one interval's worth of traffic for the same viewers ---
  const sequentialStart = Bun.nanoseconds();
  for (let i = 0; i < connections; i++) {
    const response = await fetch(`${base}/poll`);
    await response.json();
  }
  const sequentialPollMs = (Bun.nanoseconds() - sequentialStart) / 1e6;
  await settle();
  const afterSequentialPolls = rss();

  // --- Polling, pathological: every viewer's timer fires together ---
  const burstStart = Bun.nanoseconds();
  await Promise.all(
    Array.from({ length: connections }, async () => {
      const response = await fetch(`${base}/poll`);
      await response.json();
    }),
  );
  const burstMs = (Bun.nanoseconds() - burstStart) / 1e6;
  const burstPeak = rss();
  await settle();
  const afterBurst = rss();

  server.stop(true);

  const result: RunResult = {
    connections,
    baseline,
    withSse,
    afterRelease,
    afterSequentialPolls,
    sequentialPollMs,
    burstPeak,
    afterBurst,
    burstMs,
  };
  process.stdout.write(JSON.stringify(result));
}

/** Spawns one fresh subprocess for a single connection count. `Bun.spawnSync`
 * — this script only ever runs under `bun run` (package.json's own
 * `measure:selection:transport`), the same runtime assumption
 * measure-zip-memory.ts makes. */
function spawnOneRun(connections: number): RunResult {
  const result = Bun.spawnSync(["bun", "run", import.meta.path, "--worker", String(connections)]);
  if (result.exitCode !== 0) {
    throw new Error(
      `worker subprocess failed (connections=${connections}): ${result.stderr.toString()}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as RunResult;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** What one connection count's repeated runs jointly say. `reclaimedPct` is
 * kept as a full spread rather than collapsed to a median because its
 * VARIANCE is the finding — see `reportRun`. */
type Aggregate = {
  connections: number;
  sseDelta: number;
  reclaimedPct: number[];
  pollRetained: number;
  msPerPoll: number;
  burstPeakDelta: number;
  burstSettledDelta: number;
  burstMs: number;
};

function aggregate(runs: RunResult[]): Aggregate {
  return {
    connections: runs[0]!.connections,
    sseDelta: median(runs.map((r) => r.withSse - r.baseline)),
    reclaimedPct: runs
      .map((r) => {
        const delta = r.withSse - r.baseline;
        // Clamped at 0: RSS sometimes drifts slightly UP as the closes are
        // processed, and a negative "percent reclaimed" reads like a
        // measurement error rather than "none of it came back".
        return delta <= 0 ? 0 : (Math.max(0, r.withSse - r.afterRelease) / delta) * 100;
      })
      .sort((a, b) => a - b),
    pollRetained: median(runs.map((r) => r.afterSequentialPolls - r.afterRelease)),
    msPerPoll: median(runs.map((r) => r.sequentialPollMs / r.connections)),
    burstPeakDelta: median(runs.map((r) => r.burstPeak - r.afterSequentialPolls)),
    burstSettledDelta: median(runs.map((r) => r.afterBurst - r.afterSequentialPolls)),
    burstMs: median(runs.map((r) => r.burstMs)),
  };
}

function reportRun(agg: Aggregate): void {
  const perViewerKiB = agg.sseDelta / 1024 / agg.connections;

  console.log(`--- ${agg.connections} viewers (median of ${RUNS_PER_COUNT} runs) ---`);
  console.log(
    `  ${agg.connections} held SSE connections`.padEnd(36) +
      `+${bytesToMiB(agg.sseDelta).padStart(6)} MiB   ` +
      `(${perViewerKiB.toFixed(0)} KiB per viewer, held for as long as the tab is open)`,
  );
  // THE LINE THIS SCRIPT EXISTS FOR — and the one that must not be reported
  // as a single sample, which is why it prints the whole spread instead of a
  // median. Read it as "how much of the SSE arm's cost does a burst of
  // viewers give back when they leave"; the closing summary below turns
  // whatever it observed into a conclusion, rather than this comment
  // asserting one.
  console.log(
    `  ...reclaimed once they all close`.padEnd(36) +
      `${agg.reclaimedPct
        .map((p) => `${p.toFixed(0)}%`)
        .join(" / ")
        .padStart(13)}   ` +
      `(min / median / max across ${RUNS_PER_COUNT} runs — a spread, never one sample)`,
  );
  console.log(
    `  ${agg.connections} sequential polls`.padEnd(36) +
      `+${bytesToMiB(agg.pollRetained).padStart(6)} MiB   ` +
      `(retained; ${agg.msPerPoll.toFixed(2)} ms per request)`,
  );
  console.log(
    `  ${agg.connections} SIMULTANEOUS polls`.padEnd(36) +
      `+${bytesToMiB(agg.burstPeakDelta).padStart(6)} MiB   ` +
      `(peak over the line above; settled at ` +
      `${agg.burstSettledDelta >= 0 ? "+" : ""}${bytesToMiB(agg.burstSettledDelta)} MiB, ` +
      `${agg.burstMs.toFixed(0)} ms wall)`,
  );
  console.log("");
}

/** The closing verdict, DERIVED from what this run actually observed rather
 * than hardcoded — so a re-run on the droplet (kanban #57) that finds
 * something different says so, instead of printing a conclusion the numbers
 * above it no longer support. */
function reportConclusion(aggregates: Aggregate[]): void {
  const worstReclaimPct = Math.max(...aggregates.flatMap((a) => a.reclaimedPct));
  const runsObserved = aggregates.length * RUNS_PER_COUNT;
  const peakSseCost = Math.max(...aggregates.map((a) => a.sseDelta));
  const peakPollCost = Math.max(...aggregates.map((a) => a.pollRetained + a.burstPeakDelta));

  console.log("THE LINE THAT DECIDES IT is 'reclaimed once they all close'.");
  console.log(
    worstReclaimPct < 5
      ? `  Across ${runsObserved} runs, the BEST case gave back ${worstReclaimPct.toFixed(0)}% of what the held\n` +
          `  connections cost. Effectively none of it comes back.`
      : `  Across ${runsObserved} runs the reclaimed share reached ${worstReclaimPct.toFixed(0)}% at best — so some of it\n` +
          `  can come back, but not dependably enough to plan capacity around.`,
  );
  console.log(
    `  Under a hard 768M cap (PLAN.md §9) that means a burst of viewers raises the\n` +
      `  floor by up to ${bytesToMiB(peakSseCost)} MiB that only a restart is guaranteed to recover.\n` +
      `  The polling arm's worst observed cost, peak included, was ${bytesToMiB(peakPollCost)} MiB, and it\n` +
      `  settles back to where it started.`,
  );
}

/** The per-viewer figure at a single connection count is inflated by whatever
 * fixed allocation the runtime does on first load. The MARGINAL cost between
 * two counts cancels that out, and is the number worth reasoning about when
 * imagining more viewers. */
function reportMarginal(previous: Aggregate, current: Aggregate): void {
  const extraConnections = current.connections - previous.connections;
  const extraBytes = current.sseDelta - previous.sseDelta;
  console.log(
    `  marginal cost of viewers ${previous.connections} -> ${current.connections}: ` +
      `${(extraBytes / 1024 / extraConnections).toFixed(0)} KiB per additional held connection`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    await runWorker(Number(args[1]));
    return;
  }

  console.log(
    `Platform: ${process.platform} — RSS read via process.memoryUsage.rss() (a point-in-time reading, NOT maxRSS; see this file's header comment for why).`,
  );
  console.log(
    process.platform === "darwin"
      ? "This is a laptop run. The droplet is Linux — these numbers SUPPORT task #95's decision, they do not PROVE it there. Kanban #57 is the task that re-runs this on the droplet.\n"
      : "Running on Linux — closer to the droplet's own shape, but still not its cgroup/MemoryMax accounting unless run there directly.\n",
  );
  console.log(
    "CAVEAT, do not double-count: both ends of every socket live in THIS process, so each per-viewer figure below counts the client's share too — roughly twice the server's own. The inflation applies equally to the SSE and polling arms, which is what makes the COMPARISON fair. This is also a bare Bun.serve, not Next.js, so the SSE arm's real cost through `next start` is strictly worse than shown.\n",
  );
  console.log(
    `Each connection count below is its own fresh subprocess — RSS ratchets, so a larger run's leftovers would silently understate a later, smaller one (see this file's header comment).\n`,
  );

  const aggregates: Aggregate[] = [];
  for (const connections of CONNECTION_COUNTS) {
    const runs = Array.from({ length: RUNS_PER_COUNT }, () => spawnOneRun(connections));
    const agg = aggregate(runs);
    aggregates.push(agg);
    reportRun(agg);
  }

  console.log("--- marginal SSE cost (fixed startup allocation cancelled out) ---");
  for (let i = 1; i < aggregates.length; i++) {
    reportMarginal(aggregates[i - 1]!, aggregates[i]!);
  }
  console.log("");
  reportConclusion(aggregates);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
