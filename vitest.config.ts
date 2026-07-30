import path from "node:path";
import { defineConfig } from "vitest/config";

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
    // 30s is chosen against the measured worst case, not by taste: the
    // slowest test in the suite is ~2.5s locally, so this leaves headroom for
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
  },
});
