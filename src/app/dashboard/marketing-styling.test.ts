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
//                    device (a small-caps, tracked, uppercase treatment) and
//                    both are guarded below.
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

/** Strips `/* … *\/` and `// …` comments, so a comment that names a
 * forbidden class to EXPLAIN its absence (this file's own header comment
 * does exactly that, and so do several component comments this task added)
 * is never mistaken for a live call site. Mirrors the `classStrings()`
 * technique `globals.tokens.test.ts` already uses for the same reason,
 * extended to block comments (`/* … *\/`), which line-only filtering does
 * not reach and which JSX's `{/* … *\/}` comments compile down to. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
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

/** The wordmark's own exact size (`src/app/dashboard/layout.tsx`) — the one
 * pairing `font-serif` is allowed to appear in under /dashboard. */
const WORDMARK_SIZE_TOKEN = "text-[18px]";

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

  return found;
}

describe("no surviving marketing styling under /dashboard (task #135)", () => {
  it("found at least one file to guard, so an empty set cannot pass vacuously", () => {
    expect(FILES_UNDER_GUARD.length).toBeGreaterThan(10);
  });

  it.each(FILES_UNDER_GUARD)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    const violations = extractClassNameValues(source).flatMap(findViolations);

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
