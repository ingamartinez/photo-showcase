/* eslint-disable no-restricted-syntax -- This file's whole subject is how
   `cn()` classifies the `app-*` classnames, so it has to name them. It is the
   one sanctioned exception to the rule declared in eslint.config.mjs; it ships
   no markup, so no `app-*` class can leak onto a page from here. */
import { describe, expect, it } from "vitest";
import { APP_FONT_SIZES, cn } from "./utils";

// Task #175. `cn()` is `twMerge(clsx(...))`, and twMerge decides which class
// group a `text-*` class belongs to from its SUFFIX alone — it has no access to
// the compiled Tailwind theme. A t-shirt size or an explicitly-typed arbitrary
// value (`text-[length:…]`) is a font size; ANYTHING ELSE is a text colour.
//
// So a custom `text-app-base` reads as a colour, and the LAST colour in a cn()
// call wins: the font size is not overridden, it is DELETED from the output
// string. Nothing throws, nothing logs, the element just renders at the
// inherited size. src/components/dashboard-nav.tsx pairs a size and a colour in
// exactly this shape and #131-#134 will do it again, which is why utils.ts
// teaches twMerge the scale instead of leaving each call site to remember.
describe("cn() keeps the app-surface font sizes out of the colour group", () => {
  it.each([...APP_FONT_SIZES])("keeps text-%s when a text colour follows it", (size) => {
    const result = cn(`text-${size}`, "text-fg-mute");

    // Both, in order — not "contains the size somewhere".
    expect(result).toBe(`text-${size} text-fg-mute`);
  });

  it("keeps the pair across a variant, which is how the nav actually writes it", () => {
    expect(cn("lg:text-app-base", "lg:text-fg-dim")).toBe("lg:text-app-base lg:text-fg-dim");
  });

  it("still lets one app font size override another", () => {
    // The flip side: teaching twMerge the scale must not make these classes
    // inert to each other, or a conditional size would stop being conditional.
    expect(cn("text-app-micro", "text-app-base")).toBe("text-app-base");
  });

  it("still treats the app colour aliases as colours", () => {
    // `text-app-danger` is a `--color-*` entry, not a `--text-*` one, so it
    // must keep conflicting with other text colours.
    expect(cn("text-fg", "text-app-danger")).toBe("text-app-danger");
    expect(cn("bg-app-surface", "bg-app-raised")).toBe("bg-app-raised");
  });

  it("leaves the stock Tailwind behaviour alone", () => {
    // Guard against the extension being written as an `override` rather than an
    // `extend`, which would silently drop the built-in scale.
    expect(cn("text-xs", "text-fg-mute")).toBe("text-xs text-fg-mute");
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
