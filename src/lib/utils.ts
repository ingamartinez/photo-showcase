import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The app surface's font-size scale, as tailwind-merge class-name suffixes
 * (task #175). Must stay in sync with the `--text-app-*` entries in
 * `src/app/globals.css` — `src/app/globals.tokens.test.ts` fails if it drifts.
 *
 * WHY THIS LIST HAS TO EXIST AT ALL, because it looks like ceremony and is not.
 * Tailwind's `text-*` prefix is shared by two class groups, font size and text
 * colour, and tailwind-merge decides which one a class belongs to by looking at
 * the SUFFIX: a t-shirt size (`text-xs`) or an arbitrary value carrying an
 * explicit `length:` type hint is a size, and ANYTHING ELSE is a colour. It has
 * no access to the compiled theme, so a custom scale is invisible to it.
 *
 * Left unconfigured, `cn("text-app-micro", "text-fg-mute")` returns
 * `"text-fg-mute"` — verified, not assumed. tailwind-merge reads both as text
 * colours, decides the later one wins and DROPS THE FONT SIZE ENTIRELY. That is
 * silent: the className is still a valid string, the element still renders, it
 * just renders at the inherited size. `src/components/dashboard-nav.tsx` pairs a
 * size and a colour in exactly this shape, and #131-#134 will do it again.
 *
 * This is also why the arbitrary values these aliases replaced all spelled the
 * `length:` hint out: it was doing this same job inline, at every call site.
 * Naming the scale moved that job here.
 *
 * NOTE ON HOW THAT IS WORDED. No comment in a scanned source file may spell a
 * Tailwind class out in bracket syntax. Tailwind v4 generates a utility from
 * ANY candidate string it finds, comments included (globals.css records the
 * same finding for `--radius-sm`), and a prose ellipsis inside the brackets
 * compiles to a real, invalid rule — `font-size: ...` was measured shipping in
 * the production stylesheet from an earlier draft of this very paragraph.
 */
export const APP_FONT_SIZES = [
  "app-micro",
  "app-meta",
  "app-body",
  "app-base",
  "app-lead",
  "app-head",
  "app-title",
] as const;

/**
 * WHY THIS IS ITS OWN GROUP AND NOT AN EXTENSION OF `font-size`.
 *
 * The obvious fix — appending the scale to tailwind-merge's built-in
 * `font-size` group — fixes the colour collision above and immediately
 * introduces its mirror image, because that group also carries
 * `conflictingClassGroups: { "font-size": ["leading"] }`. In stock Tailwind
 * that rule is CORRECT: a built-in size utility emits a font size AND a line
 * height, so a leading utility written before it is genuinely superseded.
 *
 * These aliases emit font-size ONLY — there is no line-height declaration in
 * the compiled rule at all. Folded into `font-size` they inherit the conflict
 * anyway, so a leading utility followed by an app size returns just the size:
 * the line height deleted, and nothing emitted to replace it. Silent, and
 * order-dependent — the same pair written the other way round keeps both.
 * src/lib/utils.test.ts pins both orders.
 *
 * So the group is separate and declared to conflict with `font-size` in BOTH
 * directions (a real size still replaces an app size and vice versa, which is
 * what a call site means by writing either), and with nothing else. Measured:
 * against the shipped alternative this changes exactly one pairing — a leading
 * utility before an app size now survives — and leaves every other combination,
 * including all stock Tailwind behaviour, byte-identical.
 *
 * REJECTED ALTERNATIVE: declaring `--text-app-*--line-height` companions in
 * `@theme` so the utilities really do emit a line height. That would make the
 * conflict rule honest, but it means choosing a line height per step, and #128
 * deliberately made `--app-line-height` a SINGLE root-level value the whole
 * surface inherits. Picking seven of them is a design decision, this slice has
 * no mandate for it, and applying the one value to all seven would put 1.5 on
 * the largest step at 26px. Modelling what the CSS actually emits is the change
 * that carries no design opinion.
 *
 * (No class is named anywhere in this comment, deliberately — see the note on
 * APP_FONT_SIZES above. This file is scanned by Tailwind, and an earlier draft
 * of these paragraphs shipped two dead utilities into the production
 * stylesheet purely by quoting them.)
 */
const twMerge = extendTailwindMerge<"app-font-size">({
  extend: {
    classGroups: {
      "app-font-size": [{ text: [...APP_FONT_SIZES] }],
    },
    conflictingClassGroups: {
      "app-font-size": ["font-size"],
      "font-size": ["app-font-size"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
