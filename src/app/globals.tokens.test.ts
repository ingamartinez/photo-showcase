import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_FONT_SIZES } from "@/lib/utils";
import { parseAppThemeAliases } from "../../tooling/app-theme-tokens.mjs";

// Task #127 — the wiring test for the shadcn primitives.
//
// WHY THIS COMPILES CSS INSTEAD OF RENDERING COMPONENTS. The defect this
// slice fixed is invisible to a React test: `bg-popover` is a perfectly
// ordinary string in a className whether or not Tailwind has any idea what
// `popover` is. Before the mapping fix, `.bg-popover` compiled to NOTHING —
// no rule emitted at all — so a DialogContent would have rendered as a
// transparent modal while every `toHaveClass("bg-popover")` assertion in the
// world stayed green. The only place that failure is observable is the
// generated stylesheet, so that is what this file inspects.
//
// WHAT IS AND IS NOT THE REAL FILE. The stylesheet under test IS
// src/app/globals.css, read from disk, verbatim — the `@theme inline` block,
// the `:root` aliases and the `[data-surface="app"]` layer are all the
// shipping ones. The ONLY edit made here is to Tailwind's SOURCE DETECTION:
// `@import "tailwindcss"` is rewritten to `source(none)` plus an explicit
// `@source inline(...)` candidate list. That is deliberate and it is not a
// weakening — automatic detection would crawl the repo, which makes the
// result depend on whatever OTHER agent worktrees happen to have on disk
// (the same hazard vitest.config.ts's `.claude/**` exclusion exists for),
// and it would let a token pass for the accidental reason that some
// unrelated file happened to mention it. Naming the candidates makes the
// assertion say exactly what it means: "given this class, does this
// stylesheet produce a rule for it".
const GLOBALS = path.resolve(__dirname, "./globals.css");
const BUTTON = path.resolve(__dirname, "../components/ui/button.tsx");
const DROPDOWN_MENU = path.resolve(__dirname, "../components/ui/dropdown-menu.tsx");

// The two ink-on-brass values, pinned BY VALUE rather than only by plumbing.
// An earlier revision of this file asserted only that `text-accent-foreground`
// resolved to `var(--accent-foreground)` and that the alias was declared —
// which stayed green when the alias was mutated back to `var(--fg)`, i.e.
// through the exact 2.02:1-on-brass defect this slice exists to remove. A
// chain that is correctly connected to the wrong colour is still wrong.
const INK = "#14100a";

// Every semantic colour name referenced by the primitives installed in this
// slice (button, table, dialog, dropdown-menu, badge, input, label), paired
// with the value it must resolve to. `bg-*` is the probe because it exists
// for every colour; a name Tailwind has no entry for emits no rule at all.
const SEMANTIC_COLORS: ReadonlyArray<readonly [name: string, resolvesTo: string]> = [
  ["background", "var(--background)"],
  ["foreground", "var(--foreground)"],
  ["border", "var(--border)"],
  ["input", "var(--input)"],
  ["ring", "var(--ring)"],
  ["muted", "var(--muted)"],
  ["muted-foreground", "var(--muted-foreground)"],
  ["primary", "var(--primary)"],
  ["primary-foreground", "var(--primary-foreground)"],
  ["secondary", "var(--secondary)"],
  ["secondary-foreground", "var(--secondary-foreground)"],
  ["popover", "var(--popover)"],
  ["popover-foreground", "var(--popover-foreground)"],
  ["destructive", "var(--destructive)"],
  ["accent-foreground", "var(--accent-foreground)"],
  // The brand accent, NOT a shadcn-shaped neutral. See the collision note in
  // globals.css; pinned here so re-pointing it has to be a conscious act.
  ["accent", "var(--accent)"],
];

// Arbitrary-value utilities the generated primitives use, which reach for
// custom properties DIRECTLY rather than through a `--color-*` entry.
const RAW_PROPERTY_CANDIDATES = [
  "hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
  "rounded-[min(var(--radius-md),10px)]",
];

