import { configDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";
import vitestConfig from "./vitest.config";

// Task #117: this guard exists so the .claude/** exclusion cannot be lost
// silently -- e.g. by a future edit that replaces the `exclude` array
// wholesale (which is exactly how it would have been dropped without this
// test: `exclude` REPLACES vitest's built-in default rather than merging
// with it, so a well-meaning "let me tidy this array" edit is one line away
// from reintroducing the bug this config change fixes). A glob-matching
// library could assert the pattern actually matches a worktree path, but
// nothing in this project's dependency tree provides that as a DIRECT
// dependency (picomatch is only present transitively, via vite/vitest), and
// pulling one in for a single assertion would be adding a library for a
// test the config's own shape can already prove.
describe("vitest.config.ts exclude", () => {
  it("excludes .claude/** so agent-harness worktrees under .claude/worktrees/ are never collected", () => {
    expect(vitestConfig.test?.exclude).toContain(".claude/**");
  });

  it("still excludes everything vitest excludes by default", () => {
    // `exclude` in the config REPLACES vitest's default, it does not merge
    // with it -- so this also guards against silently losing the
    // node_modules/.git exclusion the same way #117 lost the .claude one.
    for (const defaultPattern of configDefaults.exclude) {
      expect(vitestConfig.test?.exclude).toContain(defaultPattern);
    }
  });
});

// Task #31: the same guard, for the same reason, over the `server-only` alias
// -- without it a JSDOM (`*.chrome.test.tsx`) suite cannot import ANY module
// carrying `import "server-only"`, which since #31 includes the client gallery
// pages themselves. Losing this entry does not degrade gracefully: it breaks
// those suites at transform time with a resolution error that reads like a
// missing dependency, which is a long way from its actual cause. See the
// alias's own comment in vitest.config.ts.
describe("vitest.config.ts server-only alias", () => {
  // WHAT THIS CHECK REACHES, and what it does not — disclosed here rather than
  // implied by the test's name (kanban #118 is open against an earlier test in
  // this same file for exactly that omission). This is a STATIC assertion on
  // the config object: it proves the entry is present and still points at the
  // stub. It cannot prove the CONSEQUENCE — that a JSDOM suite can therefore
  // import a marker-carrying module — because that is transform-time
  // behaviour, and nothing about a string in a config object demonstrates it.
  // The consequence is asserted, unavoidably, by every `*.chrome.test.tsx`
  // suite that imports one: src/app/galleries/page.chrome.test.tsx and
  // src/app/galleries/[publicSlug]/page.chrome.test.tsx both fail at transform
  // time with `Failed to resolve import "server-only"` if this entry is
  // removed. That is the real proof; this test only stops the entry from being
  // deleted with a plausible-looking green run in files nobody re-reads.
  it("keeps the `server-only` entry pointing at the inert stub", () => {
    const alias = vitestConfig.resolve?.alias as Record<string, string> | undefined;

    expect(alias?.["server-only"]).toContain("vitest.server-only-stub");
  });

  // The alias entry above is added to the SAME object that carries the "@" ->
  // ./src mapping every suite in this repo imports through, so this asserts
  // the addition did not replace it.
  it("still aliases `@` to ./src", () => {
    const alias = vitestConfig.resolve?.alias as Record<string, string> | undefined;

    expect(alias?.["@"]).toContain("src");
  });
});

// Task #207. `setupFiles` is what actually wires vitest.setup.ts's
// `afterEach(flushPendingRealTimers)` into every test file, suite-wide --
// see vitest.setup.ts for why a per-file drain was not a reliable closure.
// This is a STATIC assertion, same limits as the `server-only` alias guard
// above: it proves the entry is present, not that vitest actually calls the
// hook for every test. That behavioural half is covered separately, by
// vitest.radix-focus-scope-timer-leak.test.ts importing and mutation-testing
// `flushPendingRealTimers` itself. Losing this ENTRY (e.g. a future edit
// that replaces `setupFiles` wholesale to add an unrelated file) would
// silently stop the hook from running anywhere, with no failing test to
// say so except a flake nobody can attribute for another ~28 runs.
describe("vitest.config.ts setupFiles", () => {
  it("wires vitest.setup.ts in, so the focus-scope timer drain actually runs", () => {
    expect(vitestConfig.test?.setupFiles).toContain("./vitest.setup.ts");
  });
});
