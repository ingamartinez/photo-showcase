"use client";

// ONE tile of the client's proof grid (task #23), split out of proof-grid.tsx
// by task #144. Presentational only: it holds no state, issues no request and
// decides nothing — every flag below is computed by <ProofGrid> and every
// click is handed straight back to it.
//
// TASK #145 REDESIGNED THIS FILE AGAINST design/system/client.html's `elegir`
// screen. The case being designed for is the one in that task's body: 84
// proofs, pick 15, one hand, on a phone, at night. Three things follow, and
// each is a line in the mock:
//
//   - THE PICK TARGET IS 48px AND SITS IN THE THUMB'S PATH (client.html:197-208
//     — "48px, bottom-right, thumb reach, and separate from the photo body so
//     tapping to LOOK and tapping to CHOOSE are never the same gesture"). It
//     used to be a text pill roughly 24px tall pinned to the TOP-right corner:
//     above the WCAG 2.5.8 24px floor by a hair, well under this task's own
//     44px requirement, and at the far end of the reach arc on a phone held in
//     one hand.
//   - PICKED IS NEVER COLOUR ALONE (client.html:213-215). Three redundant
//     channels, so the state survives a colour-blind reader, a sun-washed
//     screen and a greyscale print of a screenshot alike: a ✓ GLYPH inside the
//     circle (shape), a 3px INSET FRAME around the photo (structure), and the
//     photo itself brightening slightly (luminance). `aria-pressed` carries
//     the same fact to assistive tech, as it always did.
//   - THE WATERMARK IS IN THE BYTES, NOT IN THIS MARKUP. The mock draws
//     `.tile__wm` as rotated text (client.html:186-191) because its tiles are
//     CSS gradients with nothing to protect; here `processProof`
//     (src/lib/images.ts) composites the mark into the proof derivative
//     itself, and `images.guard.test.ts` refuses to emit a proof whose
//     watermark rasterized with no ink. Re-drawing it in CSS would be a second,
//     FAKE mark that a client could delete from the DOM in two seconds while
//     the real one stayed put — so this file deliberately does not. The only
//     filter this file ever applies to the photo is a PICKED tile's
//     `brightness-[1.06] saturate-[1.04]` (client.html:215, both of them),
//     nowhere near enough to wash the mark out; an unpicked tile gets none.
import { DownloadFinalButton } from "@/components/download-final-button";
import type { ProofAsset } from "@/components/proof-grid";
import type { SelectionKind } from "@/lib/selection-snapshot";

