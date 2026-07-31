// Task #165: the local visual-capture harness. `package.json` has declared
// `test:e2e` / `test:e2e:install` and installed `@playwright/test` since the
// project's initial scaffold, but nothing here ever existed until that task
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
//
// EVERYTHING THIS FILE DECIDES NOW LIVES IN `tooling/e2e-capture-config.ts`
// (task #177). That is not indirection for its own sake: three of the values
// it returns are load-bearing safety guarantees whose PREVIOUS settings each
// produced a well-formed screenshot of the WRONG thing (a sibling worktree's
// branch, or a 500 from `next dev` running under Node), and `vitest.config.ts`
// excludes `e2e/**` but not `tooling/**` -- so that module is the only place
// `bun run test` can assert them. This file keeps exactly one job: read the
// ambient facts (`process.cwd()`, `E2E_PORT`) that a pure builder must not
// read for itself.
import { defineConfig } from "@playwright/test";
import { buildCaptureHarnessConfig } from "./tooling/e2e-capture-config";

export default defineConfig(
  buildCaptureHarnessConfig({
    // `bun run test:e2e` (and a bare `bunx playwright test`) execute from the
    // package root, which in this repo is the worktree root -- the same anchor
    // `e2e/lib/fixtures.ts` has always used for `SCREENSHOT_DIR` and the
    // storage-state paths.
    worktreeRoot: process.cwd(),
    portOverride: process.env.E2E_PORT,
  }),
);
