"use client";

// The presentational grid tile shared by <ProofTile> (selection flow) and the
// flash gallery page (task #237): the uniform 2:3 box, the photo, the corner
// position number and the "open in the viewer" button. Extracted from
// proof-tile.tsx so a flash tile is the SAME pixels as a delivered proof tile
// rather than a lookalike. It knows nothing about selection beyond the two
// cosmetic cues a picked tile carries (`isSelected`: the inset frame and the
// reveal class); everything that acts on the photo is a `children` overlay
// the caller positions against this <li> (`relative`).
//
// The watermark note from proof-tile.tsx applies here unchanged: the mark is in
// the proof bytes, never drawn in CSS.
import type { ReactNode } from "react";

export function PhotoTile({
  name,
  position,
  src,
  isSelected = false,
  onError,
  onOpen,
  children,
}: {
  /** Used for the open button's accessible name ("Ver IMG_0001.JPG"). */
  name: string;
  /** 1-based position in the grid, rendered in the tile's corner
   * (client.html:192-195 `.tile__n`). Display only; nothing keys off it. */
  position: number;
  src: string;
  isSelected?: boolean;
  onError: () => void;
  onOpen: () => void;
  /** Overlays (pick button, type control, download) — siblings of the open
   * button, since buttons cannot nest. */
  children?: ReactNode;
}) {
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Ver ${name}`}
        className="focus-visible:ring-accent block w-full text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {/* THE BOX IS RESERVED BEFORE THE IMAGE ARRIVES — task #23's zero-CLS
            contract. Since task #145 the reserved shape is UNIFORM
            (`aspect-[2/3]`, client.html:181) instead of each asset's own
            ratio: measured at 390px and 1440px, mixed landscape and portrait
            proofs gave every row the height of its tallest tile, leaving ~40%
            of the phone's screen empty between photos and the pick control
            floating below its own photo. A uniform box fixes both and costs a
            crop (`object-cover` shows the middle ~44% of a 3:2 landscape),
            which the mock already priced in: the grid "is only the index; the
            decision happens [in the lightbox]" (client.html:488-489). */}
        <div className="bg-bg-2 relative aspect-[2/3] overflow-hidden">
          {/* Plain <img>, not next/image: proof URLs are short-lived presigned
              R2 URLs (or a redirecting own route, for flash) whose query
              string is never stable between two loads. `alt=""` because the
              filename is already announced by the enclosing button's
              aria-label. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            onError={onError}
            loading="lazy"
            className={`h-full w-full object-cover ${isSelected ? "selection-reveal" : ""}`}
          />

          {/* Channel two of "picked is not colour alone": an inset 3px brass
              frame, so the state is legible as a change of STRUCTURE across
              the whole grid at a glance. */}
          {isSelected && (
            <span
              aria-hidden="true"
              className="border-accent pointer-events-none absolute inset-0 border-[3px]"
            />
          )}

          {/* client.html:192-195. Sits over the photo's top-left corner, the
              quietest part of a proof and the one the 48px pick target never
              covers. The `text-shadow` is NOT in the mock: the mock's colour
              disappears on a genuinely bright photo (an overexposed sky, a
              white dress), and a number nobody can read is worse than none. */}
          <span className="text-[rgb(240 235 227 /0.55)] [text-shadow:0_1px_2px_rgb(26 21 18 /0.9)] pointer-events-none absolute top-2 left-2 font-mono text-[10px] tabular-nums">
            {String(position).padStart(2, "0")}
          </span>
        </div>
      </button>
      {children}
    </li>
  );
}
