---
name: Alejo Frames
description: A backstage-mirror photography world — warm velvet ground, one amber bulb accent, costume colour only in the photographs.
colors:
  bg: "#1a1512"
  bg-2: "#221c18"
  bg-sunken: "#120e0c"
  fg: "#f0ebe3"
  fg-dim: "#b3a898"
  fg-mute: "#8f8474"
  line: "#3a454b"
  line-2: "#2a3236"
  accent: "#e8a54b"
  accent-2: "#f0b35e"
  accent-deep: "#c47a2d"
  canvas: "#cfc3ae"
  canvas-dim: "#9a8f7c"
  steel: "#6b7a82"
  danger: "#d9695a"
  ink: "#1a1512"
typography:
  display:
    fontFamily: "Bodoni Moda, Georgia, serif"
    fontSize: "clamp(2.75rem, 8vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Bodoni Moda, Georgia, serif"
    fontSize: "clamp(2.125rem, 5.5vw, 4.25rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.015em"
  head:
    fontFamily: "Bodoni Moda, Georgia, serif"
    fontSize: "clamp(1.625rem, 3.6vw, 2.75rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.015em"
  sub:
    fontFamily: "Bodoni Moda, Georgia, serif"
    fontSize: "clamp(1.25rem, 2.2vw, 1.75rem)"
    fontWeight: 400
  lead:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(0.9375rem, 1.5vw, 1.125rem)"
    fontWeight: 400
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.1em"
  data:
    fontFamily: "Sometype Mono, ui-monospace, monospace"
    fontFeature: "tabular-nums"
rounded:
  sm: "2px"
  md: "3px"
  lg: "4px"
  app-sm: "5px"
  app: "8px"
spacing:
  gutter: "clamp(20px, 5vw, 72px)"
  app-tap: "44px"
  app-cell-x: "14px"
  app-pad-card: "16px"
  app-gap: "12px"
  app-row-h: "52px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "14px 28px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.accent-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "14px 28px"
    height: "44px"
  button-outline:
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "9px 18px"
  button-outline-hover:
    textColor: "{colors.accent-2}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "9px 18px"
  button-app:
    textColor: "{colors.fg}"
    typography: "{typography.lead}"
    rounded: "{rounded.app-sm}"
    padding: "0 16px"
    height: "44px"
  button-app-hover:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.fg}"
    typography: "{typography.lead}"
    rounded: "{rounded.app-sm}"
    padding: "0 16px"
    height: "44px"
  proof-pick:
    backgroundColor: "rgb(26 21 18 / 0.42)"
    textColor: "{colors.fg}"
    rounded: "9999px"
    size: "48px"
  proof-pick-selected:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "9999px"
    size: "48px"
  proof-type-option:
    textColor: "{colors.fg}"
    rounded: "9999px"
    padding: "4px 6px"
  proof-type-option-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "9999px"
    padding: "4px 6px"
  download-pill:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "9999px"
    padding: "4px 12px"
  hero-identity-edge:
    textColor: "{colors.fg}"
    typography: "{typography.data}"
    width: "44px"
---

# Design System: Alejo Frames

## Overview

**Creative North Star: "El Espejo del Backstage"**

Every surface is the getting-ready mirror where a person becomes the character. The ground is warm velvet darkness (`#1a1512`), lit by one practical amber bulb — the single saturated accent in the entire product. Structure lines are cool mirror-steel. Labels sit in a canvas neutral. Costume and set colour arrive **only** through the photographs; the interface itself never introduces a second hue. The visitor's remembered moment is a single reveal: a proof coming into focus as it becomes a chosen final.

The type pairing is a fashion-show display face (Bodoni Moda) over a call-sheet workhorse (Archivo), with mono (Sometype Mono) held in reserve for measurements, quota, and money. Density is editorial and slow on the public portfolio and the client gallery; the admin dashboard is the same brand at working density, scoped so it cannot leak.

This is a three-surface, one-world system: the public portfolio and the client gallery share the editorial system directly; `/dashboard` is a second **layer**, not a second brand, isolated behind a `[data-surface="app"]` attribute so its softer radii and sans scale can never reach a photograph.

**Key Characteristics:**

