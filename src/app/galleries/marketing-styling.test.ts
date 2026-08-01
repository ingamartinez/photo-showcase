import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Task #149 — the epic's (#140) closing guard, the client-gallery surface's
// counterpart to `src/app/dashboard/marketing-styling.test.ts` (task #135).
// Read that file's own header comment first: this one reuses its extraction
// technique (comment-stripping, constant/object-map resolution by USAGE) for
// the same structural reason — a render-based test only exercises whatever
// branch happens to run, and a forbidden class sitting in an unexercised
// branch (a `delivered`-only note, a `selected`-only panel) can hide from it
// indefinitely. Scanning the SOURCE catches it regardless of which of the
// three gallery states a given test happens to render.
//
// THE TWO SURFACES ARE OPPOSITES, SO THE RULES ARE NOT THE SAME FILE COPIED.
// `/dashboard`'s guard bans serif display type, `clamp()`, and ANY
// uppercase+tight-tracking pairing outright, because NONE of that belongs on
// a work tool. `/galleries` is the opposite case (epic #140's own table): the
// client gallery stays on the EDITORIAL system on purpose — serif display
// type and a fluid `clamp()` headline scale are the mock's own choice
// (`design/system/client.html`'s `.display`, `.gal-card__t`), not survived
// marketing debris, so this guard does NOT ban either. What it DOES ban is
// narrower and more specific, because the actual residue task #149's own
// sweep found was not "the editorial system leaked in" (it is SUPPOSED to be
// here) but two verbatim, unadapted MARKETING VALUES sitting inside that
// otherwise-correct system:
//
//   1. `.wrap` — the marketing site's centred 1280px column
//      (globals.css:502). `src/app/galleries/layout.tsx`'s own header
//      comment already documents removing this in favour of the mock's own
//      stepped gutter (task #142); this guard is what keeps it from coming
//      back.
//   2. globals.css's `.label` class, and the BARE STRING "label" as a
//      Tailwind class token. `.label` is `letter-spacing: 0.22em` — verified
//      against `design/system/home.html`'s own `.kicker` (line 57), which is
//      the exact same 0.22em value under a different name reused verbatim in
//      globals.css. `design/system/client.html` has its OWN `.kicker`
//      (:117-120) for this exact eyebrow/small-caps device, and it specifies
//      0.18em — a real, easy-to-miss 0.04em gap from the marketing value,
//      not a rounding difference. Task #149's own sweep found FOUR call
//      sites using the shared `.label` class (`src/app/galleries/page.tsx`
//      twice, `src/app/galleries/[publicSlug]/page.tsx` once,
//      `src/components/client-preview-banner.tsx` once) and converted all
//      four to the mock's own 0.18em value, inlined rather than a shared
//      class, specifically so this exact drift cannot happen silently again
//      via a shared name.
//   3. The marketing CTA's own SHAPE — `uppercase` paired with a tight
//      tracking value — found surviving in `submit-selection-panel.tsx`'s
//      "Enviar selección" button as a raw, un-classed
//      `uppercase tracking-[0.1em] text-[13px]` bordered button, the exact
//      device `src/app/galleries/layout.tsx`'s own header comment already
//      named as removed from "Cerrar sesión" (#142) — the SAME finding shape
//      as #135's own "un-classed sibling" for `/dashboard`, independently
//      reproduced here. `design/system/client.html`'s own "Enviar" action is
//      `.btn.btn--primary` (:828, :867), which is NOT uppercase and tracks at
//      0.02em. Because THIS surface's own legitimate eyebrow device (the
//      kicker, above) DOES use `uppercase` at 0.18em — unlike `/dashboard`,
//      where no legitimate uppercase treatment exists at all — the rule
//      cannot be "ban uppercase+tight-tracking outright" the way #135's is.
//      It is instead an ALLOWLIST, the same shape #135's own
//      `WORDMARK_SIZE_TOKEN` exception uses: `uppercase` may appear ONLY
//      paired with EXACTLY `tracking-[0.18em]` (the kicker's own value) in
//      the same class list. Any other pairing — no tracking at all, the
//      marketing CTA's `tracking-[0.1em]`, `.label`'s `tracking-[0.22em]`,
//      home.html's `.eyebrow` at `tracking-[0.28em]` — fails.
//   4. `@media (max-width` — epic #140's hard mobile-first rule, restated
//      from its own body: "el cliente elige sus fotos desde el teléfono...
//      ninguna media query `max-width`." This is checked over RAW source,
//      not through the className extraction below, because a media query
//      lives in a `<style>`/CSS-in-JS block if it exists at all, never
//      inside a `className` attribute — none exist anywhere in this surface
//      today (verified by direct `rg` before this guard was written), so
//      this is pure regression insurance, not a fix for a violation found.
//
// DELIBERATELY NOT GUARDED, AND WHY — stated on the same axis #135's own
// comment insists on, so this file cannot be read as claiming a reach it
// does not have:
//
//   - `font-serif` and `clamp(...)` are the CORRECT display type for this
//     surface (epic #140's own table: "el panel necesita apretar, esta
//     necesita respirar"; `client.html`'s own header comment: "Serif display
//     type, banned on the panel, is CORRECT here"). Banning either here would
//     be banning the thing this epic asked for, not guarding against its
//     absence.
//   - The exact pixel values inside those `clamp()` calls
//     (`clamp(30px,4.5vw,52px)` on the index heading,
//     `clamp(28px,4vw,44px)` on the gallery heading) do not match
//     `client.html`'s own single `.display` scale (`clamp(30px,8vw,46px)`)
//     digit-for-digit. Audited directly against both `home.html` (no exact
//     match either — nothing in the marketing site's own clamp calls
//     produces these numbers) and every other `clamp()` in the app; found no
//     evidence either was copied verbatim from a marketing source rather than
//     adapted for its own context, and each already carries its own
//     mock-referencing header comment from the slice that shipped it
//     (#143/#180/#181). Re-litigating an already-reviewed pixel choice with
//     no comment trail suggesting it is wrong is outside this task's own
//     scope ("purgar el chrome... y ponerle guard" — chrome and its
//     regression, not a pixel audit of already-shipped, reviewed work).
//   - `text-[15px]` (four call sites: this surface's two empty/lede states,
//     `proof-grid.tsx`'s zero-asset message, `selection-tray.tsx`'s empty
//     tray message) matches `client.html`'s own `--t-base: 15px` — the
//     mock's DEFAULT body size, not a marketing leftover. It is 1px larger
//     than the mock's more specific `.lede` value (`--t-body: 14px`), which
//     is a real, minor gap — but a consistent one applied identically across
//     four already-reviewed files, not stray, isolated debris, and changing
//     it now would be a pixel-level design call outside this sweep's mandate
//     rather than a chrome purge.
//   - `p-6`/`px-6` (the two gallery-card variants in
//     `src/app/galleries/page.tsx`) is a deliberate, consistent 24px card
//     inset applied to both the photo and no-cover-photo card variants alike,
//     not a value traceable to any marketing source — `home.html` has no
//     `p-6` card padding to have been copied from, and neither does the
//     mock's own `.gal-card__body` (`padding: 0 var(--gutter) 18px`, 16px,
//     not 24px). A real, minor gap from the mock's own gutter value, same
//     category as the previous point, and left for the same reason.
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

