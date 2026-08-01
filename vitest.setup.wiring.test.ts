import { describe, expect, it } from "vitest";

// Task #207. Proves the WIRING, not the logic: that `vitest.config.ts`'s
// `setupFiles: ["./vitest.setup.ts"]` actually causes vitest to LOAD that
// file and run `afterEach(flushPendingRealTimers)` after every test in this
// file, suite-wide, rather than that hook merely existing, exported and
// unused.
//
// THIS FILE MUST NOT IMPORT ANYTHING FROM "./vitest.setup", NOT EVEN A
// CONSTANT. An earlier version of this test imported `getFlushCallCount`
// from there "just to read the counter" -- but importing a module EVALUATES
// it, and evaluating vitest.setup.ts is exactly what calls
// `afterEach(flushPendingRealTimers)` in the first place, registering it
// against THIS file's own root suite via the import itself. That made the
// counter move 0 -> 1 whether or not `setupFiles` actually wired the file
// in: deleting `setupFiles: ["./vitest.setup.ts"]` from vitest.config.ts
// entirely still passed both assertions (`2 passed (2)`, with `setup: 0ms`
// in the run output -- vitest never loaded the setup file at all). The key
// string below is therefore duplicated by hand, not imported, on purpose:
// `globalThis[FOCUS_SCOPE_FLUSH_COUNT_GLOBAL_KEY]` can only become defined
// if vitest itself loaded vitest.setup.ts through `setupFiles`, since
// nothing in this file's own module graph can set it.
const FOCUS_SCOPE_FLUSH_COUNT_GLOBAL_KEY = "__task207FocusScopeFlushCount";

function currentFlushCount(): number {
  const g = globalThis as unknown as Record<string, number | undefined>;
  return g[FOCUS_SCOPE_FLUSH_COUNT_GLOBAL_KEY] ?? 0;
}

describe("vitest.setup.ts wiring (task #207)", () => {
  // Captured during the synchronous "collect" phase, before any test body or
  // hook in this describe runs -- and, since test FILES run strictly
  // sequentially within a worker, after every hook from every file that ran
  // before this one. This deliberately does NOT assert an absolute value
  // (e.g. "starts at 0"): `globalThis` is shared across files in the same
  // worker, so other files' afterEach calls may have already moved this
  // counter by the time this file's tests are collected. Only the DELTA
  // produced by this file's own test below is under test.
  const countBeforeThisFilesOwnTests = currentFlushCount();

  it("is an ordinary test with no fake timers and no direct call to the flush function", () => {
    expect(true).toBe(true);
  });

  it("shows the counter strictly increased after the previous test's afterEach ran", () => {
    // Deleting `setupFiles: ["./vitest.setup.ts"]` from vitest.config.ts, or
    // deleting the `afterEach(flushPendingRealTimers)` registration inside
    // vitest.setup.ts, both leave this count unchanged and turn this red --
    // see task #207's report for the observed failures.
    expect(currentFlushCount()).toBeGreaterThan(countBeforeThisFilesOwnTests);
  });
});