- One saturated accent (bulb amber); every other value is warm dark, cool steel, or light neutral.
- Photographs carry all costume colour; chrome recedes.
- Bodoni Moda display / Archivo UI / Sometype Mono data — three roles, no overlap.
- Two CSS surfaces, one brand: editorial default, `[data-surface="app"]` for the dashboard.
- Exactly three authored motion moments; everything else is still.
- Mobile-first is a hard constraint on the client path — the phone is the primary case, not the degraded one.
- UI copy is neutral Spanish (no voseo). English is for technical artifacts only.

**Decided and open.** The palette, type trio, two-surface split, motion budget, and neutral-Spanish voice are settled invariants. Open, and honest about it: (1) the `/galleries` status chip fails WCAG 1.4.3 over bright cover photos — inherited design debt, measured at 1.16:1 worst case, tracked separately with the owner; (2) the proof-tile pick control's soft outer shadow is a luminance gradient, not a conforming 3:1 boundary, and the only conforming fix is a materially darker disc that changes the mock's palette — owner's call; (3) voseo strings still present in the codebase are migration debt against the voice rule below, not a licence to keep them.

## Colors

One practical bulb against warm velvet: a single amber accent, three warm darks, three light label tones, and a cool steel family reserved for structure. Nothing else is saturated.

### Primary

- **Bulb Amber** (`#e8a54b`): the only saturated colour in the product. Deliberate accent _fills_ only — the primary CTA, the selected-asset frame and badge, the unread/current dot, the pick control when pressed, the wordmark's second word. It marks "act now" and nothing else.
- **Bulb Amber Bright** (`#f0b35e`): the hover/step-up of the amber fill, and the tone for state text that must read as "waiting on you" (the `pending` gallery chip). Never a ground.
- **Bulb Amber Deep** (`#c47a2d`): the pressed/step-down of the amber fill. Held for state depth; rarely a standalone surface.

### Neutral

- **Warm Velvet Ground** (`#1a1512`): the page ground of every editorial surface. Also the `ink` value for text on saturated fills.
- **Velvet Raised** (`#221c18`): one step up — hover washes, popover/dialog surfaces, image-tile placeholder boxes.
- **Velvet Deep** (`#120e0c`): sunken wells and scrollbar tracks. On the dashboard this inverts into the working ground.
- **Powder Ivory** (`#f0ebe3`): primary text and headings.
- **Dim Powder** (`#b3a898`): secondary text, ledes, and meta over photographs.
- **Muted Powder** (`#8f8474`): quiet labels, captions, disabled explanations. The faintest text tone in the system.
- **Canvas Neutral** (`#cfc3ae`): the label neutral — `done` state text, editorial label moments. A light warm grey, never a ground.
- **Canvas Neutral Dim** (`#9a8f7c`): the step-down of the label neutral.
- **Velvet Ink** (`#1a1512`): ink for text that sits on a saturated fill (amber or danger). Same value as the ground, so one dark serves both. `#1a1512` on `#e8a54b` measures 8.55:1.

### Structure

- **Mirror Steel** (`#3a454b`): every border, divider, and structural line. Cool against the warm ground — the mirror's frame, not the room.
- **Mirror Steel Soft** (`#2a3236`): quieter borders — inputs, secondary button outlines, scrollbar thumbs.
- **Steel Mid** (`#6b7a82`): the steel family's middle tone; available for structure that must read above a border.

### Tertiary

- **Alert Coral** (`#d9695a`): destructive and invalid states only. One red, app-wide — a danger button and an invalid field share this hue.

### Named Rules

**The One Bulb Rule.** Amber is the only saturated colour in the UI. A second accent hue is never introduced for status, categories, or decoration — `done` state text is a neutral, not a green. Saturated costume colour lives inside photographs and nowhere else.

**The Fill-Not-Wash Rule.** Amber is a _fill_, never a hover or focus wash. Hover and focus surfaces are `--bg-2` (or `--app-raised` on the dashboard); even the current nav item does not fill with amber — only its icon does. A component that wants "highlighted" gets an amber _fill_ with ink on top, or it gets nothing.

**The Ink-On-Fill Rule.** Text on any saturated fill (amber or coral) is `--ink` (`#1a1512`), never `--fg`. `--fg` on amber measures ~2:1 and is a defect; `--ink` measures 8.55:1.

## Typography