const GALLERIES_TREE_FILES = collectTsxFiles(path.resolve(SRC, "app/galleries"));

// Components reachable ONLY from `/galleries`, found by direct import-graph
// enumeration (every `@/components/X` import, traced from
// `src/app/galleries/**` down through every component it pulls in, each
// checked against the REST of `src` for a second importer) rather than a
// naming convention — this surface has no `gallery-*`/`client-*` prefix glob
// to lean on the way `/dashboard`'s `dashboard-*` convention does, so hand
// enumeration is the only option, not a shortcut taken in place of one.
// `use-proof-urls.ts` and `use-shared-selection.ts` are also
// `/galleries`-exclusive (the latter shared only with this same component
// set) but carry no JSX at all — verified directly (`rg className` on both,
// zero hits) — so they add nothing for a `className` scan to find and are
// left out rather than included to pad the file count.
//
// `src/components/page-header.tsx` — this task's own named "first suspect"
// — was checked and is NOT reachable from `/galleries` at all: its four
// importers are `login-form.tsx` and three `(marketing)` pages
// (`about`/`contact`/`work`), none of which `/galleries` renders. It stays
// exactly as it is, correctly, for the public site epic #7 owns — not listed
// here because it is out of this guard's scope, not because it was missed.
const EXTRA_GALLERIES_ONLY_COMPONENTS = [
  "proof-grid.tsx",
  "proof-tile.tsx",
  "proof-lightbox.tsx",
  "selection-counter.tsx",
  "selection-tray.tsx",
  "submit-selection-panel.tsx",
  "download-all-button.tsx",
  "download-final-button.tsx",
  "client-preview-banner.tsx",
].map((name) => path.join(COMPONENTS_DIR, name));