// --- Task #175: the app-surface @theme aliases -----------------------------
//
// GUARD 1 OF TWO, and the change is not defensible without both. A `@theme`
// entry is GLOBAL: `bg-app-raised` is a valid class on the marketing site too,
// where `--app-raised` is undefined. What keeps that survivable is that the
// compiled rule must be `background-color: var(--app-raised)` — a reference,
// not a value — so a leak outside `[data-surface="app"]` is invalid at
// computed-value time (inert, greppable) instead of painting the wrong thing.
// The moment an entry's right-hand side stops being a `var()`, Tailwind inlines
// the LITERAL, the scope can no longer reach it, and the alias quietly becomes
// a second source of truth. That is what this block makes impossible to do
// silently. (Guard 2 is the `no-restricted-syntax` rule in eslint.config.mjs,
// which keeps these classnames out of every file that is not the dashboard.)
//
// THE LIST IS PARSED OUT OF globals.css, NOT WRITTEN DOWN HERE, and that is the
// whole difference between this guard and a decorative one. The first version
// of this block enumerated four colour names by hand. Appending a FIFTH entry
// with a literal right-hand side — `--color-app-brass: #b08b4f` — left it at 41
// passed, 41 green, while Tailwind emitted `.bg-app-brass{background-color:
// #b08b4f}`: a global utility the scope can never reach, i.e. precisely the
// defect the paragraph above claims is impossible. A guard that only covers the
// names someone remembered to list is a guard against nothing in particular.
// Every assertion below now enumerates whatever the stylesheet declares.
const APP_ALIASES = parseAppThemeAliases(readFileSync(GLOBALS, "utf8"));

// The compiled utility each alias must produce: `--color-app-raised` reaches
// the browser as `.bg-app-raised`, `--text-app-base` as `.text-app-base`.
const PROBE_BY_NAMESPACE = {
  color: { candidate: (alias: string) => `bg-${alias}`, property: "background-color" },
  text: { candidate: (alias: string) => `text-${alias}`, property: "font-size" },
} as const;

const APP_ALIAS_CASES = APP_ALIASES.map(
  (entry) =>
    [
      PROBE_BY_NAMESPACE[entry.namespace].candidate(entry.alias),
      PROBE_BY_NAMESPACE[entry.namespace].property,
      entry.value,
    ] as const,
);

// The trap this slice was told not to walk into, kept mechanical: radii must
// NOT get `@theme` entries. `--app-radius*` exists because `--radius-*` are
// frozen literals; a `rounded-app-*` utility reopens that settled argument.
const APP_FORBIDDEN_CANDIDATES = ["rounded-app-sm", "rounded-app"];

// One compile, shared by every assertion below. Deliberately not one per
// test: @tailwindcss/postcss caches its compiled design system against the
// `from` path, so a second `process()` with the same path silently reuses
// the FIRST call's candidate set — which produced a test that failed while
// the stylesheet was correct.
let css = "";

beforeAll(async () => {
  const source = readFileSync(GLOBALS, "utf8");

  expect(source).toContain('@import "tailwindcss";');
  const candidates = [
    ...SEMANTIC_COLORS.map(([name]) => `bg-${name}`),
    ...RAW_PROPERTY_CANDIDATES,
    ...APP_ALIAS_CASES.map(([candidate]) => candidate),
    ...APP_FORBIDDEN_CANDIDATES,
  ];
  const pinned = source.replace(
    '@import "tailwindcss";',
    `@import "tailwindcss" source(none);\n@source inline("${candidates.join(" ")}");`,
  );

  css = (await postcss([tailwind()]).process(pinned, { from: GLOBALS })).css;
});

/**
 * The declaration block of the plain (unmodified, non-variant) rule for
 * `.className`, or `undefined` when Tailwind emitted no rule for it — which
 * is precisely the failure mode an unmapped colour token produces.
 */