**Display Font:** Bodoni Moda (fallback Georgia, serif) — high-contrast serif with optical sizing, normal and italic.
**Body Font:** Archivo (fallback system-ui, sans-serif) — the UI workhorse.
**Label/Mono Font:** Sometype Mono (fallback ui-monospace, monospace) — data only.

**Character:** A fashion-show display face over a call-sheet workhorse. The serif carries names, headlines, and the emotional register; the sans disappears into controls and running copy; mono is reserved for numbers that change — prices, counts, quota, dimensions, file positions — and is never worn as a decorative "technical" costume.

### Hierarchy

- **Display** (Bodoni Moda 400, `clamp(2.75rem, 8vw, 6rem)`, line-height 0.98, tracking -0.015em): the hero headline only. Capped at 6rem. Balanced, never wider than ~13ch.
- **Title** (Bodoni Moda 400, `clamp(2.125rem, 5.5vw, 4.25rem)`, line-height 1.05): page headings — the client gallery index, dashboard page headers.
- **Head** (Bodoni Moda 400, `clamp(1.625rem, 3.6vw, 2.75rem)`, line-height 1.05): in-page headings — gallery detail titles, section anchors.
- **Sub** (Bodoni Moda 400, `clamp(1.25rem, 2.2vw, 1.75rem)`): collection titles, pull-quote scale, card titles at rest.
- **Lead** (Archivo 400, `clamp(0.9375rem, 1.5vw, 1.125rem)`): running copy. Held to a 70ch measure (`.measure`) — 65–75ch is the reading band and 70ch is the midpoint.
- **Label** (Archivo 600, 13px, tracking 0.1em, uppercase): action labels on the editorial surfaces — the CTA family. See the case rule below for where uppercase is allowed at all.
- **Data** (Sometype Mono, tabular figures): prices, counts, quota, dimensions, proof positions. Implemented as `.num` — mono family plus `font-variant-numeric: tabular-nums`, so digits stay aligned when values change.

The dashboard uses a separate sans scale at working density, scoped under `[data-surface="app"]`: micro 11px, meta 12px, body 13px, base 14px, lead 16px, head 20px, title 22px (26px at ≥1024px), line-height 1.5. Brand font families are reused, not replaced.

### Named Rules

**The Mono-Is-Data Rule.** Sometype Mono appears only on numbers and measurements (`.num`). Never as a decorative eyebrow, never as a "technical" label costume, never on running copy.

**The Measure Rule.** Body copy is capped at 70ch (`.measure`). Display and title lines are capped by character count in markup (~13–24ch) and balanced (`text-balance`), not by the measure.

**The Case Rule.** The tracked small-caps eyebrow is a retired device. `uppercase` is allowed only as a _quiet_ label treatment — wide tracking (≥0.06em) paired with small size on genuine field labels and micro-labels — and the marketing CTA's `uppercase` + 0.1em-tracked 13px shape never returns to the dashboard or the client gallery. Guards: `src/app/galleries/marketing-styling.test.ts`, `src/app/dashboard/marketing-styling.test.ts`.

## Layout

**Spatial model.** An editorial centred column (`.wrap`: max-width 1280px, gutters `clamp(20px, 5vw, 72px)`) for the public portfolio and the client gallery. The first viewport breaks that column on purpose: a full-bleed, 100svh **split mirror** — the photograph fills the frame, identity sits at the right edge the way a name is written on a mirror's frame, and one action sits low and left over a calm area of the image.

**Client gallery.** Hard mobile-first: no `max-width` media query anywhere on `/galleries/**`. The proof grid is a uniform two-column index at `gap: 2px` with `aspect-ratio: 2/3` reserved boxes (zero CLS) — the grid is only the index; a photo is judged whole in the lightbox. Pick controls live in the bottom-right thumb path.

**Dashboard.** Same brand, working density. One navigation element that is a fixed bottom tab bar (58px) on a phone and a 236px sidebar column at ≥1024px. Content padding clears the tab bar. Rows become an aligned 52px table only at desk width; at phone width a row is a variable-height stacked card.

**Portfolio grids.** Collections: asymmetric 6-column grid, 14px gaps, first tile spanning 2×2 (two columns below 900px). Work: justified masonry via CSS columns — 3 / 2 / 1 at 900px / 560px.