export function ProofTile({
  asset,
  position,
  src,
  isSelected,
  isPending,
  isLocked,
  showDownload,
  onError,
  onOpen,
  onToggleSelection,
  selectionKind,
  onSetSelectionKind,
}: {
  asset: ProofAsset;
  /** 1-based position in the grid, rendered in the tile's corner
   * (client.html:192-195 `.tile__n`). Scanning 84 near-identical proofs on a
   * phone is exactly when "the fourth one" stops being a usable way to talk
   * about a photo with the person sitting next to you — and `originalFilename`
   * (`IMG_4417.JPG`) is not that either. Display only; nothing keys off it. */
  position: number;
  src: string;
  isSelected: boolean;
  isPending: boolean;
  // Task #25: once submitted, every toggle button renders disabled — UX
  // only, see use-shared-selection.ts's own `toggleSelection`/`isLockedRef`
  // comment for the real, server-side gate this mirrors.
  isLocked: boolean;
  // Task #28: `<ProofGrid>`'s own `isDelivered && asset.hasFinal` — see that
  // component's header comment on `ProofAsset.hasFinal` for why this is a UI
  // hint only, never the real gate.
  showDownload: boolean;
  onError: () => void;
  onOpen: () => void;
  onToggleSelection: () => void;
  /** Task #206 — meaningless while `!isSelected` (schema.ts's own comment on
   * `assets.selectionKind`), and this tile only ever RENDERS the control
   * while `isSelected && !isLocked` (see below) — so a caller passing this
   * for an unselected asset is passing a value nothing here reads. */
  selectionKind: SelectionKind;
  onSetSelectionKind: (kind: SelectionKind) => void;
}) {
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Ver ${asset.originalFilename}`}
        className="focus-visible:ring-accent block w-full text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {/* THE BOX IS RESERVED BEFORE THE IMAGE ARRIVES — task #23's zero-CLS
            contract, unchanged. WHAT CHANGED in task #145 is that the reserved
            shape is now UNIFORM (`aspect-[2/3]`, client.html:181) instead of
            each asset's own `proofWidth / proofHeight`.

            This was not a preference, it was measured. The first build of this
            slice kept the per-asset ratio and was captured at 390px and 1440px
            (Playwright, the harness in e2e/). With landscape and portrait
            proofs mixed — the ordinary case — a two-column grid gives every
            row the height of its TALLEST tile, so each landscape tile sat in a
            box roughly twice its own height. Two things followed, and the
            second is a defect, not a taste:

              1. Around 40% of the phone's screen was empty black between
                 photos, which on 84 proofs is a great deal of extra scrolling
                 for someone doing this one-handed.
              2. The 48px pick control, absolutely positioned against the
                 <li>, ended up floating in that empty space BELOW its own
                 photo, visibly detached from the thing it selects.

            A uniform box fixes both and costs a crop: `object-cover` shows the
            middle ~44% of a 3:2 landscape. That cost is the one the mock
            already priced in — client.html:488-489 says the grid "is only the
            index; the decision happens [in the lightbox]", and #146 is the
            slice that makes the lightbox the place a photo is judged whole.

            CLS is unaffected: a static class reserves the box exactly as early
            as an inline style did.

            `proofWidth`/`proofHeight` STAY on `ProofAsset`, but be clear about
            what that means after this slice: they are read by NOTHING on the
            client path. This tile was their last reader there, and
            `proof-lightbox.tsx` never referenced either field at all. The one
            reader left anywhere in the repo is `asset-tile.tsx:136`, and it
            reads `WorkspaceAsset` (`gallery-workspace.tsx:23-24`) — a DIFFERENT
            type, on the dashboard path, which this component does not share.

            So they are still fetched and threaded the whole way down
            (`schema.ts:380` -> `client-gallery-reads.ts:135-136` ->
            `[publicSlug]/page.tsx:126-127` -> <ProofGrid> -> here) with no
            consumer at the end. They are kept only because removing them is a
            GraphQL document + regenerated types + `ProofAsset` change, which is
            outside this slice's scope — not because anything here needs them.
            Deleting them is a separate slice's job. */}
        <div className="bg-bg-2 relative aspect-[2/3] overflow-hidden">
          {/* Plain <img>, not next/image: same reasoning as asset-tile.tsx —
              proof URLs are short-lived, private, presigned R2 URLs whose
              query string is never stable between two loads of the same
              asset. `alt=""` because the filename is already announced by
              the enclosing button's aria-label; a second announcement here
              would be redundant. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            onError={onError}
            loading="lazy"
            className={`h-full w-full object-cover transition-[filter] duration-200 ${
              isSelected ? "brightness-[1.06] saturate-[1.04]" : ""
            }`}
          />

          {/* Channel two of "picked is not colour alone": an inset frame, so
              the state is legible as a change of STRUCTURE across the whole
              grid at a glance, not one tile at a time. A border on an overlay
              rather than `outline-offset: -3px` (client.html:214) purely
              because a Tailwind outline-offset utility is one more thing to
              get subtly wrong across versions; the painted result is the
              same 3px brass frame inset into the photo. */}
          {isSelected && (
            <span
              aria-hidden="true"
              className="border-accent pointer-events-none absolute inset-0 border-[3px]"
            />
          )}

          {/* client.html:192-195. Sits over the photo's own top-left corner,
              which is the quietest part of a proof and the one the 48px pick
              target below never covers.

              The `text-shadow` is NOT in the mock, and it is there because the
              capture showed it had to be: the mock's own colour
              (rgba(236,234,242,0.55)) is legible on the mid-dark CSS gradients
              that stand in for photographs there, and disappears completely on
              a genuinely bright proof — an overexposed sky, a white dress,
              which is a large share of what a wedding photographer actually
              delivers. A number nobody can read is worse than no number. The
              colour is the mock's, unchanged; only the backing was added. */}
          <span className="pointer-events-none absolute top-2 left-2 font-mono text-[10px] text-[rgba(236,234,242,0.55)] tabular-nums [text-shadow:0_1px_2px_rgba(7,7,9,0.9)]">
            {String(position).padStart(2, "0")}
          </span>
        </div>
      </button>

      {/* A sibling of the "open lightbox" button above, not nested inside
          it — a nested button would be invalid HTML (buttons can't nest) and
          would also make this click bubble into `onOpen`. Positioned on top
          of the tile only visually, via absolute placement on the `relative`
          <li>. Never blocks or scolds going over quota (task #24) — this
          control does exactly one thing, flip this one asset's selection,
          regardless of how many are already selected.

          48px square (client.html:200-208's `--tap`), comfortably past this
          task's 44px floor, and in the BOTTOM-right rather than the top: on a
          phone held one-handed the bottom edge of a tile is the reachable
          one, and the top-right of a tile in the last row is the furthest
          point on the screen from the thumb.

          The accessible name did NOT change with the visual — "Seleccionar:
          IMG_0001.JPG" / "Quitar de seleccionadas: IMG_0001.JPG" are what
          proof-grid.test.tsx and [publicSlug]/page.chrome.test.tsx query by,
          and they name the actual photo, which the mock's own "Elegir foto 1"
          does not. The mock is the reference for the PIXELS.

          THE `shadow-[...]` IS A DECLARED DEVIATION FROM THE MOCK, the second
          one in this file and for the same reason as the first (see the
          `text-shadow` on `.tile__n` above). The mock's unpicked control is a
          1px `rgba(236,234,242,0.5)` ring over a `rgba(7,7,9,0.42)` disc
          (client.html:204-205) and nothing else. Composited over a flat photo
          and measured as WCAG relative luminance, the mock's two channels are
          below 1.4.11's 3:1 at every photo tone — disc 2.83:1 over RGB-230,
          2.13:1 over RGB-128, 1.10:1 over RGB-30 — and only the ring's 4.49:1
          over a dark photo ever passes. The mid-tone case is the worst, where
          disc 2.13:1 and ring 1.94:1 fail together. Skin, grass, a grey suit, a
          stone church wall: for a wedding set that is the most common tone
          there is, and it is precisely the case the slice's smooth-gradient
          fixtures could not show.

          An outer shadow rather than a darker disc for two reasons: it lands
          the affordance at EVERY photo tone instead of nudging one case towards
          the line, and it keeps the mock's own palette values untouched — the
          same trade `.tile__n` above already made, where only the backing was
          added and the colour stayed the mock's. `rgba(7,7,9,0.6)`, the obvious
          alternative, reaches only 2.99:1 at mid-tone and so does not clear the
          floor either. On both states rather than only the unpicked one,
          because `transition-colors` does not animate box-shadow and a shadow
          that appeared and vanished on each tap would pop.

          BE HONEST ABOUT WHAT THIS SHADOW IS AND IS NOT. It does not create a
          conforming boundary: a `0 1px 6px` blur composites to roughly 1.25:1
          against the disc and 1.70:1 against the photo. What it adds is a
          luminance GRADIENT, which human edge detection responds to and which
          is the standard treatment for a control sitting over imagery — but it
          is not a measurable 3:1 step, and nothing here claims 1.4.11
          conformance. The only computably conforming fix is a materially darker
          disc (α≈0.72 → 3.68:1 at mid-tone), and that is a real change to the
          mock's palette rather than an addition to it, so it is the owner's
          call and not this slice's. Recorded here as a known gap. */}
      <button
        type="button"
        onClick={onToggleSelection}
        disabled={isPending || isLocked}
        aria-pressed={isSelected}
        aria-label={
          isSelected
            ? `Quitar de seleccionadas: ${asset.originalFilename}`
            : `Seleccionar: ${asset.originalFilename}`
        }
        className={`absolute right-[7px] bottom-[7px] z-10 grid h-12 w-12 place-items-center rounded-full border text-[17px] leading-none shadow-[0_1px_6px_rgba(7,7,9,0.6)] backdrop-blur-[6px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          isSelected
            ? "border-accent bg-accent text-[#14100a]"
            : "text-fg hover:border-accent border-[rgba(236,234,242,0.5)] bg-[rgba(7,7,9,0.42)]"
        }`}
      >
        {/* Channel one: a shape, not a hue. `aria-hidden` because the button's
            own `aria-label` and `aria-pressed` already say this, and a screen
            reader announcing a bare "✓" after them adds nothing. */}
        <span aria-hidden="true">{isSelected ? "✓" : ""}</span>
      </button>

      {/* TASK #206 — THE TYPE CONTROL, in the tile's bottom-LEFT corner (the
          same corner `showDownload` below occupies — never at the same time,
          see that block's own comment).

          THE DESIGN DECISION THE TASK BODY ASKS FOR, MADE AND WRITTEN DOWN
          HERE: this is NOT a second always-visible control sitting next to
          the pick button on all 84 tiles. It renders ONLY once the photo is
          picked (`isSelected`), for two reasons, and the second is the one
          that actually decided it:

            1. It keeps the grid CLEAN — 84 near-identical proofs on a phone,
               one hand, at night (task #145's own case) is already crowded
               with a 48px pick target and a position number; a second
               permanently-visible control competing for the same cramped
               ~178px-wide tile (at 390px: `<main>`'s own `px-4` leaves 358px,
               two columns at `gap-[2px]` makes each one (358-2)/2 ≈ 178px)
               would make the pick button harder to hit reliably, not easier.
            2. It REFLECTS THE MODEL: `assets.selectionKind` is meaningless
               while `isSelected` is `false` (schema.ts's own comment on that
               column) — showing a type toggle for a photo nobody chose would
               offer a choice that does not exist yet.

          The cost this trades away, honestly: picking a photo now changes
          the tile's OWN layout (a control appears where there was none),
          which the always-visible alternative would have avoided. Judged
          worth it because that layout change happens to exactly the ~15
          tiles a client actually picks out of ~84, not to the whole grid —
          the "keep the grid clean" win applies to every tile all the time,
          the "layout shifts on pick" cost applies only to the ones a client
          is already looking at because they just tapped it.

          Only while `!isLocked`: once the selection is submitted there is
          nothing left to change (the PATCH route's own gate refuses it
          regardless), and the tray/counter already surface the chosen type
          for a locked gallery — this tile does not need to duplicate that in
          a disabled state nobody can act on.

          Two EXPLICIT buttons ("Editada" / "Original"), not one button that
          flips between them: this mirrors the PATCH route's own body shape
          (`selectionKind: "edited" | "original"`, never a toggle), which
          means tapping either always requests the value the client actually
          sees pressed, with no ambiguity about what a single "flip" button
          would currently mean.

          Reuses the pick button's own palette (`rgba(7,7,9,0.42)` ground,
          `rgba(236,234,242,0.5)` border, `--accent` when pressed) so this
          reads as the SAME family of control as the one right next to it,
          not a competing visual language.

          THE WIDTH BUDGET, COMPUTED, NOT A REAL-BROWSER MEASUREMENT — flagged
          honestly rather than asserted as verified. At 390px, `<main>`'s own
          `px-4` (page.tsx) leaves 358px of content; two columns at `gap-[2px]`
          (proof-grid.tsx's own `<ul>`) makes each tile (358-2)/2 = 178px wide.
          The pick button reserves `right-[7px]` + 48px ≈ 55px from the right
          edge, leaving this control ~178-8(left-2)-55 ≈ 115px before the two
          would visually meet. `text-[9px]`/`px-1.5` (not the mock-matching
          `text-[10px]`/`px-2` a first pass used) was chosen specifically to
          stay under that budget with margin — "Editada"/"Original" at 9px in
          a typical sans-serif land around 30-38px of glyphs each, +12px
          padding, ~90-100px combined. Left at `text-[10px]`/`px-2` this same
          arithmetic lands at ~107-122px, uncomfortably close to the 115px
          ceiling. NOT confirmed in a real Chromium render at 390×844 (this
          slice's own declared gap — see the kanban report); revisit with an
          actual capture before trusting the margin further. */}
      {isSelected && !isLocked && (
        <div
          role="group"
          aria-label={`Tipo de foto: ${asset.originalFilename}`}
          className="absolute bottom-2 left-2 z-10 flex overflow-hidden rounded-full border border-[rgba(236,234,242,0.5)] bg-[rgba(7,7,9,0.42)] backdrop-blur-[6px]"
        >
          <button
            type="button"
            onClick={() => onSetSelectionKind("edited")}
            aria-pressed={selectionKind === "edited"}
            aria-label={`Marcar como editada: ${asset.originalFilename}`}
            disabled={isPending}
            className={`px-1.5 py-1 text-[9px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              selectionKind === "edited"
                ? "bg-accent text-[#14100a]"
                : "text-fg hover:text-accent-2"
            }`}
          >
            Editada
          </button>
          <button
            type="button"
            onClick={() => onSetSelectionKind("original")}
            aria-pressed={selectionKind === "original"}
            aria-label={`Marcar como original: ${asset.originalFilename}`}
            disabled={isPending}
            className={`px-1.5 py-1 text-[9px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              selectionKind === "original"
                ? "bg-accent text-[#14100a]"
                : "text-fg hover:text-accent-2"
            }`}
          >
            Original
          </button>
        </div>
      )}

      {/* Bottom-LEFT since task #145, not bottom-right — task #28's own
          affordance, shown only once the gallery is delivered AND this
          specific asset actually has a final (see <ProofGrid>'s own
          `showDownload` computation). It used to sit bottom-right and the
          selection pill sat top-right; now that the pick target owns the
          bottom-right corner the two would overlap, and a `delivered` gallery
          renders BOTH (the toggle stays mounted-but-disabled per #25, it is
          not hidden). Only the position moved here — the delivered screen's
          own visual treatment is task #148's.

          NEVER renders at the same time as the type control above: that one
          requires `!isLocked`, this one only ever shows once `isDelivered`
          (a status past `isLocked` becoming true) — the same "never both at
          once" property `showDownload` and the pick-button corner already
          had before this slice. */}
      {showDownload && (
        <div className="absolute bottom-2 left-2 z-10">
          <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
        </div>
      )}
    </li>
  );
}
