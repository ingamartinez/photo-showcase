import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { beforeAll, describe, expect, it } from "vitest";

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

// One compile, shared by every assertion below. Deliberately not one per
// test: @tailwindcss/postcss caches its compiled design system against the
// `from` path, so a second `process()` with the same path silently reuses
// the FIRST call's candidate set — which produced a test that failed while
// the stylesheet was correct.
let css = "";

beforeAll(async () => {
  const source = readFileSync(GLOBALS, "utf8");

  expect(source).toContain('@import "tailwindcss";');
  const candidates = [...SEMANTIC_COLORS.map(([name]) => `bg-${name}`), ...RAW_PROPERTY_CANDIDATES];
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