**Spacing rhythm.** Editorial spacing is generous and few-stepped. The dashboard declares one density vocabulary so every table and list agrees: cell-x 14→16px, card padding 16→18→20px, gap 12→14→20px at 600px / 1024px. Touch targets: 44px minimum everywhere; the proof pick control is 48px.

**Breakpoints (observed):** 560px, 600px, 900px, 1024px. The dashboard is `min-width` only (mobile-first, queries only add). Portfolio grid queries are `max-width` (desktop-composed grids collapsing) — an accepted asymmetry, not a template to copy.

## Elevation & Depth

This system is **flat by default**. Depth is tonal: three warm darks (sunken → ground → raised) layer surfaces against each other, and photographs are seated by gradient scrims rather than lifted by shadow. Borders are 1px cool steel. There is no shadow vocabulary and no ambient drop-shadow family.

Two shadows exist in the build, both as **local accessibility concessions over photographs**, both declared deviations from the reference mock, and neither is a system rule to inherit:

- The proof pick control carries `0 1px 6px rgb(26 21 18 / 0.6)` — a luminance gradient so the affordance reads at every photo tone. It is _not_ a conforming 3:1 boundary (≈1.25:1 against the disc); see Open items in Overview.
- The proof position number carries `0 1px 2px rgb(26 21 18 / 0.9)` as a text backing over bright photographs.

Controls that sit over photographs use `backdrop-filter: blur(6px)` and a translucent dark disc — translucency and blur, not elevation.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat. Depth comes from tonal layering and scrims. Do not add drop shadows to cards, buttons, or panels; the only shadows in this system are photo-legibility concessions and carry their own debt note.

## Shapes

**Form language: picture-frame precision, softened only where hands work.** The editorial radii are tiny — 2px / 3px / 4px (`--radius-sm` / `md` / `lg`) — so cards and image tiles read as cut frames, not friendly app chrome. Collections and work tiles use 3px. The hero CTA and outline buttons use 2px.

The dashboard deliberately softens: 5px (`--app-radius-sm`) on buttons and small controls, 8px (`--app-radius`) on cards and panels — a work surface should not look razor-cut. These are separate tokens (`--app-radius*`) because `--radius-*` compile to frozen literals and cannot be re-skinned by a scope; each softened corner is an explicit per-component choice.

The one recurring silhouette beyond rectangles is the **full circle/pill**: the proof pick control (48px circle), the selection-type control (pill), and the download pill (pill). Circular controls are reserved for actions that sit _on top of a photograph_ — the mirror's round hardware against the frame's right angles.

Borders are 1px `--line` / `--line-2`. The selected-photo frame is a 3px amber inset. Buttons never carry a default border except the outline family and the app-surface plain button (1px `--line-2`).

## Components

### Buttons

- **Shape:** editorial family is nearly square (2px radius); app family is softly rounded (5px); photo-overlay actions are full pills.
- **Primary (editorial CTA):** amber fill (`#e8a54b`) with ink text (`#1a1512`), 14px × 28px padding, 44px minimum height, Archivo 600 / 13px / 0.1em tracking / uppercase, 2px radius. Hover steps to Bulb Amber Bright (`#f0b35e`). A 26px horizontal-padding variant exists on `/about`. One primary per view — "one action, not a row of buttons."
- **Outline (header/nav):** transparent, 1px `--line-2` border, `--fg` text, 9px × 18px padding, same label typography. Hover moves border and text to amber. Never filled.
- **App plain (deliver, publish, unlock):** transparent with 1px `--line-2` border, `--fg` text at Archivo 14px (not the uppercase label), 16px horizontal padding, 44px height on a phone / 24px at desk, 5px radius. Hover is a `--bg-2` wash with `--fg-mute` border — never an amber wash. Disabled is 50% opacity with a not-allowed cursor.
- **App secondary / destructive:** 36px height, 12px semibold uppercase at 0.04em tracking, 4px radius. Destructive is coral border and text; its hover is a coral fill with ink text.
- **Focus:** a single global treatment — 2px amber outline, 3px offset. No component invents its own ring.

### Chips / Status

- **Style:** plain small text with a 5px current-colour dot — no pill, no border, no background. Tones: `pending` = Bulb Amber Bright (the state that asks the client to act), `waiting` = Dim Powder, `done` = Canvas Neutral.
- **Known gap:** over a bright cover photograph these tones measure 1.84:1 / 1.16:1 / 1.35:1 — below WCAG 1.4.3. The card's title and meta lines were contrast-corrected (7.08:1 / 5.42:1) via an explicit 8%/62%/100% scrim; the chip was not. Carried as open debt, not as a rule.

