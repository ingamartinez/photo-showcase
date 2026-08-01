import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Task #135 — the epic's closing guard.
//
// WHY THIS EXISTS. #129 through #134 converted every screen under /dashboard
// off the public site's editorial system, one screen at a time, each
// reviewed against its own mock panel. Nothing in that flow answers "is
// there any editorial styling left anywhere under /dashboard" — the question
// this slice was opened to close (see task #135's own body). Sweeping once
// is not the same as staying swept: `layout.chrome.test.tsx` already proves
// the marketing HEADER/FOOTER cannot leak into the dashboard by asserting
// "Reservar" and "@alejo_frames" are absent from the rendered tree. This file
// is the same idea applied to STYLING rather than chrome, and it does the
// checking at the SOURCE, not the rendered DOM: a render-based test only
// exercises whatever branch happens to run (a dialog that never opens, a
// zero-state that never triggers), while a class the photographer will
// eventually see can sit in an unexercised branch indefinitely. Reading the
// source directly means a forbidden class cannot hide behind an untested
// prop.
//
// WHAT COUNTS AS "SURVIVING MARKETING STYLING" HERE, taken verbatim from the
// task's own list:
//   - `.wrap`      — the marketing 1280px centred column (globals.css:473).
//   - `.label`     — the mono, uppercase, 0.22em-tracked eyebrow
//                    (globals.css:498). The task's own sweep found this
//                    class AND its un-classed sibling — a raw
//                    `uppercase tracking-[0.1em] text-[13px]` bordered
//                    button, copy-pasted from the public site's own CTA
//                    shape (hero.tsx, site-header.tsx, login-form.tsx) —
//                    surviving in client-form.tsx, gallery-form.tsx and every
//                    dashboard action button. Both are the same editorial
//                    device (a small-caps, tracked, uppercase treatment), and
//                    an earlier revision of this guard checked only the
//                    classed one: `uppercase`/`tracking-[0.1em]` reintroduced
//                    on their own passed clean, which is the exact device
//                    four of the six files this task touched exist to keep
//                    out. Guarded below by pairing `uppercase` with any
//                    `tracking-[…]` at 0.07em or tighter, OR Tailwind's named
//                    `tracking-widest` — which compiles to the exact same
//                    0.1em as the CTA's own bracket form, so the bracket-only
//                    check alone would have let `tracking-wide` -> `-widest`
//                    walk straight past it. Every LEGITIMATE uppercase
//                    treatment left under /dashboard sits at
//                    `tracking-[0.06em]`, `tracking-[0.04em]`,
//                    `tracking-wide` (0.025em) or `tracking-wider` (0.05em),
//                    so 0.07em is a real gap between "the app's own quiet
//                    uppercase micro-labels" and "the marketing CTA's 0.1em",
//                    not an arbitrary cutoff.
//   - `clamp(...)` — the editorial display type scale (dashboard.html:82-91's
//                    opposite number; the mock's own panel type scale,
//                    globals.css's `--app-text-*`, is a fixed step list, not
//                    a fluid clamp).
//   - `font-serif` used as a DISPLAY face. The one deliberate exception is
//     `src/app/dashboard/layout.tsx`'s wordmark ("Alejo Frames"), which stays
//     serif at 18px per the mock (dashboard.html:158-159) — see that file's
//     own header comment for why. That is a wordmark, not a headline, and it
//     is the ONLY place `font-serif` may appear under /dashboard: this guard
//     allows it ONLY when paired with `text-[18px]` in the very same class
//     list, which is the wordmark's exact, unique size. Any other pairing —
//     a display headline at any other size — fails.
//
// THE FILE SET, AND ITS ONE DELIBERATE GAP. `eslint.config.mjs`'s own #175
// rule scopes `app-*` utilities to `src/app/dashboard/**` and
// `src/components/dashboard-*` — a naming convention, not a usage check.
// This task's own sweep found six real dashboard-only components that don't
// match either shape (`client-form.tsx`, `gallery-form.tsx`,
// `unlock-selection-panel.tsx`, `publish-gallery-button.tsx`,
// `attach-gallery-clients-form.tsx`, `deliver-gallery-button.tsx`) plus four
// more reachable only from <GalleryWorkspace> (`gallery-workspace.tsx`,
// `gallery-client-row.tsx`, `asset-tile.tsx`, `proof-uploader.tsx`) — the
// SAME blind spot #175's naming convention has, hit directly while fixing
// this very task. Listed explicitly below rather than silently trusted to
// the glob, with this comment as the reason a future dashboard-only
// component needs the same manual addition until it earns a `dashboard-*`
// name of its own.
//
// `src/components/dashboard-nav.tsx` is DELIBERATELY EXCLUDED — task #135's
// own carve-out hands that file to a sibling lane (#174) for this wave, and
// this guard is not the mechanism that enforces someone else's slice.
//
// ALSO NOT GUARDED, AND DELIBERATELY SO: `src/components/ui/button.tsx`,
// `ui/dialog.tsx` and `ui/dropdown-menu.tsx` are, by the same import-graph
// argument as the ten components above, ALSO reachable only from
// /dashboard today. They are not listed here because they are vendored
// shadcn primitives (epic #125's own "adopted for accessibility, not
// restyled" stance) with no editorial residue in them to guard against —
// a documentation gap in this file's own scope, not a hole in the check.
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.resolve(REPO_ROOT, "src");
const COMPONENTS_DIR = path.resolve(SRC, "components");

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsxFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

