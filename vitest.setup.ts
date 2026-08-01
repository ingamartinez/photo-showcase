import { afterEach } from "vitest";

// Task #207. Root cause (full writeup and deterministic reproduction in
// vitest.radix-focus-scope-timer-leak.test.ts): `@radix-ui/react-focus-scope`'s
// FocusScope unmount effect
// (node_modules/@radix-ui/react-focus-scope/dist/index.mjs:87-99) ALWAYS
// schedules an uncancelled `setTimeout(fn, 0)` on unmount -- regardless of
// `trapped` -- that constructs `new CustomEvent(...)` and dispatches it on
// the just-unmounted container. `setTimeout` is not among the globals
// Vitest's jsdom environment shadows and restores per file
// (node_modules/vitest/dist/chunks/index.DC7d2Pf8.js's `KEYS` list), so
// `dom.window.close()` in that environment's teardown cannot cancel it.
//
// If that timer survives past a test file's own jsdom teardown, Vitest has
// already restored `globalThis.CustomEvent` to whatever it was BEFORE that
// file's jsdom window installed itself (Bun's own native `CustomEvent`
// class -- `populateGlobal`'s saved "original"). The deferred callback then
// builds a NATIVE event and dispatches it on a jsdom `Element`, which fails
// jsdom's own `dispatchEvent` argument conversion
// (node_modules/jsdom/lib/generated/idl/EventTarget.js, `Event.convert`)
// with an uncaught exception: `TypeError: Failed to execute 'dispatchEvent'
// on 'EventTarget': parameter 1 is not of type 'Event'.` That is what made
// vitest exit 1 with the entire suite green (1654/1654 passing, "1 error"),
// measured at 1/28 full-suite runs on task #205's branch.
//
// THIS IS SUITE-WIDE, NOT ONE FILE: an earlier version of this fix drained
// the timer only in the three test files known to mount a Radix `Dialog`
// and unmount it. Instrumenting `globalThis.setTimeout` with a
// react-focus-scope stack-frame filter and measuring pending timers at
// `afterAll` across all 131 files found FOUR MORE Dialog-mounting files
// still leaking one pending timer each, not named in the original report
// (dashboard-gallery-create-dialog.test.tsx,
// dashboard-client-create-dialog.test.tsx,
// galleries/[galleryId]/page.chrome.test.tsx, galleries/page.chrome.test.tsx
// -- the last one transitively, via a Dialog mounted from page.tsx, which a
// text search for "Dialog" in the test file itself would miss). The
// mechanism is also not confined to Dialog at all: ANY Radix primitive that
// renders `<FocusScope>` carries the same unconditional timer (DropdownMenu,
// Select, Popover, ContextMenu, Menubar, HoverCard all depend on
// `@radix-ui/react-focus-scope` per bun.lock). A per-file drain is
// therefore not a reliable closure -- it is only ever a partial fix that
// moves the flake to whichever file was missed. Hence this hook, applied to
// every test in the suite rather than enumerated file by file.
//
// THE FIX: after every test, await one real macrotask tick. Radix's own
// timer and this one are both scheduled with delay 0, so FIFO ordering
// guarantees Radix's callback -- if any test just unmounted a
// FocusScope-bearing component -- runs first, draining it while this
// file's jsdom window is still installed, before Vitest ever gets a chance
// to tear it down.
//
// COST, MEASURED (not assumed) before landing this: full suite wall time,
// 5 runs each, `bun run test` end to end --
//   no per-test flush at all (task's pre-fix state):  8539/9281/9215/8861/8548 ms, avg 8889ms
//   this hook applied to all 131 files / 1743 tests:  8139/8383/8442/8430/8285 ms, avg 8336ms
// The "with" average is LOWER than "without" here -- i.e. the added
// macrotask tick is inside ordinary run-to-run noise on this suite, not a
// measurable cost. Comfortably under the 15% budget this decision was
// gated on.
// Task #207. Counts calls so a test can prove the `afterEach` registration
// below actually fires within a REAL running suite, rather than merely
// existing as an exported function nobody calls -- see
// vitest.radix-focus-scope-timer-leak.test.ts's "wiring" describe block.
// Deleting the `afterEach(flushPendingRealTimers)` line at the bottom of
// this file (while leaving the export in place) would leave this at 0
// forever and turn that test red; that is the point of tracking it.
let flushCallCount = 0;

export function flushPendingRealTimers(): Promise<void> {
  flushCallCount += 1;
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function getFlushCallCount(): number {
  return flushCallCount;
}

afterEach(flushPendingRealTimers);
