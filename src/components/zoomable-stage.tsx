"use client";

// The photo stage of the two full-screen viewers, with click-to-1:1 zoom and
// drag-to-pan. Shared by both
// (<ProofLightbox> for the client, <AdminAssetViewer> for the photographer).
// The owner's own report: "en desktop no se le puede hacer zoom a la foto,
// incluye admin y cliente".
//
// WHAT "1:1" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT MEAN
// =============================================================
// It means one image pixel per CSS pixel OF THE IMAGE THE BROWSER ACTUALLY
// HAS. It does NOT mean the original camera file, and that distinction was
// checked against the code rather than assumed:
//
//   - `.../proof`   — watermarked, capped at `PROOF_MAX_LONG_EDGE` (1600,
//                     src/lib/images.ts).
//   - `.../display` — unwatermarked, delivered galleries, the SAME 1600 cap.
//   - `.../final`   — full resolution, but presigned with
//                     `Content-Disposition: attachment` (src/lib/r2.ts), so
//                     it is a download and never reaches an `<img src>`.
//
// So 1600px on the long edge is a hard ceiling on what any lightbox can
// possibly display, and it is a deliberate one — see the display route's own
// header comment on why serving finals inline would be ~100 MB of page load
// for a twenty-photo gallery. Pixel-peeping a 24 MP original needs on-demand
// full-resolution loading and is a different piece of work; this hook does
// not pretend to offer it.
//
// That ceiling is exactly why this zoom is worth having. A 1067x1600 portrait
// on a 1440x900 laptop gets fitted into a stage roughly 750px tall — the
// screen is showing it at under half its own resolution. Going to 1:1 is a
// real ~2.1x, and it is the difference between "I can see the photo" and "I
// can see whether the eyes are sharp".
//
// WHY `naturalWidth` AND NOT THE `proofWidth`/`proofHeight` COLUMNS
// =================================================================
// Both asset types carry `proofWidth`/`proofHeight`, and using them would
// avoid waiting for the image to load. They are the wrong source anyway: a
// DELIVERED gallery shows the `display` derivative, which is generated from
// the FINAL, and a photographer who cropped in Lightroom hands back a final
// with a different aspect ratio than the proof those columns describe. The
// thing being zoomed is the `<img>` on screen, so the `<img>`'s own
// `naturalWidth` is the only source that cannot disagree with it.
//
// WHY THIS IS GATED TO `(pointer: fine)`
// ======================================
// The request was desktop. On a phone the browser's own pinch-to-zoom
// already works (once the lightbox stops swallowing the gesture — see
// <ProofLightbox>'s `handleTouchStart`), and pointer events fire for touch
// too: an ungated version would put a one-finger pan in direct competition
// with the swipe-to-navigate handler on the same surface, which is precisely
// the class of bug this change exists to fix. Gating keeps mobile behaviour
// untouched and means there is no swipe-suppression branch here that no
// device would ever reach.
// WHY A COMPONENT AND NOT A `useImageZoom` HOOK
// =============================================
// It was a hook first. A hook has to hand its refs and its ref-touching
// gesture handlers back across the return value, and `react-hooks/refs` then
// rejects reading ANY property off that object during render — `cursorClass`
// included, which touches no ref at all. Renaming the ref fields does not help;
// the taint is on the object. Owning the DOM here instead puts the refs where
// refs belong, and it removed the duplicated stage markup the two viewers were
// each carrying their own copy of. The lint rule pushed towards the better
// shape rather than towards a suppression comment.
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/** Pointer travel, in CSS px, past which a press stops being a click and
 * becomes a pan. Small on purpose: this only has to survive the hand tremor
 * of someone holding a mouse still, not a thumb on glass. */
const DRAG_SLOP_PX = 4;

/** Below this much magnification the zoom is not worth offering: the photo is
 * already being displayed at (or above) its own resolution, so a `zoom-in`
 * cursor would promise something the click cannot deliver. Happens for real
 * on a large or tall monitor, where a 1600px image is already being upscaled
 * to fill the stage — there the click does nothing rather than shrinking the
 * photo back down, which is what an unclamped `1 / fitScale` would do. */
const MIN_WORTHWHILE_SCALE = 1.05;

const FINE_POINTER_QUERY = "(pointer: fine)";

