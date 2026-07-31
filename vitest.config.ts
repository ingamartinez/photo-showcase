import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Mirrors the "@/*" -> "./src/*" path mapping in tsconfig.json so unit tests
// can use the same import alias as the rest of the app.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Vitest's default is 5000ms, which is tuned for unit tests that do no
    // real work. Several suites here deliberately do: `src/lib/images.test.ts`
    // and `src/app/api/assets/[assetId]/final/route.download.test.ts` run the
    // REAL sharp pipelines over multi-megapixel fixtures, because the
    // acceptance criteria they exist for are all of the form "verify the
    // actual bytes" (tasks #14, #26, #28, #89) — a mocked sharp could not
    // prove a watermark is present, or absent.
    //
    // That default was a latent trap, not a live failure, until task #89's CI
    // run hit it: `ubuntu-latest` measured ~5x slower than a dev machine on
    // this workload (a 2.5s local test took 12.8s and 14.1s there, twice,
    // deterministically), so a test can pass on every laptop in the project
    // and fail only in CI. Raising this globally rather than annotating the
    // ~8 sharp-heavy tests individually is deliberate: a per-test timeout is
    // a rule that has to be remembered, and it WILL be forgotten on the ninth
    // one. The next person to add a real-bytes test should not have to know
    // this exists.
    //
    // 30s is chosen against the measured worst case, not by taste: after the
    // fixture fix that landed with this change the slowest test in the suite
    // is ~1.66s locally (it was ~2.5s before), so this leaves headroom for
    // a runner several times slower again than the one observed. The real
    // backstop for a genuinely hung test remains the CI job's own
    // `timeout-minutes: 10` (.github/workflows/ci.yml) — the cost of this
    // setting is only that such a test takes 30s to report instead of 5s.
    //
    // `hookTimeout` is deliberately NOT raised. It was checked rather than
    // assumed: every expensive fixture in this repo is built inside an `it`
    // body (e.g. `seedGalleryAndAsset` in the download suite is called from
    // the tests, not from its `beforeEach`, whose own work is mock resets).
    // A hook that starts needing more than 5s is a signal worth keeping.
    testTimeout: 30_000,

    // Task #117: the agent harness that runs this board creates parallel
    // slices in git worktrees under .claude/worktrees/agent-<id>/, INSIDE
    // this repo. Vitest's default `exclude` is only
    // ["**/node_modules/**", "**/.git/**"] (verified against the installed
    // v4 `configDefaults` -- it does not skip dot-directories the way
    // TypeScript's own file matcher does), so a bare `bun run test` in the
    // main checkout would otherwise collect every sibling agent's test
    // files too, including code that is mid-implementation and legitimately
    // broken. That produces a result that depends on what OTHER agents
    // happen to have on disk, which is worse than a crash: it is a wrong
    // number that looks equally plausible whether it passed by accident or
    // failed for a reason that has nothing to do with the slice under test.
    //
    // `.claude/**` (not just `.claude/worktrees/**`) is deliberately the
    // broader match: it is what eslint.config.mjs already excludes for the
    // same reason, and matching it here means this stays correct if the
    // harness ever nests worktrees one level deeper under .claude/. The
    // sibling worktrees the repo's own convention creates on purpose
    // (/Users/alejo/projects/.photo-worktrees/lane-*) live OUTSIDE the repo
    // root and are never reachable by these glob patterns in the first
    // place, so they need no entry here.
    //
    // `configDefaults.exclude` is spread in explicitly rather than assuming
    // it stays untouched: setting `exclude` at all REPLACES vitest's
    // built-in default rather than appending to it, so omitting the spread
    // would silently stop skipping node_modules and .git too.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
