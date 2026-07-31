import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_THEME_ALIASES } from "./tooling/app-theme-tokens.mjs";

// Task #175 — the regression test for GUARD 2, the `no-restricted-syntax` block
// in eslint.config.mjs that keeps the global `app-*` utilities inside the
// dashboard tree.
//
// WHY THIS FILE EXISTS. Guard 1 (src/app/globals.tokens.test.ts) is heavily
// mutation-tested. Guard 2 was not tested at all: deleting its entire config
// block left `bun run lint` and all 1228 tests green, so the only thing keeping
// the marketing site free of silently-transparent classes was nobody deleting a
// block of config. The task declares both guards as merge conditions; one of
// them was resting on nothing.
//
// WHY IT RUNS ESLINT INSTEAD OF READING THE CONFIG ARRAY. Asserting that
// `eslintConfig` contains an object whose selector matches some regex proves the
// rule is PRESENT, not that it FIRES — and the two came apart in this exact
// rule: the first version was present, well-formed, covered by a hand-run
// probe, and blind to `border-t-app-raised`. So this drives the real linter over
// real source text and asserts on the findings. It is slower than reading an
// array, and that is the price of the assertion meaning what its name says.
//
// The config is loaded from disk by ESLint itself, exactly as `bun run lint`
// loads it — this file does not import or reconstruct it.
const REPO_ROOT = __dirname;

// Paths are fixtures, not files: `lintText` resolves config (and ignores) by
// path without touching the filesystem, so nothing here is ever written.
const OUTSIDE = "src/components/leak-fixture.tsx";
const INSIDE_DASHBOARD_ROUTE = "src/app/dashboard/leak-fixture.tsx";
const INSIDE_DASHBOARD_COMPONENT = "src/components/dashboard-leak-fixture.tsx";
const MARKETING = "src/app/(marketing)/leak-fixture.tsx";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

/** The rule IDs ESLint reports for `source` when linted as `filePath`. */
async function ruleIdsFor(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, {
    filePath: path.join(REPO_ROOT, filePath),
    warnIgnored: false,
  });

  return (result?.messages ?? []).map((message) => message.ruleId ?? "<fatal>");
}

const RESTRICTED = "no-restricted-syntax";

describe("guard 2: app-* utilities are confined to the dashboard tree", () => {
  it("reports a leak in an ordinary component", async () => {
    // The premise of the whole guard. If this ever goes green-by-passing, the
    // block has been deleted or neutered.
    expect(await ruleIdsFor(`export const c = "bg-app-raised";`, OUTSIDE)).toContain(RESTRICTED);
  });

  it("reports a leak on the public marketing surface", async () => {
    // Where the defect actually costs something: `--app-raised` is undefined
    // here, so the declaration is invalid at computed-value time and the
    // element renders transparent with no error anywhere.
    expect(await ruleIdsFor(`export const c = "rounded-sm bg-app-raised";`, MARKETING)).toContain(
      RESTRICTED,
    );
  });

  it("reports a leak written as a template literal", async () => {
    // `cn()` call sites use plain strings today; a template literal is one
    // refactor away and slips past a `Literal`-only selector.
    expect(await ruleIdsFor("export const c = `flex ${1} lg:bg-app-raised`;", OUTSIDE)).toContain(
      RESTRICTED,
    );
  });

  // THE HOLE THE FIRST VERSION HAD, kept as five named cases rather than one.
  // That version listed the utility prefixes it knew about (`bg`, `text`,
  // `border`, …); every one of these compiles to a live rule through this
  // project's own postcss pipeline and none of them was matched. In a codebase
  // this border-heavy the sided `border-{t,b,l,r,x,y,s,e}-*` family is the one
  // that would actually have shipped.
  it.each([
    ["ring-offset-app-raised", "--tw-ring-offset-color"],
    ["inset-ring-app-raised", "--tw-inset-ring-color"],
    ["inset-shadow-app-raised", "--tw-inset-shadow-color"],
    ["border-t-app-raised", "border-top-color"],
    ["border-x-app-danger", "border-inline-color"],
    ["lg:hover:border-b-app-danger", "border-bottom-color"],
  ])("reports %s, which compiles to %s", async (className) => {
    expect(await ruleIdsFor(`export const c = "${className}";`, OUTSIDE)).toContain(RESTRICTED);
  });

  it.each(APP_THEME_ALIASES.map(({ alias }) => alias))(
    "reports every declared alias, including %s",
    async (alias) => {
      // Enumerated from globals.css, so an alias added there without being
      // added to the guard's alternation fails here rather than leaking.
      // `bg-` is only the probe; the rule is prefix-agnostic by design.
      expect(await ruleIdsFor(`export const c = "bg-${alias}";`, OUTSIDE)).toContain(RESTRICTED);
    },
  );

  it.each([OUTSIDE, MARKETING])("does not flag innocent strings in %s", async (filePath) => {
    // The reason the first version restricted itself to a prefix denylist. The
    // token-name anchoring makes the trade unnecessary: `baseline` is not a
    // token, and `sm` is not one either, so neither matches.
    const source = `export const c = ["my-app-name", "app-micro", "rounded-app-sm", "text-app-baseline"];`;

    expect(await ruleIdsFor(source, filePath)).not.toContain(RESTRICTED);
  });

  it.each([INSIDE_DASHBOARD_ROUTE, INSIDE_DASHBOARD_COMPONENT])(
    "allows the same class in %s",
    async (filePath) => {
      // The guard must not be a blanket ban: this is where the utilities are
      // FOR, and src/app/dashboard/layout.tsx uses them today.
      expect(
        await ruleIdsFor(`export const c = "bg-app-raised text-app-base";`, filePath),
      ).not.toContain(RESTRICTED);
    },
  );

  it("explains the failure instead of only naming the rule", async () => {
    // A `no-restricted-syntax` finding whose message is the raw selector is
    // unreadable, and this one fires on a class that LOOKS correct.
    const [result] = await eslint.lintText(`export const c = "bg-app-raised";`, {
      filePath: path.join(REPO_ROOT, OUTSIDE),
      warnIgnored: false,
    });
    const message = result?.messages.find((m) => m.ruleId === RESTRICTED)?.message ?? "";

    expect(message).toContain('[data-surface="app"]');
    expect(message).toContain("src/app/dashboard");
  });
});
