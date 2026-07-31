// Task #165: the local visual-capture harness. `package.json` has declared
// `test:e2e` / `test:e2e:install` and installed `@playwright/test` since the
// project's initial scaffold, but nothing here ever existed until this task
// -- `bun run test:e2e` failed for lack of config, not for any actual test
// failure.
//
// SCOPE, DELIBERATELY NARROW: this is a screenshot harness for the two
// design epics (#125 admin, #140 client), not a behavioral regression suite.
// It seeds two authenticated sessions (see `e2e/global-setup.ts`) and hands
// downstream specs `e2e/capture.ts`'s `captureScreen()` helper. See that
// file, `e2e/global-setup.ts`, and `e2e/README.md` for the full mechanism,
// its local-only env prerequisites, and its constraints (never production,
// no PNGs committed, no auth bypass in `src/`).
import { defineConfig } from "@playwright/test";

const PORT = 3300; // package.json:6 -- `next dev -p 3300`.
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // NO `workers`/`fullyParallel` override here -- an earlier version of this
  // config pinned `workers: 1` on the theory that parallel workers would
  // race each other seeding the two session tokens in `globalSetup`. That
  // reasoning was WRONG and the #165 review caught it: Playwright always
  // runs `globalSetup` exactly ONCE per invocation, before any worker
  // starts, regardless of the configured worker count -- by the time
  // workers exist, the two `storageState` files are already written and
  // read-only for the rest of the run. Verified directly: `bunx playwright
  // test --workers=4 --fully-parallel` passes the same 4 specs Playwright's
  // own defaults would run serially. Leaving this unset means downstream
  // lanes (~17 slices across #125/#140) get Playwright's normal
  // parallelism as this suite grows, instead of inheriting a restriction
  // that never did anything.
  reporter: "list",
  use: {
    baseURL: BASE_URL,
  },
  globalSetup: "./e2e/global-setup.ts",
  // Reuses whatever `bun run dev` a lane already has open on :3300 instead of
  // fighting it for the port -- task #165's own instruction, so several
  // lanes working in parallel worktrees don't each try to bind the same
  // port. `reuseExistingServer` is unconditional (not gated on `!process.env
  // .CI`, the usual Playwright template default): this harness is LOCAL-ONLY
  // by design (see tooling/refuse-on-production.ts) and never runs in CI, so
  // there is no CI-freshness case to guard against here.
  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
