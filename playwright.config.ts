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
// file and `e2e/global-setup.ts` for the full mechanism and its constraints
// (never production, no PNGs committed, no auth bypass in `src/`).
import { defineConfig } from "@playwright/test";

const PORT = 3300; // package.json:6 -- `next dev -p 3300`.
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // One shared dev server and one shared pair of seeded sessions across every
  // spec file -- running specs in parallel workers would mean two workers
  // racing to seed/rotate the SAME two session tokens in global-setup. This
  // harness runs a handful of specs a few times a day, never in CI (see
  // README below); trading worker parallelism for a boring, deterministic
  // seed step costs nothing that matters here.
  workers: 1,
  fullyParallel: false,
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
  // by design (see e2e/lib/refuse-on-production.ts) and never runs in CI, so
  // there is no CI-freshness case to guard against here.
  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
