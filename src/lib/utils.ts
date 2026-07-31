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

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...APP_FONT_SIZES] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
