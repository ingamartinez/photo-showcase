// Builds the Playwright configuration for the local visual-capture harness.
//
// WHY THIS IS A FUNCTION IN `tooling/` AND NOT LITERAL OBJECT IN
// `playwright.config.ts`: three properties of that config are load-bearing
// safety guarantees (task #177), and a safety guarantee nobody can write a
// test against is a comment, not a guarantee. `vitest.config.ts` excludes
// `e2e/**` but not `tooling/**`, so this is the one place the config's own
// invariants can be asserted by `bun run test`. `playwright.config.ts` keeps
// exactly one job: hand this function the ambient facts it must not read for
// itself.
import type { PlaywrightTestConfig } from "@playwright/test";
import { captureHarnessPort } from "./e2e-worktree";

export interface CaptureHarnessConfigInput {
  /** Absolute path of the worktree this run belongs to -- normally `process.cwd()`. */
  worktreeRoot: string;
  /** Raw `E2E_PORT`, if the developer set one. Validated by `captureHarnessPort`. */
  portOverride?: string;
}

export function buildCaptureHarnessConfig(input: CaptureHarnessConfigInput): PlaywrightTestConfig {
  const port = captureHarnessPort(input.worktreeRoot, input.portOverride);
  const baseURL = `http://localhost:${port}`;

  return {
    testDir: "./e2e",
    // NO `workers`/`fullyParallel` override here -- an earlier version of this
    // config pinned `workers: 1` on the theory that parallel workers would
    // race each other seeding the two session tokens in `globalSetup`. That
    // reasoning was WRONG and the #165 review caught it: Playwright always
    // runs `globalSetup` exactly ONCE per invocation, before any worker
    // starts, regardless of the configured worker count -- by the time
    // workers exist, the two `storageState` files are already written and
    // read-only for the rest of the run. Note that #177's race was BETWEEN
    // Playwright invocations in different worktrees, never between workers of
    // one invocation, so nothing about that fix argues for restricting
    // parallelism here either.
    reporter: "list",
    use: { baseURL },
    globalSetup: "./e2e/global-setup.ts",
    webServer: {
      // `--bun`, not plain `bun run dev` (task #177, found by #145): without
      // it `bun run` hands `next dev` to NODE, where the `Bun` global does not
      // exist. `src/lib/r2.ts` builds every presigned URL with
      // `Bun.S3Client`, so under Node any page that renders a single asset
      // 500s with `ReferenceError: Bun is not defined` -- which is exactly the
      // set of pages the design epics need populated screenshots of.
      // Production never had this problem (`infra/systemd/
      // photoshowcase.service` starts `bun server.js`), which is why it went
      // unnoticed for so long.
      //
      // `--port ${port}` is appended AFTER `package.json`'s `dev` script has
      // already said `-p 3300`; verified empirically that `next dev`'s
      // argument parser takes the last occurrence (`next dev -p 3300 --port
      // 41999` binds 41999), so this overrides the script without needing to
      // edit `package.json`, which other lanes share.
      command: `bun --bun run dev --port ${port}`,
      url: baseURL,
      // FALSE, DELIBERATELY, AND THIS IS THE #177 FIX. It used to be `true`,
      // with a comment explaining that parallel worktrees should not fight
      // over :3300. The trouble is that `reuseExistingServer` does not check
      // WHOSE server it found: with every lane on the same port, a run would
      // silently attach to a sibling worktree's dev server and produce a
      // well-formed screenshot OF ANOTHER BRANCH. #130 confirmed it by
      // reading each listening PID's `cwd`; #143 found the same thing
      // independently.
      //
      // The port is now derived per worktree (see `captureHarnessPort`), so
      // there is nothing left to fight over -- and with reuse off, a port that
      // IS somehow occupied makes Playwright fail loudly ("already used")
      // instead of quietly capturing someone else's work. That is the whole
      // point: this harness's output is the acceptance evidence for two design
      // epics, so a wrong capture is worse than no capture.
      //
      // What this costs: a cold `next dev` per invocation instead of attaching
      // to a warm one (~1-2s with Turbopack, measured). What it buys: the
      // screenshot is of the branch that asked for it. Not a close call.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  };
}
