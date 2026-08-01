"use client";

// Full-screen viewer for one proof at a time (task #23), REDESIGNED BY TASK
// #146 against design/system/client.html's `lightbox` screen (:875-896, CSS
// :491-515).
//
// WHAT THIS SCREEN IS FOR, in the mock's own words (client.html:487-489):
// "on a phone this IS the selection flow. The grid is only the index; the
// decision happens here." Task #145 spent a real cost on that sentence — it
// made every grid tile a uniform `aspect-[2/3]` box, so `object-cover` shows
// only the middle ~44% of a 3:2 landscape — on the explicit promise that the
// photo gets judged WHOLE here. That is why the stage below uses
// `object-contain` and not the mock's own `.lb__img { inset: 0 }` cover fill
// (:503): the mock's stage holds a CSS gradient with no aspect ratio to
// respect, this one holds the photograph that #145 cropped.
//
// THE ONE-HANDED RULE: REACH BEATS SYMMETRY
// =========================================
// The case is the same one #145 designed against — 84 proofs, pick 15, on a
// phone, one hand, at night — with the difference that here the client is not
// scanning, they are DECIDING. Three consequences, each a line in the mock:
//
//   - EVERY CONTROL THAT ACTS ON THE PHOTO SITS IN ONE BOTTOM ROW. The pick
//     button is `.btn.btn--primary.btn--wide` in `.lb__foot` (:889), which is
//     `min-height: var(--tap)` = 48px (:131, :49) and full width (:142). Prev
//     and next are 48px squares flanking it. Before this slice the toggle was
//     a ~24px text pill pinned to the TOP-RIGHT of the screen and prev/next
//     floated at the vertical MIDDLE of the left and right edges — three
//     controls, none of them in a thumb's arc on a 390x844 phone, and the
//     most-pressed one at the single furthest point from it.
//   - THE PHOTO GETS THE REST. `.lb` is `grid-template-rows: auto 1fr auto`
//     (:491): chrome above, chrome below, and the stage takes everything
//     left. Nothing is layered over the photograph except the mock's own
//     swipe hint (:510-513), which the mock itself drops at the desk (:569).
//   - STATE IS READABLE WITHOUT COVERING THE PHOTO. Position and the running
//     count go in `.lb__top` (:877-880), the filename in `.lb__name`
//     (:893/:515), and "is this one picked" is the pick button itself.
//
// THE MODAL MECHANICS ARE RADIX'S, NOT HAND-ROLLED
// ================================================
// A full-screen viewer is a modal dialog, and the a11y failures that live in
// one — focus escaping to the page behind, `Escape` doing nothing, focus
// stranded on a button that no longer exists after close — are all mechanics,
// not design. Task #127 installed `radix-ui` for the panel's dialog; this file
// uses the SAME primitive's behaviour (focus trap, focus RESTORE to whatever
// was focused when it opened, `Escape`, background scroll lock, `aria-hidden`
// on everything behind) and none of its styling.
//
// Deliberately the primitive DIRECTLY and not `@/components/ui/dialog`: that
// wrapper is dressed for the panel (`bg-popover`, `text-popover-foreground`,
// a centred `max-w-sm` card), and epic #140's whole premise is that the
// client surface does NOT get the `data-surface="app"` layer. Importing it
// would drag the panel's palette onto the one screen the paying client
// actually touches. The mechanics are what is worth reusing; the pixels are
// this epic's own.
//
// NO CSS WATERMARK — the mock draws `.lb__wm` (:504-509) for the same reason
// `.tile__wm` exists: its stage is a gradient with nothing to protect.
// `processProof` (src/lib/images.ts) composites the real mark into the proof
// bytes and `images.guard.test.ts:50` refuses to emit a proof whose watermark
// rasterized without ink. A second, CSS copy would be a FAKE mark a client
// deletes from the DOM in two seconds while the real one stays put. See
// proof-tile.tsx's own paragraph on this; the reasoning is identical and the
// answer is the same.
import { useEffect, useRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { DownloadFinalButton } from "@/components/download-final-button";
import type { ProofAsset } from "@/components/proof-grid";
import type { QuotaResult } from "@/lib/quota";
import type { SelectionKind } from "@/lib/selection-snapshot";

export function ProofLightbox({
  assets,
  urls,
  index,
  quota,
  onClose,
  onNavigate,
  onImageError,
  onToggleSelection,
  pendingAssetIds,
  isLocked,
  isDelivered,
  selectionKindById,
  onSetSelectionKind,
  allowsOriginalSelection,
}: {
  assets: ProofAsset[];
  // Keyed by asset id. <ProofGrid> owns this state and shares it with the
  // grid tile for the SAME asset — see that file's header comment for why
  // the refreshed-URL state lives one level up instead of being duplicated
  // per surface.
  urls: Record<string, string>;
  index: number;
  // Task #146: "cuántas van" is one of the three facts this screen owes the
  // client, and on a phone the grid's own <SelectionCounter> is not merely
  // scrolled away — it is inside the `aria-hidden` region the modal puts
  // behind itself, so its `aria-live` cannot announce either. The SAME
  // server-recomputed `QuotaResult` <SelectionCounter> renders, passed
  // through untouched: this component does no arithmetic on it, and it is
  // NOT the quota bar (client.html:371-394), which is task #147's.
  quota: QuotaResult;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onImageError: (assetId: string) => void;
  // Task #24: the client can also toggle selection from the full-screen
  // view, not only the grid tile behind it — same handler <ProofGrid>
  // passes to <ProofTile>, so both surfaces go through the exact same
  // round trip and the exact same server-recomputed quota response.
  onToggleSelection: (assetId: string, nextSelected: boolean) => void;
  pendingAssetIds: Set<string>;
  // Task #25: same UX-only mirror of the server-side lock as
  // <ProofTile>'s own `isLocked` — see proof-grid.tsx's header comment.
  isLocked: boolean;
  // Task #28: <ProofGrid>'s own `initialStatus === "delivered"` — combined
  // per-render with the CURRENT asset's own `hasFinal` below (not hoisted
  // into a single boolean prop) because which asset is "current" changes on
  // every ←/→/swipe navigation within this same mounted component.
  isDelivered: boolean;
  // Task #206 — every currently-selected asset's own type, keyed by id, the
  // SAME map <ProofGrid> builds off `picks` and hands to <ProofTile> too — a
  // second source for this would risk the tile and the lightbox disagreeing
  // about the same photo's type mid-session. An asset not selected has no
  // entry (see <ProofTile>'s own comment on why that is never actually read).
  selectionKindById: Record<string, SelectionKind>;
  // Task #24's own pattern, restated for the type: the SAME handler
  // <ProofGrid> passes to <ProofTile>, generic over `assetId` here (unlike
  // the tile's own already-bound version) because this component iterates
  // over `assets` by `index`, not one asset per mounted instance.
  onSetSelectionKind: (assetId: string, kind: SelectionKind) => void;
  /** Task #214 — the SAME gate <ProofTile>'s own prop of this name applies,
   * mirrored here: `false` (the default for every gallery, schema.ts's own
   * comment on `galleries.allowsOriginalSelection`) hides this screen's type
   * control entirely, regardless of `isSelected`/`isLocked`. */
  allowsOriginalSelection: boolean;
}) {
  const asset = assets[index];
  const touchStartX = useRef<number | null>(null);
  // Whatever was focused at the moment this opened — the grid tile, or a tray
  // thumbnail. See `onOpenAutoFocus`/`onCloseAutoFocus` below for why this
  // component has to hold it itself rather than let the primitive do it.
  const openerRef = useRef<HTMLElement | null>(null);

  const hasPrev = index > 0;
  const hasNext = index < assets.length - 1;

  // Background scroll lock, kept as this component's OWN guarantee rather
  // than delegated to the dialog primitive. The primitive does ship one
  // (`react-remove-scroll`), but it arrives through a sidecar that is not
  // loaded in every environment — verified, not assumed: with a Radix modal
  // open under JSDOM the body carries `pointer-events: none` from the dismiss
  // layer and NOTHING from the scroll lock, no `data-scroll-locked`, no
  // injected stylesheet. Six lines that behave identically everywhere are
  // worth more here than a dependency on which half of a library woke up:
  // without them an arrow key or a swipe also scrolls the 84-tile grid
  // underneath on some mobile browsers, and closing returns the client to a
  // completely different scroll position than the one they left.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // ←/→ only. `Escape` used to live here too and now belongs to the dialog
  // primitive's own dismiss layer, which listens on `document` — keeping a
  // second handler would call `onClose` twice for one keypress.
  //
  // Still `window` rather than the content element: focus IS trapped inside
  // the dialog, so a bubbling keydown would reach either, but a window
  // listener also survives the moment right after `onNavigate` when the
  // pressed prev/next button becomes `disabled` and the browser drops focus
  // to <body>. Arrow keys have to keep working at the ends of the set.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight" && hasNext) {
        onNavigate(index + 1);
        return;
      }
      if (event.key === "ArrowLeft" && hasPrev) {
        onNavigate(index - 1);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [index, hasPrev, hasNext, onNavigate]);

  // Defensive only: <ProofGrid> never passes an out-of-range index, but this
  // keeps the component from throwing if it ever did.
  if (!asset) return null;

  const src = urls[asset.id] ?? asset.proofUrl;
  const isSelected = asset.isSelected;
  const isPickDisabled = pendingAssetIds.has(asset.id) || isLocked;
  // Task #206 — only meaningful while `isSelected`; the control below is
  // gated on that same condition, matching <ProofTile>'s own "a photo that
  // isn't picked has no type" stance.
  const selectionKind = selectionKindById[asset.id] ?? "edited";

  // The gesture the mock names out loud (`.lb__hint`, :885 "Deslizá para
  // pasar"). Bound to the dialog surface as a whole rather than to the stage:
  // the thumb that does this is resting at the BOTTOM of the phone, over the
  // footer chrome, not over the middle of the photo. A drag that starts on
  // the pick button is not a problem — browsers suppress the `click` once the
  // finger travels past their own slop, and 40px is well past it.
  function handleTouchStart(event: React.TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleTouchEnd(event: React.TouchEvent) {
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (startX === null) return;
    const endX = event.changedTouches[0]?.clientX ?? startX;
    const deltaX = endX - startX;
    const SWIPE_THRESHOLD_PX = 40;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    if (deltaX < 0 && hasNext) onNavigate(index + 1);
    if (deltaX > 0 && hasPrev) onNavigate(index - 1);
  }

  // client.html:129-136 `.btn` — 48px minimum height, 1px `--line-2` hairline,
  // 3px radius, 14px type. The hairline composites to ~1.39:1 against
  // `--bg-sunken`, which is nowhere near SC 1.4.11's 3:1, and unlike the grid
  // tile's pick disc (see proof-tile.tsx's recorded gap) that is FINE here and
  // for a checkable reason: these controls sit on a known flat ground instead
  // of an arbitrary photograph, and each one carries its own high-contrast
  // glyph or label — `--fg` #eceaf2 on `--bg-sunken` #070709 is ~17:1, far
  // past the 4.5:1 that text needs. The border is decoration around a control
  // that is already identified by its text; on a tile there was no text, so
  // the disc WAS the affordance. Same mock value, different obligation.
  const CHROME_BUTTON =
    "inline-flex items-center justify-center rounded-[3px] border border-line-2 text-fg transition-colors motion-reduce:transition-none hover:border-accent hover:text-accent-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-2 disabled:hover:text-fg";

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* No <Overlay>: `.lb` (client.html:491) is an opaque `--bg-sunken`
            ground, not a scrim over the page. A photograph is being judged
            here, and letting the gallery page glow through behind it would
            change how its shadows read. */}
        <DialogPrimitive.Content
          // `aria-labelledby` is wired by the primitive to <Title>, which is
          // the filename in the footer. Without this, Radix warns about a
          // missing description on every open; there is nothing to describe
          // beyond the title, so it is opted out rather than filled with
          // noise.
          aria-describedby={undefined}
          // FOCUS RESTORE, DONE BY HAND ON PURPOSE — and this is the one
          // place the primitive could not be taken as-is. Radix restores
          // focus to its own <Dialog.Trigger>, and there is no trigger here:
          // the thing that opened this is a tile inside <ProofGrid>'s own
          // list, and <ProofGrid> mounts this component from state rather
          // than wrapping 84 tiles in 84 dialogs. Its modal handler
          // `preventDefault()`s the FocusScope's generic restore and then
          // focuses `triggerRef.current`, which is null — measured, not
          // guessed: focus landed on <body> and the client's place in an
          // 84-photo grid was gone. So the opener is captured at the moment
          // the primitive itself captures it (this event fires before focus
          // moves into the dialog) and restored on the way out.
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="bg-bg-sunken fixed inset-0 z-50 grid grid-rows-[auto_1fr_auto] outline-none"
        >
          {/* `.lb__top` (:492-495): position on the left, the way out on the
              right, both inside the gutter (16 / 28 / 48px — :50, :531, :554). */}
          <div className="flex items-center justify-between gap-3 px-4 py-[10px] sm:px-7 lg:px-12">
            <div className="min-w-0">
              {/* `.lb__count` (:496/:878). Three text nodes in ONE element on
                  purpose: proof-grid.test.tsx matches `/2 \/ 3/` against this
                  node's own text, and splitting the numbers into child spans
                  would silently empty that match. */}
              <p className="text-fg-dim font-mono text-xs tracking-[0.1em] tabular-nums">
                {index + 1} / {assets.length}
              </p>
              {/* "Cuántas van", in the mock's own sentence for it
                  (client.html:701 — "<b>0</b> elegidas · 13 incluidas").
                  `aria-live` because toggling below changes it while the
                  client is looking at the photo, not at this line, and the
                  grid's own counter is `aria-hidden` behind this dialog. */}
              <p className="text-fg-mute mt-[2px] text-xs" aria-live="polite">
                {quota.selected} elegidas · {quota.includedPhotosSnapshot} incluidas
              </p>
            </div>
            {/* `.lb__close` (:497-501): a full 48px box, so the one control
                that is NOT in the bottom row is at least a comfortable target
                where it stands. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="text-fg-dim hover:text-fg grid h-12 w-12 shrink-0 place-items-center text-[20px] leading-none transition-colors motion-reduce:transition-none"
            >
              ✕
            </button>
          </div>

          {/* `.lb__stage` (:502). `min-h-0` because a `1fr` grid row still
              takes `min-height: auto` from its content otherwise, which on a
              short viewport would push the footer off the bottom of the
              screen — the one place the pick button may never go. */}
          <div className="relative min-h-0 overflow-hidden">
            {/* Plain <img>, not next/image: same reasoning as asset-tile.tsx —
                proof URLs are short-lived, private, presigned R2 URLs whose
                query string is never stable between two loads. `key` on the
                asset id so navigating swaps the element rather than mutating
                one <img>'s src, which is what keeps a failed load's `onError`
                attributable to the asset that failed.

                `onError` is the 5-minute-expiry recovery path (task #23), and
                looking at one photograph for longer than the presigned TTL is
                precisely this screen's normal case. <ProofGrid> hands the
                SAME `refreshUrl` to the tray, the tiles and here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={asset.id}
              src={src}
              alt={asset.originalFilename}
              onError={() => onImageError(asset.id)}
              className="absolute inset-0 h-full w-full object-contain"
            />

            {/* `.lb__hint` (:510-513), and `lg:hidden` is the mock's own :569
                — there is no swiping at a desk, and the arrows below say the
                same thing there. Only shown when there is somewhere to go. */}
            {assets.length > 1 && (
              <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] tracking-[0.08em] text-[rgba(236,234,242,0.4)] lg:hidden">
                Deslizá para pasar
              </p>
            )}
          </div>

          {/* `.lb__foot` (:514). The safe-area inset is the mock's own; `0px`
              rather than its bare `0` because a unitless zero is not a valid
              term in a `calc()` addition. */}
          <div className="grid gap-[10px] px-4 pt-3 pb-[calc(14px+env(safe-area-inset-bottom,0px))] sm:px-7 lg:px-12">
            {/* THE THUMB ROW. Prev and next are an ADDITION to the mock, which
                has neither — its lightbox navigates by swipe alone, which is
                true on a phone and leaves a pointer-only desktop user with no
                way forward at all. They go here, flanking the pick button, and
                not back at the vertical middle of the screen edges where they
                were: the mock's own >=620px rule turns `.lb__foot` into a
                `1fr auto auto` row (:536), so a footer that carries more than
                the button is the mock's grammar rather than an invention.

                Rendered ALWAYS and disabled at the ends rather than hidden
                (which is what this component used to do): the pick button is
                pressed 15 times in a run of 84 and it must not change width or
                position between one photo and the next, because a target that
                moves under a thumb already travelling towards it is a mis-tap.

                THE CAP FROM `sm` UP IS MEASURED, NOT TASTE. Full-bleed is
                right on a phone — the thumb should not have to aim — but the
                first build of this row was captured at 1440 and the pick
                button came out 1228px wide, which is not a button, it is a
                stripe. 460px centred is the mock's OWN answer to the same
                question: its submit sheet is a full-width bottom sheet on a
                phone and `max-width: 460px; margin-inline: auto` from 620px up
                (client.html:539-541). Reused rather than re-invented. */}
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-[10px] sm:mx-auto sm:w-full sm:max-w-[460px]">
              <button
                type="button"
                onClick={() => onNavigate(index - 1)}
                disabled={!hasPrev}
                aria-label="Foto anterior"
                className={`${CHROME_BUTTON} h-12 w-12 text-[20px] leading-none`}
              >
                ‹
              </button>

              {/* `.btn.btn--primary.btn--wide` when picked (:889/:137-142),
                  the plain `.btn` outline when not.

                  PICKED IS NEVER COLOUR ALONE, the same three-channel rule
                  #145 applied to the tile (client.html:213-215), restated for
                  a control that has room for words: a ✓ GLYPH appears (shape),
                  the LABEL changes from "Elegir esta foto" to "Elegida"
                  (wording), and the button goes from a hairline outline to a
                  filled brass block (figure/ground). Three separate
                  expressions in the JSX below, on purpose — none of them a
                  hue, and none of them able to carry another one's failure.
                  `aria-pressed` carries the same fact to assistive tech.

                  The accessible name comes from the visible label and is NOT
                  the tile's "Seleccionar: IMG_0001.JPG". Two reasons, and the
                  first is not cosmetic: the tile behind this dialog is still
                  mounted, so an identical name would make
                  `getByRole("button", { name: ... })` ambiguous in every test
                  that opens the lightbox. The second is that a filename earns
                  its place in a name when it disambiguates one of 84 tiles;
                  here there is exactly one photo on screen and its name is
                  printed under this button. */}
              <button
                type="button"
                onClick={() => onToggleSelection(asset.id, !isSelected)}
                disabled={isPickDisabled}
                aria-pressed={isSelected}
                className={`inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[3px] border px-5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                  isSelected
                    ? "border-accent bg-accent font-semibold tracking-[0.02em] text-[#14100a]"
                    : "border-line-2 text-fg hover:border-accent hover:text-accent-2 tracking-[0.04em]"
                }`}
              >
                {/* `aria-hidden` for the same reason proof-tile.tsx's own ✓
                    is: the button already says "Elegida" and carries
                    `aria-pressed`, so a screen reader announcing a bare "✓"
                    on top of both adds nothing. Rendered only when picked
                    rather than as an empty span, because `.btn`'s `gap: 8px`
                    (:130) would otherwise indent the label by 8px in the
                    unpicked state for no visible reason. */}
                {isSelected && <span aria-hidden="true">✓</span>}
                {isSelected ? "Elegida" : "Elegir esta foto"}
              </button>

              <button
                type="button"
                onClick={() => onNavigate(index + 1)}
                disabled={!hasNext}
                aria-label="Foto siguiente"
                className={`${CHROME_BUTTON} h-12 w-12 text-[20px] leading-none`}
              >
                ›
              </button>
            </div>

            {/* Task #206 — the SAME type control <ProofTile>'s own comment
                explains at length (the "appears only once picked, not a
                second always-visible control" decision, and why): here it
                sits directly under the pick button rather than beside it,
                since `.lb__foot`'s own row is already `auto 1fr auto` for
                prev/pick/next and has no fourth slot. Same gate as the tile's
                own — `isSelected && !isLocked` — and the same two explicit
                buttons rather than a single flip, for the identical reason:
                the PATCH route's body shape is `selectionKind: "edited" |
                "original"`, never a toggle. */}
            {isSelected && !isLocked && allowsOriginalSelection && (
              <div
                role="group"
                aria-label={`Tipo de foto: ${asset.originalFilename}`}
                className="border-line-2 mx-auto flex w-full max-w-[460px] overflow-hidden rounded-[3px] border"
              >
                <button
                  type="button"
                  onClick={() => onSetSelectionKind(asset.id, "edited")}
                  aria-pressed={selectionKind === "edited"}
                  aria-label={`Marcar como editada: ${asset.originalFilename}`}
                  disabled={isPickDisabled}
                  className={`flex-1 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                    selectionKind === "edited"
                      ? "bg-accent font-semibold text-[#14100a]"
                      : "text-fg hover:text-accent-2"
                  }`}
                >
                  Editada
                </button>
                <button
                  type="button"
                  onClick={() => onSetSelectionKind(asset.id, "original")}
                  aria-pressed={selectionKind === "original"}
                  aria-label={`Marcar como original: ${asset.originalFilename}`}
                  disabled={isPickDisabled}
                  className={`flex-1 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                    selectionKind === "original"
                      ? "bg-accent font-semibold text-[#14100a]"
                      : "text-fg hover:text-accent-2"
                  }`}
                >
                  Original
                </button>
              </div>
            )}

            {/* Task #28's per-asset download, re-derived on every navigation
                (see `isDelivered`'s own prop comment). Only its PLACEMENT is
                decided here — the delivered screen's visual treatment is task
                #148's, so the button keeps its own default styling. */}
            {isDelivered && asset.hasFinal && (
              <div className="flex justify-center">
                <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
              </div>
            )}

            {/* `.lb__name` (:515/:893), and it doubles as the dialog's own
                <Title>. One element, not two: a visually-hidden title would
                be a SECOND node carrying the filename, and proof-grid.test.tsx
                asserts `getByText(filename)` finds exactly one. Rendering the
                title the client can already read is the better answer anyway —
                the dialog's accessible name stays the filename, exactly what
                the `aria-label` on this element's predecessor used to say. */}
            <DialogPrimitive.Title asChild>
              <h2 className="text-fg-mute text-center font-mono text-[11px] font-normal">
                {asset.originalFilename}
              </h2>
            </DialogPrimitive.Title>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