### Cards / Containers

- **Gallery card (photo):** 16:10 reserved box, 3px radius (`rounded-sm`), transparent border that goes amber-tinted on hover. Text sits on a bottom-to-top scrim — `linear-gradient(to top, rgb(26 21 18 / 0.92) 8%, rgb(26 21 18 / 0.15) 62%, transparent)` — and those stops are load-bearing: Tailwind's default 0/50/100 gradient fails contrast at the title and meta.
- **Gallery card (no cover):** the bordered, text-only fallback on `--bg` — never a broken hole.
- **Portfolio tiles:** 3px radius, overflow hidden, images dimmed at rest (`saturate 0.92 / brightness 0.82` collections; `brightness 0.9 / saturate 0.95` work) and brought up on hover with a slow scale (1.06 / 1.04).
- **App cards/panels:** 8px radius, `--app-surface` or `--app-raised` fills on `--app-ground`, no shadow, 16–20px padding.

### Inputs / Fields

- **Style:** transparent background, 1px `--line-2` border, 2px radius, 12px padding. Labels are quiet uppercase at wide tracking (`text-xs`, 0.05em+) in `--fg-mute` — a label style, not a mono eyebrow.
- **Focus:** the global amber outline (2px / 3px offset).
- **Error:** `--danger` text at small size beside the field; invalid borders use the same coral.

### Navigation

- **Editorial header:** wordmark in Bodoni Moda at 22px, links at 13px / 0.08em tracking / uppercase in Dim Powder, hover to Ivory. Outline CTA at the right. Hidden below `sm` except the wordmark and CTA.
- **Hero identity edge:** the signature nav device — a 44px (48px at `md`) vertical strip on the right edge, left-bordered in `--line` at 50%, carrying `Medellín` (10px, 0.22em, vertical-rl), the wordmark vertically (`Alejo` in Ivory, `Frames` in amber, Bodoni 15px), and a 1px × 32px amber tick. Never a centred wordmark over the photograph.
- **Dashboard nav:** one element, two shapes — fixed bottom tab bar (58px, three columns, `--app-surface`) on a phone; 236px sidebar at ≥1024px. Current item's icon takes the amber; the row itself does not fill.
- **Client gallery header:** one link, no nav — the client arrives by magic link at one gallery and does not browse.

### Signature: The Proof Tile

The client's decision surface, designed for 84 proofs, 15 picks, one hand, at night.

- **Box:** uniform `aspect-ratio: 2/3`, `--bg-2` placeholder, reserved before the image arrives (zero CLS). Position number in the top-left — mono 10px, Ivory at 55%, tabular, with a text backing for bright proofs.
- **Pick control:** 48px circle, bottom-right in the thumb path, separate from the photo body so _looking_ and _choosing_ are never the same gesture. Unpicked: translucent velvet disc (`rgb(26 21 18 / 0.42)`) with an Ivory ring at 50%, 6px backdrop blur. Picked: amber fill with ink. Disabled at 60% opacity once locked.
- **Picked is never colour alone** — three redundant channels: a check glyph (shape), a 3px amber inset frame (structure), and a slight luminance lift on the photo (`brightness(1.06) saturate(1.04)`). `aria-pressed` carries the same fact.
- **Type control (Editada / Original):** renders only once a photo is picked and only when the gallery allows original selection. Two explicit buttons in a pill, not one flipping button. Absent, never zeroed.
- **Download pill:** bottom-left, amber fill with ink, only when the gallery is delivered and that asset has a final. Never at the same time as the type control.

### Signature: The Quota Counter

Two lines, always, at every count. Line one is the identity of the pick (`incluidas N · seleccionadas M`) in Bodoni at `text-lg`. Line two is the money conversation in Muted Powder at `text-sm`, always carrying "se coordina por fuera de la app; acá no se cobra nada." All three parts render even when extras are 0 — going over quota is never an error and never a scold. Numbers use `.num`. When originals are enabled and used, two further lines appear (originals tariff, then total); when the count is zero the lines are **absent, not zeroed**.