const DASHBOARD_TREE_FILES = collectTsxFiles(path.resolve(SRC, "app/dashboard"));

const DASHBOARD_PREFIXED_COMPONENTS = readdirSync(COMPONENTS_DIR)
  .filter(
    (name) => name.startsWith("dashboard-") && name.endsWith(".tsx") && !name.includes(".test."),
  )
  .filter((name) => name !== "dashboard-nav.tsx") // task #174's territory this wave, see header comment
  .map((name) => path.join(COMPONENTS_DIR, name));

// Dashboard-only components that don't match the `dashboard-*` naming
// convention — see this file's header comment for why they are named here
// by hand instead of discovered by a glob.
const EXTRA_DASHBOARD_ONLY_COMPONENTS = [
  "client-form.tsx",
  "gallery-form.tsx",
  "unlock-selection-panel.tsx",
  "publish-gallery-button.tsx",
  "attach-gallery-clients-form.tsx",
  "deliver-gallery-button.tsx",
  "gallery-workspace.tsx",
  "gallery-client-row.tsx",
  "asset-tile.tsx",
  "proof-uploader.tsx",
].map((name) => path.join(COMPONENTS_DIR, name));

const FILES_UNDER_GUARD = [
  ...new Set([
    ...DASHBOARD_TREE_FILES,
    ...DASHBOARD_PREFIXED_COMPONENTS,
    ...EXTRA_DASHBOARD_ONLY_COMPONENTS,
  ]),
].sort();

/** Strips `/* … *\/` and whole-line `// …` comments, so a comment that
 * names a forbidden class to EXPLAIN its absence (this file's own header
 * comment does exactly that, and so do several component comments this
 * task added) is never mistaken for a live call site. Mirrors the
 * `classStrings()` technique `globals.tokens.test.ts` already uses for the
 * same reason, extended to block comments (`/* … *\/`), which line-only
 * filtering does not reach and which JSX's `{/* … *\/}` comments compile
 * down to.
 *
 * BOTH halves are anchored to a LEGITIMATE OPENER — a line whose first
 * non-whitespace characters are `//`, or (optionally through a JSX `{`)
 * `/*` — not the blanket `\/\/.*$` / `\/\*[\s\S]*?\*\/` an earlier revision
 * used for each. A blanket strip does not know about strings: it treats
 * ANY `//` or `/*` on a line as a real comment opener, including one that
 * sits inside a quoted value or an attribute. That is exactly what bit the
 * BLOCK half after the line half was fixed: `attach-gallery-clients-form.tsx`
 * and `deliver-gallery-button.tsx` both explain in prose that they live
 * under `` `src/app/dashboard/**` `` — the `/*` inside `dashboard/**` opened
 * a phantom comment that swallowed everything up to the next real `*\/}`,
 * `const inputClass` included — and `proof-uploader.tsx`'s
 * `accept="image/*"` did the same starting from a live JSX attribute.
 * Requiring the opener to sit at the true start of its line (whitespace and
 * at most one `{` before it) is what every genuine comment in these files
 * already does, so restricting both strips to that shape costs nothing
 * today and closes the class of hazard — a forbidden class hiding behind
 * either comment style — that a blanket strip of either kind reopens. */
