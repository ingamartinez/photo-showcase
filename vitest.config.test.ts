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
  it("aliases `server-only` to the inert stub, so JSDOM suites can import server modules", () => {
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