### Icons

Authored SVG only — one stroke weight (1.5), one cap/join style (round), `currentColor`, 1em box. The set is `ArrowRight`, `ArrowLeft`, `Check`. Unicode glyphs are not an icon system; anything that reads as an affordance is drawn here. Never emoji, never an icon font.

## Do's and Don'ts

### Do:

- **Do** let the photograph lead: full-bleed imagery, interface chrome at the edges, one action per view.
- **Do** use amber only as a deliberate fill with `--ink` on top — CTA, selected frame, pressed pick control, act-now dots.
- **Do** keep mono on numbers and measurements only, with tabular figures (`.num`).
- **Do** hold running copy to 70ch (`.measure`) and cap display lines by character count with `text-balance`.
- **Do** reserve boxes before images arrive (fixed `aspect-ratio`) — zero CLS is a contract, not a nicety.
- **Do** keep every touch target ≥44px and put photo-overlay actions in the bottom thumb path (48px pick control, bottom-right).
- **Do** express "picked/selected" through at least two non-colour channels (shape, structure, luminance) plus ARIA state.
- **Do** keep commercial terms legible in every state: included count, selection count, extras, and the "outside the app" reminder are never hidden.
- **Do** write UI copy in neutral Spanish — direct, warm, professional. "Selecciona las fotos", never "Seleccioná las fotos".
- **Do** scope dashboard-only tokens and classes behind `[data-surface="app"]` / `app-*`, and keep them out of editorial routes (enforced by ESLint and `globals.tokens.test.ts`).
- **Do** respect `prefers-reduced-motion: no-preference` as the gate on every authored animation.

### Don't:

- **Don't** introduce a second saturated hue — no status greens, no category colours, no decorative tints. The One Bulb Rule.
- **Don't** use amber as a hover or focus wash. Hovers are `--bg-2` washes or border/ink shifts; the focus ring is amber outline only.
- **Don't** put `--fg` (or any light text) on an amber or coral fill — use `--ink`.
- **Don't** add a fourth authored animation. The budget is three named moments (below); everything else stays still.
- **Don't** bring back the tracked small-caps mono eyebrow (`.label`), and don't pair `uppercase` with tight tracking on the client gallery or dashboard.
- **Don't** use the marketing CTA shape (uppercase, 0.1em tracked, 13px) on dashboard buttons.
- **Don't** use Bodoni Moda as a display face under `/dashboard` — the wordmark at 18px is the single exception; the dashboard is a sans working surface.
- **Don't** use Unicode glyphs or emoji as icons; draw them in `src/components/icons.tsx`.
- **Don't** add drop shadows, glows, or elevation to cards, panels, or buttons.
- **Don't** centre a wordmark over a photo hero. Identity belongs at the edge (the hero identity device).
- **Don't** use voseo or regional slang in UI copy (`cargás`, `armás`, `podés`, `tenés` are migration debt, not house style).
- **Don't** watermark proofs in CSS or markup — the mark is composited into the bytes at upload.
- **Don't** fabricate testimonials, press, or client quotes; none exist.

### The Three Moments

Exactly three authored animations exist in the system, all exponential ease-out (`cubic-bezier(0.16, 1, 0.3, 1)`), all gated on `prefers-reduced-motion: no-preference`, all `both` fill so the end state persists:

1. **Mirror Focus** (`.mirror-focus`, 1.5s) — the hero photograph's one entrance: blur 10px → 0, opacity 0.65 → 1. It starts already visible, so the frame is never blank waiting on motion. The public site's only entrance.
2. **Selection Reveal** (`.selection-reveal`, 0.7s) — the memorable moment: picking a proof pulls it into focus the way a face resolves in a mirror (blur 5px → 0, brightness 1.14 → 1.06, saturate 0.9 → 1.04). Plays once on selection; deselection is instant and quiet.
3. **Delivery Announce** (`.delivery-announce`, 0.9s) — delivery is the walk: one theatrical announce (opacity 0 → 1, letter-spacing 0.14em → 0), then stillness.

**The Three Moments Rule.** These three are the entire motion budget. No scroll reveals, no looping ambience, no entrance cascades, no parallax. Hover feedback is limited to brief colour transitions and the portfolio tiles' slow image scale — state response, not a moment. A fourth moment is a design decision, not an implementation detail.