const FILES_UNDER_GUARD = [
  ...new Set([...GALLERIES_TREE_FILES, ...EXTRA_GALLERIES_ONLY_COMPONENTS]),
].sort();

/** Strips `/* … *\/` and whole-line `// …` comments, so a comment that NAMES
 * a forbidden class to EXPLAIN its absence (this file's own header comment
 * does exactly that) is never mistaken for a live call site. Anchored to a
 * LEGITIMATE OPENER at the true start of a line (whitespace and at most one
 * `{` before it) in both directions, not a blanket `\/\/.*$` /
 * `\/\*[\s\S]*?\*\/` — see `src/app/dashboard/marketing-styling.test.ts`'s
 * own comment on this exact function for the two concrete failures
 * (`accept="image/*"`, a prose `/*` inside `dashboard/**`) a blanket strip of
 * either kind reopens. Identical implementation, reused rather than
 * reinvented, because the hazard it closes is not specific to the dashboard
 * tree. */
function stripComments(source: string): string {
  return source.replace(/^[ \t]*\{?\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every `const`/`let`/`var` string (or template-literal) declaration in the
 * file, keyed by identifier name, so a bare identifier referenced inside a
 * `className={…}` expression (this file's own `KICKER_CLASS` in
 * `src/app/galleries/page.tsx`, resolved by USAGE not by guessing its name
 * looks like a class constant) can be resolved back to the string it holds.
 * See `src/app/dashboard/marketing-styling.test.ts`'s own comment on the
 * identical function for why resolving by usage, not by name shape, is what
 * makes this exhaustive rather than a guess. Known limitation, not live
 * today: a later re-declaration of the same name wins over an earlier one
 * (`Map.set`) — verified against the guarded set: one such constant exists
 * (`KICKER_CLASS`), declared once, never re-declared.
 */
function collectStringConstants(clean: string): Map<string, string> {
  const constants = new Map<string, string>();

  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g)) {
    constants.set(m[1], m[2]);
  }
  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/g)) {
    constants.set(m[1], m[2]);
  }

  return constants;
}

/**
 * Every `const`/`let`/`var NAME = { key: "value", … }` object-literal
 * declaration, keyed by `NAME`, mapped to EVERY string value in its body —
 * the fourth way a string reaches `className`, a MEMBER EXPRESSION into a
 * lookup map. `STATE_TONE_CLASS` in `src/app/galleries/page.tsx` (per-tone
 * colour for the gallery-card status chip) is exactly this shape today,
 * indexed by a runtime value (`state.tone`) this static scan cannot
 * evaluate — resolved to every value the object holds rather than a guess at
 * which key wins at render, the same over-inclusive-on-purpose stance
 * `src/app/dashboard/marketing-styling.test.ts`'s own `STATUS_RAMP` comment
 * explains for the identical shape one surface over.
 */
function collectObjectStringConstants(clean: string): Map<string, string[]> {
  const objects = new Map<string, string[]>();
  const declOpen = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/g;

  let decl: RegExpExecArray | null;
  while ((decl = declOpen.exec(clean))) {
    const name = decl[1];
    const start = declOpen.lastIndex - 1;
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
    const body = clean.slice(start + 1, end);
    const values = [...body.matchAll(/:\s*"([^"]*)"/g)].map((m) => m[1]);
    if (values.length > 0) objects.set(name, values);
  }

  return objects;
}

