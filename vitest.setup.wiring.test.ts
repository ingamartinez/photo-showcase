import { describe, expect, it } from "vitest";
import { getFlushCallCount } from "./vitest.setup";

// Task #207. Proves the WIRING, not the logic: that `vitest.config.ts`'s
// `setupFiles: ["./vitest.setup.ts"]` actually causes vitest to invoke
// `afterEach(flushPendingRealTimers)` after every test, suite-wide, rather
// than that function merely existing, exported and unused.
//
// This is a SEPARATE file from vitest.radix-focus-scope-timer-leak.test.ts
// on purpose: that file's own tests call `flushPendingRealTimers` directly
// to exercise its logic, which would make "the counter is nonzero" trivially
// true here regardless of whether the real `afterEach` registration exists.
// Neither test below calls it directly -- each test file gets its own fresh
// module instance (vitest "inlines" source files rather than sharing them
// across files), so this file's own import of vitest.setup.ts starts
// `flushCallCount` at exactly 0, and the ONLY thing that can move it is a
// REAL `afterEach` firing after the first test below.
describe("vitest.setup.ts wiring (task #207)", () => {
  it("starts at 0 -- this file's own import has not triggered any afterEach yet", () => {
    expect(getFlushCallCount()).toBe(0);
  });

  it("is 1 by now, proving THIS file's own afterEach (wired in via setupFiles) fired once after the previous test", () => {
    // Deleting `afterEach(flushPendingRealTimers)` from vitest.setup.ts
    // (while leaving the function exported, so the import above still
    // resolves) leaves this at 0 forever and turns this red -- see task
    // #207's report for the observed failure.
    expect(getFlushCallCount()).toBe(1);
  });
});
