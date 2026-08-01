import { describe, expect, it } from "vitest";
import { builtinEnvironments } from "vitest/runtime";

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
// `Event` -- on the SAME shared `globalThis` object every test file's worker
// reuses, saving whatever was there BEFORE (Bun's own native `CustomEvent`
// class) so `teardown()` can restore it. The moment a test FILE finishes,
// `teardown()` runs and restores that native `CustomEvent` immediately --
// there is no next file's `setup()` yet to reinstall a jsdom one. If Radix's
// deferred timer, from an unmount earlier in that file, is STILL PENDING at
// that instant (or fires afterwards, e.g. if this is the last file its
// worker runs), `new CustomEvent(...)` builds a Bun-NATIVE event object, and
// dispatching a native event on a jsdom `Element` fails jsdom's own
// `dispatchEvent` argument conversion (`Event.convert` in
// node_modules/jsdom/lib/generated/idl/EventTarget.js, which checks
// `value[implSymbol] instanceof Impl.implementation` -- true only for
// jsdom-constructed events) with EXACTLY the observed error:
// `TypeError: Failed to execute 'dispatchEvent' on 'EventTarget': parameter
// 1 is not of type 'Event'.`
//
// This is a genuine wall-clock race between Radix's timer and Vitest's own
// per-file teardown -- not a bug in any one test's assertions -- which is
// why it could not be pinned down by re-running the suite a handful of
// times (criterion #1's own trap). The reproduction below sidesteps the
// race entirely by driving both sides of it explicitly: it schedules the
// SAME kind of timer Radix schedules, then EITHER lets vitest's real jsdom
// `teardown()` run before the timer fires (reproducing the crash on demand,
// every time) OR drains the timer first via the exact guard now added to
// admin-asset-viewer.test.tsx, edit-gallery-terms-dialog.test.tsx and
// proof-lightbox.test.tsx's own `afterEach` blocks (proving the guard
// closes the race, every time).
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

    try {
      const container = (fakeGlobal.document as Document).createElement("div");
      (fakeGlobal.document as Document).body.appendChild(container);

      const pending = scheduleRadixStyleUnmountTimer(container);

      // THE BUG'S CONDITION: teardown runs (restoring the native
      // `CustomEvent`) BEFORE the leaked timer has a chance to fire -- this
      // is the "no afterEach flush" case that #205's branch hit 1/28 times.
      await teardown(fakeGlobal);

      const { threw } = await pending;

      expect(threw).not.toBeNull();
      expect(threw?.message).toBe(
        "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.",
      );
    } finally {
      // Best-effort: this file's own jsdom environment is already torn down
      // above (that is the point), so there is nothing further to restore.
    }
  });

  it("does not crash when the trailing timer is drained before teardown, the fix now applied to affected files", async () => {
    const jsdomEnv = builtinEnvironments.jsdom;
    const fakeGlobal = globalThis as Record<string, unknown>;
    const { teardown } = await jsdomEnv.setup(fakeGlobal, {});

    const container = (fakeGlobal.document as Document).createElement("div");
    (fakeGlobal.document as Document).body.appendChild(container);

    const pending = scheduleRadixStyleUnmountTimer(container);

    // THE FIX'S CONDITION: an `afterEach` that awaits one real macrotask
    // tick (same delay Radix uses: 0) BEFORE this file's environment ever
    // tears down -- exactly what was added to the three affected files'
    // `afterEach` blocks. FIFO ordering for equal-delay timers guarantees
    // Radix's callback (scheduled first, above) resolves before this one.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { threw } = await pending;
    expect(threw).toBeNull();

    await teardown(fakeGlobal);
  });
});