// Read through `useSyncExternalStore` rather than an effect that calls
// setState: `matchMedia` IS an external store, and the effect version is
// exactly what `react-hooks/set-state-in-effect` exists to stop. The
// `matchMedia`-absent branch is not paranoia — JSDOM ships no `matchMedia` at
// all, and answering "no confirmed mouse here" with a disabled zoom is the
// correct fail-closed direction anyway.
function subscribeFinePointer(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(FINE_POINTER_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

// Returns a boolean, so React's own `Object.is` comparison is stable even
// though `matchMedia` hands back a fresh `MediaQueryList` each call.
function getFinePointerSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(FINE_POINTER_QUERY).matches;
}

// There is no pointer on a server, and guessing "fine" would paint a
// `cursor-zoom-in` into the HTML that the first client render then removes.
function getFinePointerServerSnapshot(): boolean {
  return false;
}

type Fit = {
  /** The transform scale that puts the image at one image pixel per CSS
   * pixel. Always >= `MIN_WORTHWHILE_SCALE` when a `Fit` exists at all. */
  scale: number;
  /** How far the image may be panned from centre before its own edge would
   * come inside the stage, at `scale`. Zero on an axis the image does not
   * overflow (a portrait at 1:1 on a wide stage has no horizontal slack). */
  maxOffsetX: number;
  maxOffsetY: number;
};

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export function ZoomableStage({
  assetId,
  src,
  alt,
  onImageError,
  children,
}: {
  /** The asset on screen. Keys the `<img>` AND resets the zoom, which must be
   * the same value: navigating has to land the next photo fitted rather than
   * inheriting the previous one's magnification and pan. */
  assetId: string;
  src: string;
  alt: string;
  /** The 5-minute presigned-URL recovery path each viewer owns differently —
   * see their own comments. This component only forwards the event. */
  onImageError: () => void;
  /** Anything drawn OVER the photo — today just the client's swipe hint. */
  children?: ReactNode;
}) {
  // The two nodes are held in state, not refs, because a callback ref that
  // writes `.current` is itself enough to trip `react-hooks/refs`, and because
  // `measure` genuinely wants to re-run when either node changes identity.
  const [stageNode, setStageNode] = useState<HTMLDivElement | null>(null);
  const [imageNode, setImageNode] = useState<HTMLImageElement | null>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);

  const pointerIsFine = useSyncExternalStore(
    subscribeFinePointer,
    getFinePointerSnapshot,
    getFinePointerServerSnapshot,
  );

  // A NEW PHOTO ARRIVES FITTED. Adjusted during render (React's own documented
  // "adjusting state when a prop changes" pattern) rather than in an effect:
  // an effect would be a second render pass that briefly paints the incoming
  // photo at the outgoing one's magnification. `fit` needs no reset of its own
  // — the `<img>` below is keyed by `assetId`, so the element is replaced and
  // re-measured from scratch.
  const [lastAssetId, setLastAssetId] = useState(assetId);
  if (lastAssetId !== assetId) {
    setLastAssetId(assetId);
    setIsZoomed(false);
    setOffset({ x: 0, y: 0 });
    setDrag(null);
  }

  const measure = useCallback(() => {
    if (!stageNode || !imageNode) return;
    const { naturalWidth, naturalHeight } = imageNode;
    const stageWidth = stageNode.clientWidth;
    const stageHeight = stageNode.clientHeight;
    if (!naturalWidth || !naturalHeight || !stageWidth || !stageHeight) {
      setFit(null);
      return;
    }
    // What `object-contain` is doing right now, restated as a number: the
    // photo is painted at `fitScale` of its own size, so `1 / fitScale` is the
    // transform that undoes exactly that and no more.
    const fitScale = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
    const oneToOne = 1 / fitScale;
    if (!Number.isFinite(oneToOne) || oneToOne < MIN_WORTHWHILE_SCALE) {
      setFit(null);
      return;
    }
    // At 1:1 the painted image IS its natural size by definition, so the
    // overflow past each edge of the stage needs no second derivation.
    setFit({
      scale: oneToOne,
      maxOffsetX: Math.max(0, (naturalWidth - stageWidth) / 2),
      maxOffsetY: Math.max(0, (naturalHeight - stageHeight) / 2),
    });
  }, [stageNode, imageNode]);

  // The stage is a `1fr` row inside a full-screen fixed dialog, so the only
  // thing that can change its size is the window itself — no ResizeObserver
  // needed for a case that cannot happen here. What
  // `react-hooks/set-state-in-effect` objects to is setState in the effect
  // BODY; `measure` runs from the resize callback.
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const canZoom = pointerIsFine && fit !== null;
  const zoomActive = canZoom && isZoomed;

  // Clamped at render rather than on write, so a window resize that shrinks
  // the slack cannot leave a stale out-of-range offset painted on screen.
  const paintedOffset =
    zoomActive && fit
      ? { x: clamp(offset.x, fit.maxOffsetX), y: clamp(offset.y, fit.maxOffsetY) }
      : { x: 0, y: 0 };

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canZoom || event.button !== 0) return;
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: paintedOffset.x,
      originY: paintedOffset.y,
      moved: false,
    });
    // Capture keeps a pan alive when the cursor runs off the stage — the photo
    // fills the screen, so panning INTO an edge is the normal case, not an
    // edge case. JSDOM implements neither method; nothing here depends on the
    // capture succeeding.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Uncapturable pointer — panning still works while the cursor is over
      // the stage, which is all this call was buying.
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > DRAG_SLOP_PX;
    if (moved !== drag.moved) setDrag({ ...drag, moved });
    if (!zoomActive || !moved) return;
    setOffset({ x: drag.originX + dx, y: drag.originY + dy });
  }

  function releaseCapture(event: ReactPointerEvent<HTMLDivElement>) {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // See `setPointerCapture` above.
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    releaseCapture(event);
    setDrag(null);
    // A press that travelled is a pan that just finished, not a click. Without
    // this, every pan would also toggle the zoom off on release.
    if (drag.moved || !fit || !canZoom) return;
    if (isZoomed) {
      setIsZoomed(false);
      setOffset({ x: 0, y: 0 });
      return;
    }
    // Zoom towards what the cursor is actually pointing at. A point sitting
    // `d` px from the stage centre lands at `d * scale` once the image is
    // scaled about that centre, so translating by `-d * (scale - 1)` puts it
    // back under the cursor: click an eye, get the eye. Falls back to centring
    // if the stage box cannot be read.
    if (stageNode) {
      const rect = stageNode.getBoundingClientRect();
      const fromCentreX = event.clientX - (rect.left + rect.width / 2);
      const fromCentreY = event.clientY - (rect.top + rect.height / 2);
      setOffset({
        x: -fromCentreX * (fit.scale - 1),
        y: -fromCentreY * (fit.scale - 1),
      });
    } else {
      setOffset({ x: 0, y: 0 });
    }
    setIsZoomed(true);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    releaseCapture(event);
    setDrag(null);
  }

  const imageStyle: CSSProperties =
    zoomActive && fit
      ? {
          transform: `translate(${paintedOffset.x}px, ${paintedOffset.y}px) scale(${fit.scale})`,
        }
      : {};

  const cursorClass = !canZoom
    ? ""
    : zoomActive
      ? "cursor-grab active:cursor-grabbing"
      : "cursor-zoom-in";

  return (
    // `min-h-0` because a `1fr` grid row still takes `min-height: auto` from
    // its content otherwise, which on a short viewport would push the viewer's
    // footer off the bottom of the screen.
    <div
      ref={setStageNode}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className={`relative min-h-0 overflow-hidden select-none ${cursorClass}`}
    >
      {/* Plain <img>, not next/image: proof and display URLs are short-lived,
          private, presigned R2 URLs whose query string is never stable between
          two loads. `key` on the asset id so navigating swaps the element
          rather than mutating one <img>'s src, which is what keeps a failed
          load's `onError` attributable to the asset that failed.

          NOT `object-cover` (the grid tiles' own choice, for density) —
          `object-contain`, because showing the WHOLE photo is this screen's
          entire reason to exist, and it is also what the zoom maths above
          assumes when it inverts the fit.

          `draggable={false}` is load-bearing: without it the browser's native
          image drag starts up mid-pan and the photo tears off the cursor. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={assetId}
        ref={setImageNode}
        src={src}
        alt={alt}
        onError={onImageError}
        onLoad={measure}
        draggable={false}
        style={imageStyle}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {children}
    </div>
  );
}