/**
 * Consumes ONE template literal starting at the backtick found at
 * `expr[openBacktickIndex]`, pushing every LITERAL segment (the text between
 * two `${…}` interpolations, or between a backtick and the first/last one) to
 * `values` verbatim, and recursing into each `${…}` interpolation's own
 * expression via `extractFromExpression` below — rather than the ONE regex
 * an earlier revision of this file used
 * (`` /`([^`]*)`/g ``), which matched the ENTIRE raw span between the outer
 * backticks, `${…}` included, as one opaque string. That is unsound in a
 * specific, demonstrated way: `selection-tray.tsx`'s own
 * `` `mt-1 truncate text-[11px] ${label === UNATTRIBUTED_PICKER_LABEL ? "…" : "…"}` ``
 * contains the bare JS identifier `label` — a local variable holding a
 * PERSON'S NAME, entirely unrelated to any class — and the blanket regex
 * pushed the interpolation's raw source text (identifier and all) into
 * `values`, where the later `tokens.split(/\s+/)` check then matched it
 * against the literal Tailwind token `"label"` and flagged legitimate,
 * already-reviewed code. Found by running this exact guard against the real
 * file set, not invented as a hypothetical: it is exactly the kind of gap
 * `src/app/dashboard/marketing-styling.test.ts`'s own history (five review
 * rounds, four returned for claiming more reach than the code had) warns
 * about a test's own extraction logic hiding until it meets real code, and
 * fixing it here rather than working around it in the ONE file it broke is
 * what keeps every other identifier this scan will ever meet from tripping
 * the same false positive.
 *
 * Returns the index one past the template literal's CLOSING backtick, so the
 * caller can resume scanning the rest of the surrounding expression.
 */
function consumeTemplateLiteral(
  expr: string,
  openBacktickIndex: number,
  constants: Map<string, string>,
  objectConstants: Map<string, string[]>,
  values: string[],
): number {
  let i = openBacktickIndex + 1;
  let literalStart = i;
  while (i < expr.length) {
    if (expr[i] === "`") {
      values.push(expr.slice(literalStart, i));
      return i + 1;
    }
    if (expr[i] === "$" && expr[i + 1] === "{") {
      values.push(expr.slice(literalStart, i));
      let depth = 1;
      let j = i + 2;
      while (j < expr.length && depth > 0) {
        if (expr[j] === "{") depth++;
        else if (expr[j] === "}") depth--;
        j++;
      }
      extractFromExpression(expr.slice(i + 2, j - 1), constants, objectConstants, values);
      i = j;
      literalStart = i;
      continue;
    }
    i++;
  }
  // Unterminated template literal — should never happen against real,
  // parseable TSX, but pushing whatever is left rather than silently
  // dropping it keeps this a loud failure (a nonsense token) instead of a
  // quiet one (a dropped class this guard should have seen).
  values.push(expr.slice(literalStart));
  return expr.length;
}

/**
 * Every string an arbitrary JS EXPRESSION (the inside of a `className={…}`,
 * or of one `${…}` interpolation inside a template literal found within one)
 * contributes to the rendered class list, by the four routes
 * `src/app/dashboard/marketing-styling.test.ts` documents in full for its own
 * `extractClassNameValues` (a plain literal, a literal inside an expression,
 * a bare identifier resolved by usage, and a member expression into a known
 * object map) — the same four routes here, just applied recursively so a
 * template literal's OWN interpolations get the identical treatment rather
 * than being swallowed as raw text (see `consumeTemplateLiteral`'s own
 * comment for why that swallowing is unsound, not merely inelegant).
 *
 * Boundary, stated the same way that file's own comment is: array-literal
 * class constants, JSX prop spreads, and split-token concatenation are still
 * unreached (none exist in this guard's own file set — verified directly,
 * same as that file), and a later re-declaration of the same constant name
 * still silently wins over an earlier one (`collectStringConstants`'s own
 * comment).
 */
