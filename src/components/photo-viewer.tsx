"use client";

// Presentational full-screen viewer shared by <ProofLightbox> (the selection
// flow, tasks #23/#146) and the flash gallery page (task #237). It owns
// everything about LOOKING at one photo and moving between photos: the Radix
// modal mechanics, scroll lock, arrow keys, the pinch-safe swipe, prev/next,
// the position counter, the filename title and the zoomable stage. It knows
// NOTHING about selection, quota or downloads — those arrive as slots
// (`subtitle`, `centerAction`, `footerExtras`), so the proof flow and the
// flash page cannot drift apart on the viewer's behaviour.
//
// The design rationale of the markup below (one-handed reach: every control in
// one bottom row; the photo gets the rest of the screen; `object-contain`
// because the grid tile crops to a uniform 2:3; no CSS watermark because the
// real mark is baked into the proof bytes) was written against
// design/system/client.html's `lightbox` screen in task #146 and is unchanged;
// see proof-lightbox.tsx's history for the long form.
//
// THE MODAL MECHANICS ARE RADIX'S, NOT HAND-ROLLED, and the primitive is used
// DIRECTLY rather than through `@/components/ui/dialog`, which is dressed for
// the panel's palette — the client surface does not get that layer.
import { useEffect, useRef, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ZoomableStage } from "@/components/zoomable-stage";

export type ViewerPhoto = {
  id: string;
  /** What the stage paints (already URL-refreshed by the caller). */
  src: string;
  /** Shown as the dialog title and used as the image alt. */
  name: string;
};

