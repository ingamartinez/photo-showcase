import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Task #175. THE app-surface alias list, parsed out of the stylesheet that
// declares it, for the two guards that have to agree about what the list is.
//
// `src/app/globals.css` is the source of truth: its `@theme inline` block is
// what actually creates the global `app-*` utilities. Two things must track it
// exactly, and a hand-maintained copy in either of them is a hole rather than a
// duplication:
//
//   * `src/app/globals.tokens.test.ts` — asserts every alias compiles to a
//     `var(--app-*)` REFERENCE, so a leak outside `[data-surface="app"]` is
//     inert instead of wrong. A snapshot list here silently exempts any alias
//     added later, which is exactly the defect this file was written to close:
//     the first version of that guard enumerated four colours by hand and
//     stayed green when a fifth was added with a literal right-hand side.
//   * `eslint.config.mjs` — restricts those classnames to the dashboard tree.
//     Its matcher is anchored on the TOKEN NAMES rather than on a denylist of
//     utility prefixes, which is what makes `border-t-app-raised` and
//     `ring-offset-app-raised` findings while leaving `my-app-name` alone. That
//     anchoring only works if the names are the real ones.
//
// This module is `.mjs` because `eslint.config.mjs` is loaded by ESLint itself,
// with no TypeScript transform in front of it. It lives in `tooling/` (dev-time
// tools, staged by nothing) rather than `scripts/` (ops, deployed wholesale) —
// see the split documented in eslint.config.mjs.

const GLOBALS_CSS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/app/globals.css",
);

/**
 * Every `--color-app-*` / `--text-app-*` entry declared in a stylesheet's
 * `@theme inline` block.
 *
 * Scoped to that block deliberately. Reading the whole file would also pick up
 * any `--color-app-…:` sequence that happens to appear in a comment, and this
 * file's whole job is to know the real list — a guard that can be widened by
 * prose is not a guard. The block is terminated on a closing brace in the first
 * column, because the comments inside it legitimately contain braces (they
 * quote compiled CSS rules).
 *
 * @param {string} css
 * @returns {ReadonlyArray<{ namespace: "color" | "text", token: string, alias: string, value: string }>}
 *   `namespace` is the Tailwind theme namespace, `token` the name after
 *   `app-` (`raised`, `base`), `alias` the utility suffix (`app-raised`) and
 *   `value` the verbatim right-hand side (`var(--app-raised)`).
 */
export function parseAppThemeAliases(css) {
  const block = /@theme[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1];

  if (block === undefined) {
    throw new Error("app-theme-tokens: no @theme block found — the alias list cannot be trusted");
  }

  return [...block.matchAll(/--(color|text)-app-([a-z0-9-]+):\s*([^;]+);/g)].map((match) => ({
    namespace: /** @type {"color" | "text"} */ (match[1]),
    token: match[2],
    alias: `app-${match[2]}`,
    value: match[3].trim(),
  }));
}

/** The aliases declared by this repo's own `src/app/globals.css`. */
export const APP_THEME_ALIASES = parseAppThemeAliases(readFileSync(GLOBALS_CSS, "utf8"));

/**
 * Source text for a regular expression matching an `app-*` Tailwind classname.
 *
 * ANCHORED ON THE TOKEN NAMES, not on a list of utility prefixes. The first
 * version of the lint rule enumerated the prefixes it knew (`bg`, `text`,
 * `border`, …) and therefore missed every one it did not — `border-t-app-raised`,
 * `border-x-app-danger`, `ring-offset-app-raised`, `inset-ring-app-raised` and
 * `inset-shadow-app-raised` all compile to live rules and all walked straight
 * through it. The prefix list was chosen to avoid matching innocent strings
 * like `"my-app-name"`, and that trade turns out to be unnecessary: requiring
 * the segment after `app-` to be a REAL token name rejects those on its own,
 * and accepts any utility prefix, including ones that do not exist yet.
 *
 * The trailing `[^a-z0-9-]|$` keeps `app-base` from matching inside
 * `app-baseline`.
 *
 * @param {ReadonlyArray<{ token: string }>} aliases
 * @returns {string}
 */
export function appUtilityClassPattern(aliases = APP_THEME_ALIASES) {
  const tokens = [...new Set(aliases.map(({ token }) => token))];

  if (tokens.length === 0) {
    // A pattern built from an empty alternation matches nothing at all, which
    // would leave the lint rule silently passing everything. Fail loudly.
    throw new Error(
      "app-theme-tokens: no app-* aliases found — the lint guard would match nothing",
    );
  }

  return `(^|[\\s:])[a-z][a-z-]*-app-(${tokens.join("|")})([^a-z0-9-]|$)`;
}