function extractFromExpression(
  expr: string,
  constants: Map<string, string>,
  objectConstants: Map<string, string[]>,
  values: string[],
): void {
  for (const m of expr.matchAll(/"([^"]*)"/g)) values.push(m[1]);

  // Consume every template literal in `expr`, left to right, building a
  // MASKED copy (each template literal's full span replaced with spaces) so
  // the identifier scan below never re-reads an interpolation's identifiers
  // a second time — the recursive call inside `consumeTemplateLiteral`
  // already resolved them.
  let masked = "";
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "`") {
      const endIndex = consumeTemplateLiteral(expr, i, constants, objectConstants, values);
      masked += " ".repeat(endIndex - i);
      i = endIndex;
    } else {
      masked += expr[i];
      i++;
    }
  }

  const withoutStrings = masked.replace(/"[^"]*"/g, (s) => " ".repeat(s.length));
  for (const m of withoutStrings.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const resolved = constants.get(m[0]);
    if (resolved !== undefined) values.push(resolved);
  }
  for (const m of withoutStrings.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]|\.[A-Za-z_$][\w$]*)/g,
  )) {
    const resolvedValues = objectConstants.get(m[1]);
    if (resolvedValues) values.push(...resolvedValues);
  }
}

/**
 * Every string a `className` ATTRIBUTE contributes to the rendered class
 * list — the plain-literal case handled directly, the `{…}` expression case
 * delegated to `extractFromExpression` above.
 */
function extractClassNameValues(source: string): string[] {
  const clean = stripComments(source);
  const constants = collectStringConstants(clean);
  const objectConstants = collectObjectStringConstants(clean);
  const values: string[] = [];

  for (const m of clean.matchAll(/\bclassName\s*=\s*"([^"]*)"/g)) {
    values.push(m[1]);
  }

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
    extractFromExpression(clean.slice(start + 1, end), constants, objectConstants, values);
  }

  return values;
}

/** This surface's ONE sanctioned uppercase/tracking pairing — the kicker,
 * `design/system/client.html`'s own `.kicker` (:117-120) at 0.18em. See this
 * file's header comment, point 3, for why the rule is an ALLOWLIST rather
 * than #135's outright ban: unlike `/dashboard`, this surface has a
 * legitimate uppercase device, so the guard has to name it rather than
 * forbid the whole shape. */
const SANCTIONED_KICKER_TRACKING = "tracking-[0.18em]";

function findViolations(classValue: string): string[] {
  const tokens = classValue.split(/\s+/).filter(Boolean);
  const found: string[] = [];

  if (tokens.includes("wrap")) {
    found.push(`the marketing "wrap" column: "${classValue}"`);
  }
  if (tokens.includes("label")) {
    found.push(
      `globals.css's "label" class (0.22em, the marketing site's own eyebrow value — this ` +
        `surface's kicker is 0.18em): "${classValue}"`,
    );
  }
  if (tokens.includes("uppercase") && !tokens.includes(SANCTIONED_KICKER_TRACKING)) {
    found.push(
      `"uppercase" without this surface's sanctioned ${SANCTIONED_KICKER_TRACKING} kicker ` +
        `pairing — the marketing CTA's own uppercase/tight-tracking shape: "${classValue}"`,
    );
  }

  return found;
}

describe("no surviving marketing chrome under /galleries (task #149)", () => {
  it("found at least one file to guard, so an empty set cannot pass vacuously", () => {
    expect(FILES_UNDER_GUARD.length).toBeGreaterThan(5);
  });

  it.each(FILES_UNDER_GUARD)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    const violations = extractClassNameValues(source).flatMap(findViolations);

    expect(violations, violations.join("\n")).toEqual([]);
  });

  // Epic #140's own hard rule, restated in its body: "el cliente elige sus
  // fotos desde el teléfono... ninguna media query `max-width`." Checked over
  // RAW source (comments stripped, so a comment explaining the rule — like
  // this file's own header, or `src/app/galleries/layout.tsx`'s — is never
  // mistaken for a live one), not through the className extraction above: a
  // media query cannot live inside a `className` attribute in the first
  // place, so this is independent regression insurance, not a second pass
  // over the same data.
  it.each(FILES_UNDER_GUARD)("%s has no @media (max-width) query", (file) => {
    const clean = stripComments(readFileSync(file, "utf8"));
    expect(clean).not.toMatch(/@media\s*\(\s*max-width/);
  });
});