function stripComments(source: string): string {
  return source.replace(/^[ \t]*\{?\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every string a `className` attribute contributes to the rendered class
 * list, whether written as a plain literal (`className="…"`) or inside an
 * expression (`className={cn("…", cond && "…")}`). Restricted to
 * `className` specifically — not a blanket word search over the whole
 * file — because "label" and "wrap" are both otherwise-ordinary English/HTML
 * words (the `<label>` element, `aria-label`, `flex-wrap`) that a bare
 * `\blabel\b` search would flag on sight for reasons having nothing to do
 * with the eyebrow class this guards against.
 */
function extractClassNameValues(source: string): string[] {
  const clean = stripComments(source);
  const values: string[] = [];

  for (const m of clean.matchAll(/\bclassName\s*=\s*"([^"]*)"/g)) {
    values.push(m[1]);
  }

  // `className={…}` — walk to the MATCHING closing brace by depth (a plain
  // regex cannot do this across a multi-line `cn(…)` call, which is most of
  // them in this codebase), then pull every quoted/template string out of
  // the expression inside.
  const braceOpen = /\bclassName\s*=\s*\{/g;
  while (braceOpen.exec(clean)) {
    const start = braceOpen.lastIndex - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < clean.length; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const expr = clean.slice(start + 1, end);
    for (const s of expr.matchAll(/"([^"]*)"/g)) values.push(s[1]);
    for (const s of expr.matchAll(/`([^`]*)`/g)) values.push(s[1]);
  }

  return values;
}

/**
 * Every string literal assigned to an identifier that LOOKS LIKE a class
 * list — name ending in `class` or `className` (either case) — the
 * `const inputClass = "…"` idiom three of the six files this task touched
 * use to share one class string across several elements. Missing this was
 * a real gap: `extractClassNameValues` above only ever looks at the
 * `className=` CALL SITE, so a forbidden class sitting in the CONSTANT one
 * line above every call site read clean. `inputClass`, `buttonClass` and
 * similar are exactly the shape this codebase already uses (see
 * client-form.tsx, gallery-form.tsx, attach-gallery-clients-form.tsx), so
 * matching the name rather than hand-listing every identifier keeps this
 * from needing an update every time a new one is added.
 */
function extractIdentifierClassValues(source: string): string[] {
  const clean = stripComments(source);
  const values: string[] = [];
  const isClassIdentifier = /[Cc]lass(Name)?$/;

  const literalRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g;
  for (const m of clean.matchAll(literalRe)) {
    if (isClassIdentifier.test(m[1])) values.push(m[2]);
  }

  const templateRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/g;
  for (const m of clean.matchAll(templateRe)) {
    if (isClassIdentifier.test(m[1])) values.push(m[2]);
  }

  return values;
}

/** The wordmark's own exact size (`src/app/dashboard/layout.tsx`) — the one
 * pairing `font-serif` is allowed to appear in under /dashboard. */
const WORDMARK_SIZE_TOKEN = "text-[18px]";

/** Matches a `tracking-[…]` token at 0.07em or tighter — the marketing CTA's
 * own `tracking-[0.1em]`, and anything closer to it than the app's own
 * legitimate quiet-uppercase treatments (`tracking-[0.06em]`,
 * `tracking-[0.04em]`, Tailwind's `tracking-wide` at 0.025em). See this
 * file's header comment for why 0.07em is the real gap, not an arbitrary
 * cutoff. Deliberately does NOT match the bracket form only: Tailwind's own
 * NAMED `tracking-widest` utility compiles to `letter-spacing: 0.1em`
 * (node_modules/tailwindcss/theme.css) — byte-identical to the CTA's own
 * `tracking-[0.1em]` — so `TIGHT_TRACKING_TOKENS` below checks for it by
 * name alongside the regex. `tracking-wider` (0.05em) is correctly NOT
 * included; it sits below the 0.07em cutoff same as the bracket form
 * would. */
const TIGHT_TRACKING = /^tracking-\[0?\.(0[7-9]|[1-9])/;
const TIGHT_TRACKING_TOKENS = new Set(["tracking-widest"]);

function findViolations(classValue: string): string[] {
  const tokens = classValue.split(/\s+/).filter(Boolean);
  const found: string[] = [];

  if (tokens.includes("wrap")) {
    found.push(`the marketing "wrap" column: "${classValue}"`);
  }
  if (tokens.includes("label")) {
    found.push(`the marketing "label" eyebrow: "${classValue}"`);
  }
  if (classValue.includes("clamp(")) {
    found.push(`a clamp() display type scale: "${classValue}"`);
  }
  if (tokens.includes("font-serif") && !tokens.includes(WORDMARK_SIZE_TOKEN)) {
    found.push(
      `"font-serif" outside the ${WORDMARK_SIZE_TOKEN} wordmark exception: "${classValue}"`,
    );
  }
  if (
    tokens.includes("uppercase") &&
    tokens.some((t) => TIGHT_TRACKING.test(t) || TIGHT_TRACKING_TOKENS.has(t))
  ) {
    found.push(`the marketing CTA's uppercase/tight-tracking pairing: "${classValue}"`);
  }

  return found;
}

describe("no surviving marketing styling under /dashboard (task #135)", () => {
  it("found at least one file to guard, so an empty set cannot pass vacuously", () => {
    expect(FILES_UNDER_GUARD.length).toBeGreaterThan(10);
  });

  it.each(FILES_UNDER_GUARD)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    const classValues = [
      ...extractClassNameValues(source),
      ...extractIdentifierClassValues(source),
    ];
    const violations = classValues.flatMap(findViolations);

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
