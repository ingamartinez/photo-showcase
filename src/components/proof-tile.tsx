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
//     the real one stayed put — so this file deliberately does not, and the
//     `brightness-[1.06]` above is the only filter applied to the photo,
//     nowhere near enough to wash the mark out.
import { DownloadFinalButton } from "@/components/download-final-button";
import type { ProofAsset } from "@/components/proof-grid";

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
            as an inline style did. `proofWidth`/`proofHeight` stay on
            `ProofAsset` — the lightbox and the dashboard's own `asset-tile.tsx`
            still use them, and this component is not the place to drop them. */}
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
          does not. The mock is the reference for the PIXELS. */}
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
        className={`absolute right-[7px] bottom-[7px] z-10 grid h-12 w-12 place-items-center rounded-full border text-[17px] leading-none backdrop-blur-[6px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
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

      {/* Bottom-LEFT since task #145, not bottom-right — task #28's own
          affordance, shown only once the gallery is delivered AND this
          specific asset actually has a final (see <ProofGrid>'s own
          `showDownload` computation). It used to sit bottom-right and the
          selection pill sat top-right; now that the pick target owns the
          bottom-right corner the two would overlap, and a `delivered` gallery
          renders BOTH (the toggle stays mounted-but-disabled per #25, it is
          not hidden). Only the position moved here — the delivered screen's
          own visual treatment is task #148's. */}
      {showDownload && (
        <div className="absolute bottom-2 left-2 z-10">
          <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
        </div>
      )}
    </li>
  );
}