function ruleBody(className: string): string | undefined {
  const escaped = className.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

/**
 * Every `:root` declaration block in the OUTPUT, concatenated — Tailwind
 * emits its own `:root, :host` theme block ahead of this file's, so reading
 * only the first one reads the wrong block.
 */
function rootDeclarations(): string {
  const blocks = [...css.matchAll(/:root[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  expect(blocks.length, "no :root block in the compiled stylesheet").toBeGreaterThan(0);
  return blocks.join("\n");
}

describe("shadcn semantic colour tokens compile to real rules", () => {
  it.each(SEMANTIC_COLORS)("emits .bg-%s resolving to %s", (name, resolvesTo) => {
    const body = ruleBody(`bg-${name}`);

    // Not a bare toBeDefined(): name the missing token in the failure, or a
    // red run here reads as "undefined is not defined".
    expect(body, `Tailwind emitted no rule for .bg-${name}`).toBeDefined();
    expect(body).toContain(`background-color: ${resolvesTo}`);
  });

  it("declares every alias those utilities point at, so none is a dangling var()", () => {
    // A `--color-x: var(--x)` entry with no `--x` declared anywhere compiles
    // to a rule that LOOKS right and paints nothing. This walks the chain the
    // other way: each alias must exist in :root with a value.
    const root = rootDeclarations();

    for (const [name] of SEMANTIC_COLORS) {
      expect(root, `--${name} is referenced by a utility but never declared`).toMatch(
        new RegExp(`(^|[^-\\w])--${name}:\\s*\\S`, "m"),
      );
    }
  });

  it("pins the ink-on-brass values, not just the plumbing that carries them", () => {
    // --accent-foreground and --primary-foreground are the only two colours in
    // the mapping whose whole reason to exist is a contrast ratio, so they are
    // asserted by VALUE. #14100a on #c8a15a is 7.85:1; the `var(--fg)` these
    // used to fall back to is 2.02:1 on the same brass. Nothing else in this
    // file can tell those two apart.
    const root = rootDeclarations();

    expect(root).toMatch(new RegExp(`--accent-foreground:\\s*${INK}`, "i"));
    expect(root).toMatch(new RegExp(`--primary-foreground:\\s*${INK}`, "i"));
  });
});

describe("app-surface aliases stay references, so the scope can still reach them", () => {
  /** The base (non-media-query) `[data-surface="app"]` declaration block. */
  function appLayer(): string {
    const layer = /\[data-surface="app"\]\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(layer, 'no [data-surface="app"] block in the compiled stylesheet').toBeDefined();
    return layer as string;
  }

  it("finds aliases to check at all, so an empty list cannot pass vacuously", () => {
    // `it.each([])` reports zero tests and a green file. Every assertion below
    // is generated from APP_ALIASES, so the parser returning nothing would make
    // this whole guard disappear rather than fail.
    expect(APP_ALIASES.length, "parsed no app-* aliases out of globals.css").toBeGreaterThanOrEqual(
      APP_FONT_SIZES.length + 1,
    );
  });

  it.each(APP_ALIAS_CASES)(
    "declares .%s with a var() reference, never an inlined literal (%s: %s)",
    (candidate, _property, value) => {
      // THE ASSERTION THE HAND-WRITTEN LIST COULD NOT MAKE. Checked on the
      // stylesheet's own right-hand side, before Tailwind is involved at all:
      // a literal here (`#b08b4f`) is inlined into the utility and the scope
      // can never reach it.
      expect(
        value,
        `${candidate} resolves to ${value}, which is not a var(--app-*) reference`,
      ).toMatch(/^var\(--app-[a-z0-9-]+\)$/);
    },
  );

  it.each(APP_ALIAS_CASES)("compiles .%s to %s: %s", (candidate, property, value) => {
    const body = ruleBody(candidate);

    expect(body, `Tailwind emitted no rule for .${candidate}`).toBeDefined();
    // Whole declaration, not `toContain`: that would also pass on
    // `var(--app-ground, #070709)`, and — for the `text-` probes — it pins the
    // PROPERTY too, since `--text-*` and `--color-*` share the `text-` prefix
    // and getting the namespace wrong yields a rule that exists and is wrong.
    expect(body?.trim()).toBe(`${property}: ${value};`);
  });

  it("points every alias at a property the app scope actually declares", () => {
    // The other half of the chain. A `--color-app-x: var(--app-x)` entry with
    // no `--app-x` in the scope compiles to a rule that looks right and paints
    // nothing — and because these utilities are global, nothing else in the
    // suite would ever notice.
    const layer = appLayer();

    for (const [candidate, , value] of APP_ALIAS_CASES) {
      const property = /var\((--[a-z0-9-]+)\)/.exec(value)?.[1];
      expect(
        property,
        `${candidate} resolves to ${value}, which is not a var() reference`,
      ).toBeDefined();
      expect(
        layer,
        `${property} is referenced by an app-* utility but never declared under [data-surface="app"]`,
      ).toMatch(new RegExp(`(^|[^-\\w])${property}:\\s*\\S`, "m"));
    }
  });

  it("keeps the font-size scale in globals.css and utils.ts in step", () => {
    // THE DRIFT THAT MATTERS. tailwind-merge cannot tell a custom `text-app-*`
    // font size from a text COLOUR, so src/lib/utils.ts has to name the scale
    // for it (see that file). A `--text-app-*` entry added here but not there
    // is silently dropped by every `cn()` call that also sets a colour — the
    // class renders, at the inherited size. This walks both directions.
    const declared = [...readFileSync(GLOBALS, "utf8").matchAll(/--text-(app-[a-z0-9-]+):/g)].map(
      (m) => m[1],
    );

    expect([...declared].sort()).toEqual([...APP_FONT_SIZES].sort());
  });

  it("does not alias the radius scale, which is the trap this slice was set", () => {
    // #128's finding again, from the other side: `--app-radius*` is a separate
    // name precisely BECAUSE `--radius-*` are frozen literals. A `--radius-app-*`
    // @theme entry would inline `5px` into `.rounded-app-sm` and hand the panel
    // a corner radius the scope can never re-skin — the exact dead-declaration
    // failure the globals.css comment spends a paragraph on.
    for (const candidate of APP_FORBIDDEN_CANDIDATES) {
      expect(ruleBody(candidate), `.${candidate} should not exist`).toBeUndefined();
    }
  });
});

describe("brass is a deliberate fill, never a focus or hover wash", () => {
  // design/system/dashboard.html:82-91 — "STATUS PALETTE — semantic,
  // deliberately NOT the brand accent". Brass fills exactly five things in the
  // mock (:192, :223, :372, :437, :443) and every hover/focus surface is
  // `var(--app-raised)` instead (:222, :527, :528). shadcn's dropdown-menu
  // ships the opposite default because it means something else by "accent",
  // so src/components/ui/dropdown-menu.tsx re-points those classes by hand.
  //
  // THIS IS THE REGRESSION THIS TEST EXISTS FOR: `shadcn add dropdown-menu
  // --overwrite` silently restores the generated classes, and the result is a
  // brass focus row at 2.02:1 that nothing else in the suite would notice.
  const source = () => readFileSync(DROPDOWN_MENU, "utf8");

  // Class strings only — the file's header comment quotes the generated
  // classes on purpose to explain what was changed, and must not trip this.
  const classStrings = () =>
    source()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  it("leaves no accent-based focus or open state in dropdown-menu.tsx", () => {
    expect(classStrings()).not.toMatch(/focus:bg-accent/);
    expect(classStrings()).not.toMatch(/data-open:bg-accent/);
    expect(classStrings()).not.toMatch(/text-accent-foreground/);
  });

  it("uses the mock's own hover pairing instead", () => {
    // `--muted` is `--bg-2`, which is what the mock calls `--app-raised`, and
    // `--foreground` is `--fg`: byte-exact with `.tabbar__item:hover`.
    const classes = classStrings();

    expect(classes).toContain("focus:bg-muted");
    expect(classes).toContain("focus:text-foreground");
    expect(classes).toContain("data-open:bg-muted");
    expect(classes).toContain("group-focus/dropdown-menu-item:text-foreground");
  });

  it("keeps the deviation documented, since the CLI would otherwise revert it", () => {
    expect(source()).toContain("DELIBERATE, REVIEWED DEVIATION");
  });
});

describe("custom properties the generated primitives read directly", () => {
  // These are NOT reached through a `--color-*` utility. They appear inside
  // arbitrary values in src/components/ui/*.tsx, so they have to exist as
  // real custom properties in the browser or the declaration around them is
  // invalid at computed-value time and silently falls back.
  it("emits --secondary and --foreground, which button.tsx color-mixes at runtime", () => {
    // Guard the premise: if shadcn's `secondary` variant stops color-mixing
    // these, this test is defending something nothing depends on any more.
    expect(readFileSync(BUTTON, "utf8")).toContain(
      "color-mix(in_oklch,var(--secondary),var(--foreground)_5%)",
    );

    const root = rootDeclarations();
    expect(root).toMatch(/(^|[^-\w])--secondary:\s*\S/m);
    expect(root).toMatch(/(^|[^-\w])--foreground:\s*\S/m);
  });

  it("emits --radius-md, which button.tsx's xs/sm sizes read through min()", () => {
    // Counter-intuitive, and the reason this is pinned: task #128 verified
    // that `@theme inline { --radius-sm: 2px }` never reaches the browser,
    // because a LITERAL right-hand side gets inlined into the utility and the
    // property itself is dropped. `--radius-md` is the same shape — but
    // button.tsx names it inside an arbitrary value, and Tailwind does emit a
    // theme variable that some generated rule actually references. So this
    // one DOES survive, and only for that reason. If the xs/sm/icon-xs/icon-sm
    // sizes ever stop using it, the variable disappears from the output and
    // any rule still saying `var(--radius-md)` breaks silently.
    expect(readFileSync(BUTTON, "utf8")).toContain("rounded-[min(var(--radius-md),10px)]");

    expect(css).toMatch(/--radius-md:\s*3px/);
    expect(css).toContain("border-radius: min(var(--radius-md), 10px)");
  });
});

describe("the rest of globals.css survives the shadcn wiring", () => {
  // The kanban trap for this slice, made mechanical: `shadcn add` can rewrite
  // globals.css wholesale, and three unrelated things live in it.
  it("keeps the brand :root block intact", () => {
    const root = rootDeclarations();

    expect(root).toMatch(/--bg:\s*#0b0b0f/);
    expect(root).toMatch(/--bg-sunken:\s*#070709/);
    expect(root).toMatch(/(^|[^-\w])--accent:\s*#c8a15a/m);
    expect(root).toMatch(/--accent-2:\s*#e0be7e/);
    expect(root).toMatch(/(^|[^-\w])--fg:\s*#eceaf2/m);
  });

  it("keeps task #128's app-surface token layer intact", () => {
    const layer = /\[data-surface="app"\]\s*\{([^}]*)\}/.exec(css)?.[1];

    expect(layer, 'no [data-surface="app"] block survived').toBeDefined();
    expect(layer).toMatch(/--app-radius:\s*8px/);
    expect(layer).toMatch(/--app-ground:\s*var\(--bg-sunken\)/);
    expect(layer).toMatch(/--app-row-h:\s*52px/);
  });

  it("keeps the public site's own blocks intact", () => {
    expect(css).toContain(".hero-scrim");
    expect(css).toContain(".collections");
    expect(css).toContain(".col-tile");
    expect(css).toContain(".work figcaption");
    expect(css).toContain(".wrap");
    expect(css).toContain(".label");
  });

  it("does not let the app surface try to re-skin --radius-*, which cannot work", () => {
    // #128's finding, kept enforced rather than only written down: a scoped
    // `--radius-sm` / `--radius-lg` override is a dead declaration, because
    // those utilities inline their literal and the property is never emitted.
    const layer = /\[data-surface="app"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(layer).not.toMatch(/--radius-(sm|md|lg|xl):/);
  });
});