export function PhotoViewer({
  photos,
  index,
  onClose,
  onNavigate,
  onImageError,
  subtitle,
  centerAction,
  footerExtras,
}: {
  photos: ViewerPhoto[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onImageError: (assetId: string) => void;
  /** Optional second line under the position counter (the proof flow's
   * "cuántas van"). */
  subtitle?: ReactNode;
  /** The middle cell of the thumb row, between prev and next (the proof
   * flow's pick button). An empty cell when absent, so prev/next keep their
   * corners. */
  centerAction?: ReactNode;
  /** Rendered under the thumb row, above the filename (the type control and
   * the per-photo download). */
  footerExtras?: ReactNode;
}) {
  const photo = photos[index];
  const touchStartX = useRef<number | null>(null);
  // Armed the moment a second finger lands and disarmed only once the whole
  // hand is off the glass — see `handleTouchStart`'s own comment.
  const isPinchRef = useRef(false);
  // Whatever was focused at the moment this opened — the grid tile, or a tray
  // thumbnail. See `onOpenAutoFocus`/`onCloseAutoFocus` below for why this
  // component has to hold it itself rather than let the primitive do it.
  const openerRef = useRef<HTMLElement | null>(null);

  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;

  // Background scroll lock, kept as this component's OWN guarantee rather
  // than delegated to the dialog primitive: its scroll lock arrives through a
  // sidecar that is not loaded in every environment (verified under JSDOM).
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // ←/→ only. `Escape` belongs to the dialog primitive's own dismiss layer;
  // a second handler here would call `onClose` twice for one keypress. Still
  // `window` so arrows keep working after a button becomes `disabled` and the
  // browser drops focus to <body>.
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

  // Defensive only: callers never pass an out-of-range index, but this keeps
  // the component from throwing if one ever did.
  if (!photo) return null;

  // A SWIPE IS ONE FINGER. A PINCH IS NOT A SWIPE.
  // ==============================================
  // Reported by the owner (2026-08-21): pinching to zoom on a phone jumped to
  // the next photo. Two facts about the touch model do all the work:
  //   1. `touchstart` fires again when the SECOND finger lands, with
  //      `touches.length === 2` — the gesture is poisoned right there.
  //   2. `touchend` fires once PER FINGER LIFTED. While `touches` is
  //      non-empty the hand is still on the glass and there is nothing to
  //      decide yet.
  // `touches` is read defensively (`?.length ?? 0`) because a synthesised
  // `touchend` — JSDOM's — carries only `changedTouches`.
  function handleTouchStart(event: React.TouchEvent) {
    if ((event.touches?.length ?? 0) > 1) {
      isPinchRef.current = true;
      touchStartX.current = null;
      return;
    }
    // EVERY gesture starts here, which is what makes this the only reset this
    // needs (a `touchcancel` handler was tried and could not be made to fail).
    isPinchRef.current = false;
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleTouchEnd(event: React.TouchEvent) {
    // Fact 2: another finger is still down, so this gesture is not over.
    if ((event.touches?.length ?? 0) > 0) return;
    const wasPinch = isPinchRef.current;
    const startX = touchStartX.current;
    isPinchRef.current = false;
    touchStartX.current = null;
    if (wasPinch || startX === null) return;
    const endX = event.changedTouches[0]?.clientX ?? startX;
    const deltaX = endX - startX;
    const SWIPE_THRESHOLD_PX = 40;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    if (deltaX < 0 && hasNext) onNavigate(index + 1);
    if (deltaX > 0 && hasPrev) onNavigate(index - 1);
  }

  // client.html:129-136 `.btn` — 48px minimum height, 1px `--line-2` hairline,
  // 3px radius, 14px type. Fine on this flat ground because each control
  // carries its own high-contrast glyph or label.
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
            ground, not a scrim over the page. */}
        <DialogPrimitive.Content
          // `aria-labelledby` is wired by the primitive to <Title>, which is
          // the filename in the footer; there is nothing to describe beyond
          // it, so the description warning is opted out.
          aria-describedby={undefined}
          // FOCUS RESTORE, DONE BY HAND ON PURPOSE: Radix restores focus to
          // its own <Dialog.Trigger>, and there is no trigger here — the
          // opener is a tile in the caller's list. So the opener is captured
          // when the primitive itself captures it and restored on the way out.
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
              right, both inside the gutter (16 / 28 / 48px). */}
          <div className="flex items-center justify-between gap-3 px-4 py-[10px] sm:px-7 lg:px-12">
            <div className="min-w-0">
              {/* `.lb__count`. Three text nodes in ONE element on purpose:
                  tests match `/2 \/ 3/` against this node's own text. */}
              <p className="text-fg-dim font-mono text-xs tracking-[0.1em] tabular-nums">
                {index + 1} / {photos.length}
              </p>
              {subtitle}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="text-fg-dim hover:text-fg grid h-12 w-12 shrink-0 place-items-center text-[20px] leading-none transition-colors motion-reduce:transition-none"
            >
              ✕
            </button>
          </div>

          {/* `.lb__stage` (:502). The stage, the photograph and the desktop
              click-to-1:1 zoom all live in <ZoomableStage>, shared with the
              admin viewer. */}
          <ZoomableStage
            assetId={photo.id}
            src={photo.src}
            alt={photo.name}
            onImageError={() => onImageError(photo.id)}
          >
            {/* `.lb__hint` (:510-513); `lg:hidden` is the mock's own :569.
                Only shown when there is somewhere to go. */}
            {photos.length > 1 && (
              <p className="text-[rgb(240 235 227 /0.4)] pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] tracking-[0.08em] lg:hidden">
                Desliza para pasar
              </p>
            )}
          </ZoomableStage>

          {/* `.lb__foot` (:514). */}
          <div className="grid gap-[10px] px-4 pt-3 pb-[calc(14px+env(safe-area-inset-bottom,0px))] sm:px-7 lg:px-12">
            {/* THE THUMB ROW. Prev and next are rendered ALWAYS and disabled
                at the ends rather than hidden, so the middle control never
                changes width or position between one photo and the next. The
                cap from `sm` up (460px, the mock's own sheet width) is
                measured: full-bleed at 1440 made the middle button a stripe. */}
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

              {centerAction ?? <div />}

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

            {footerExtras}

            {/* `.lb__name` (:515/:893), and it doubles as the dialog's own
                <Title>. One element, not two: a second node carrying the
                filename would break `getByText(filename)` uniqueness. */}
            <DialogPrimitive.Title asChild>
              <h2 className="text-fg-mute text-center font-mono text-[11px] font-normal">
                {photo.name}
              </h2>
            </DialogPrimitive.Title>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
