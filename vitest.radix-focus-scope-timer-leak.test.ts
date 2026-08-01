import { describe, expect, it } from "vitest";
import { builtinEnvironments } from "vitest/runtime";
import { flushPendingRealTimers } from "./vitest.setup";

// Task #207. `@radix-ui/react-focus-scope`'s FocusScope unmount effect
// (node_modules/@radix-ui/react-focus-scope/dist/index.mjs:87-99) ALWAYS
// schedules an uncancelled `setTimeout(fn, 0)` on unmount -- regardless of
// `trapped` -- that constructs `new CustomEvent(...)` and dispatches it on
// the just-unmounted container. This made vitest exit 1 with the entire
// suite green: 1654/1654 tests passing, "Errors 1 error", uncaught exception
// originating in src/components/admin-asset-viewer.test.tsx, measured at
// 1/28 full-suite runs on task #205's branch (0/14 on the merge-base, so not
// statistically attributable to that slice -- preexisting).
//
// ROOT CAUSE, reproduced deterministically below rather than left as a
// theory: Vitest's own jsdom environment install
// (node_modules/vitest/dist/chunks/index.DC7d2Pf8.js, `populateGlobal`)
// shadows a fixed list of window-ish globals -- including `CustomEvent` and
// `Event`, but NOT `setTimeout` -- on the SAME shared `globalThis` object
// every test file's worker reuses, saving whatever was there BEFORE (Bun's
// own native `CustomEvent` class) so `teardown()` can restore it. Because
// `setTimeout` itself is never shadowed, `dom.window.close()` in that
// teardown cannot cancel Radix's pending timer. The moment a test FILE
// finishes, `teardown()` runs and restores that native `CustomEvent`
// immediately -- there is no next file's `setup()` yet to reinstall a jsdom
// one. If Radix's deferred timer, from an unmount earlier in that file, is
// STILL PENDING at that instant (or fires afterwards, e.g. if this is the
// last file its worker runs), `new CustomEvent(...)` builds a Bun-NATIVE
// event object, and dispatching a native event on a jsdom `Element` fails
// jsdom's own `dispatchEvent` argument conversion (`Event.convert` in
// node_modules/jsdom/lib/generated/idl/EventTarget.js, which checks
// `value[implSymbol] instanceof Impl.implementation` -- true only for
// jsdom-constructed events) with EXACTLY the observed error:
// `TypeError: Failed to execute 'dispatchEvent' on 'EventTarget': parameter
// 1 is not of type 'Event'.`
//
// This is a genuine wall-clock race between Radix's timer and Vitest's own
// per-file teardown -- not a bug in any one test's assertions -- which is
// why it could not be pinned down by re-running the suite a handful of
// times (criterion #1's own trap), and why it is not confined to any one
// test file: measuring pending react-focus-scope timers at `afterAll`
// across the whole suite found it leaking from Dialog-mounting files well
// beyond the ones this task started with (see vitest.setup.ts). The
// reproduction below sidesteps the race entirely by driving both sides of
// it explicitly: it schedules the SAME kind of timer Radix schedules, then
// EITHER lets vitest's real jsdom `teardown()` run before the timer fires
// (reproducing the crash on demand, every time) OR drains it first via the
// REAL `flushPendingRealTimers` export vitest.setup.ts wires into every
// test's `afterEach` (proving the shipped fix, not a copy of it, closes the
// race, every time).
async function scheduleRadixStyleUnmountTimer(container: Element) {
  return new Promise<{ threw: Error | null }>((resolve) => {
    setTimeout(() => {
      try {
        const unmountEvent = new (
          globalThis as unknown as { CustomEvent: typeof CustomEvent }
        ).CustomEvent("focusScope.autoFocusOnUnmount", { bubbles: false, cancelable: true });
        container.dispatchEvent(unmountEvent);
        resolve({ threw: null });
      } catch (err) {
        resolve({ threw: err as Error });
      }
    }, 0);
  });
}

describe("the Radix FocusScope trailing-timer race (task #207)", () => {
  it("reproduces the exact observed crash when the timer survives past this file's own jsdom teardown", async () => {
    const jsdomEnv = builtinEnvironments.jsdom;
    const fakeGlobal = globalThis as Record<string, unknown>;
    const { teardown } = await jsdomEnv.setup(fakeGlobal, {});

    const container = (fakeGlobal.document as Document).createElement("div");
    (fakeGlobal.document as Document).body.appendChild(container);

    const pending = scheduleRadixStyleUnmountTimer(container);

    // THE BUG'S CONDITION: teardown runs (restoring the native
    // `CustomEvent`) BEFORE the leaked timer has a chance to fire -- this
    // is the "no afterEach flush" case that #205's branch hit 1/28 times.
    // `teardown` here is a plain (non-timer-yielding) function, so calling
    // it does not itself give the macrotask queue a turn -- the leaked
    // timer genuinely has not fired yet at this point.
    await teardown(fakeGlobal);

    const { threw } = await pending;

    expect(threw).not.toBeNull();
    expect(threw?.message).toBe(
      "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.",
    );
  });

  it("does not crash when flushPendingRealTimers (the real, shipped fix) drains the timer before teardown", async () => {
    const jsdomEnv = builtinEnvironments.jsdom;
    const fakeGlobal = globalThis as Record<string, unknown>;
    const { teardown } = await jsdomEnv.setup(fakeGlobal, {});

    const container = (fakeGlobal.document as Document).createElement("div");
    (fakeGlobal.document as Document).body.appendChild(container);

    const pending = scheduleRadixStyleUnmountTimer(container);

    // THE FIX'S CONDITION, exercised through the ACTUAL exported function
    // vitest.setup.ts registers via `afterEach` -- not a reimplementation of
    // it -- so a regression in that function's behaviour fails THIS test.
    // Radix's own timer (above) and this one are both scheduled with delay
    // 0, so FIFO ordering guarantees Radix's callback resolves first.
    await flushPendingRealTimers();

    // `teardown` is called BEFORE awaiting `pending`, deliberately: awaiting
    // `pending` first would itself wait for Radix's timer to settle
    // regardless of whether the flush above ever ran, making this assertion
    // pass unconditionally -- exactly the vacuous shape task #207's review
    // caught here (mutation: commenting out the `flushPendingRealTimers()`
    // call above previously left this test green; it now goes red, see the
    // task's report for the observed failure). Only the ordering below --
    // teardown immediately after the flush, `pending` read out afterwards --
    // makes whether Radix's callback already ran the thing under test.
    await teardown(fakeGlobal);

    const { threw } = await pending;
    expect(threw).toBeNull();
  });
});

// NOTE: the WIRING half of this fix -- that `vitest.config.ts`'s
// `setupFiles: ["./vitest.setup.ts"]` actually causes vitest to invoke
// `afterEach(flushPendingRealTimers)` for every test -- is deliberately NOT
// checked in this file. Both tests above call `flushPendingRealTimers`
// directly, which would make any "the counter is nonzero" assertion here
// pass regardless of whether the real `afterEach` registration exists,
// exactly the kind of vacuous check task #207's own review caught once
// already. See vitest.setup.wiring.test.ts, which contains no such direct
// call, for that proof.
