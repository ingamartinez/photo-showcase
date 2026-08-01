"use client";

// Full-screen viewer for one proof at a time, in the ADMIN dashboard (task
// #195). The owner's own words: "sólo ve miniaturas, quiere click para ver
// la foto en grande". `asset-tile.tsx`'s thumbnail is a fixed `aspect-[3/2]`
// box with `object-cover` (task #134) — it crops on purpose, for grid
// density. This screen shows the photo `object-contain`, whole, which is the
// entire point of the request.
//
// MECHANICS REUSED FROM `proof-lightbox.tsx` (task #146), PIXELS NOT
// ====================================================================
// `proof-lightbox.tsx`'s own header comment explains why it is not reused
// wholesale: its props (`quota`, `onToggleSelection`, `isLocked`,
// `isDelivered`) are the CLIENT's decision screen, and it deliberately
// imports `radix-ui`'s `Dialog` primitive directly rather than
// `@/components/ui/dialog`, specifically so the client surface never
// inherits the panel's `data-surface="app"` palette. Mounting THAT component
// here would be the identical mistake in reverse — dragging the client
// surface's own look into the admin panel.
//
// What travels from that file to this one is the MODAL MECHANICS, not a
// shared component: the same `radix-ui` `Dialog` primitive, the same
// focus-capture-on-open / focus-restore-on-close pattern (Radix restores
// focus to its own `<Dialog.Trigger>`, and there is no trigger here either —
// this mounts from `<GalleryWorkspace>`'s own state, not from 84 tiles each
// wrapped in a dialog), the same hand-rolled scroll lock (verified, same as
// that file's own comment, to behave identically under JSDOM regardless of
// whether the `react-remove-scroll` sidecar loaded), and the same ←/→
// keydown-on-`window` navigation for the same reason: a window listener
// survives the moment right after `onNavigate` when the pressed prev/next
// button goes `disabled` and the browser drops focus to `<body>`.
//
// THE MARKED SET LIVES ABOVE THIS COMPONENT
// ==========================================
// `markedIds` and `onToggleMarked` are owned by `<GalleryWorkspace>`, passed
// straight through — this component neither reads nor writes any state that
// survives its own unmount. That is what makes "open a marked photo full
// screen, navigate, close, still marked" true by construction rather than by
// an ad hoc reconciliation: there is nothing here TO lose, because nothing
// marking-related is stored here in the first place. See
// gallery-workspace.tsx's own comment on why the `Set` lives there.
//
// NAMING: NOT `selected`/`selection` — see gallery-workspace.tsx's header
// comment on the collision with `assets.isSelected` (the CLIENT's choice).
// `markedIds`/`onToggleMarked` throughout, on purpose.
import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { WorkspaceAsset } from "@/components/gallery-workspace";
import { cn } from "@/lib/utils";

export function AdminAssetViewer({
  assets,
  index,
  markedIds,
  onToggleMarked,
  onClose,
  onNavigate,
}: {
  assets: WorkspaceAsset[];
  index: number;
  markedIds: Set<string>;
  onToggleMarked: (assetId: string) => void;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const asset = assets[index];
  const openerRef = useRef<HTMLElement | null>(null);

  // A per-asset, in-component refreshed-URL cache — this component's own
  // lifetime IS its cache's lifetime (it unmounts on close, so nothing to
  // clean up on the way out). Unlike `<ProofLightbox>`, which shares its
  // `urls` map with a sibling grid, `<AssetTile>` never lifts its own
  // refreshed URL up to `<GalleryWorkspace>` (each tile owns its own `src`
  // state independently) — so this viewer keeps an independent copy rather
  // than assuming the tile for the SAME asset already refreshed it. Two
  // surfaces can legitimately be looking at two different presigned
  // signatures for the same photo at the same moment; each recovers on its
  // own `onError`, same as the tile does.
  const [refreshedUrls, setRefreshedUrls] = useState<Record<string, string>>({});
  // Guards each asset id's refresh attempt to exactly once — same
  // `refreshedOnce` idempotence guarantee as `asset-tile.tsx`'s own
  // `handleImgError`, just keyed per asset instead of per component instance
  // (one <AssetTile> only ever shows one asset; this viewer shows many over
  // its lifetime as the admin navigates). A `ref`, not `useState`: recording
  // an attempt must never itself trigger a re-render.
  const attemptedRefreshRef = useRef<Set<string>>(new Set());

  const hasPrev = index > 0;
  const hasNext = index < assets.length - 1;

  // Background scroll lock — see proof-lightbox.tsx's own comment on why
  // this is a hand-rolled six-line effect rather than relying on the dialog
  // primitive's own scroll-lock sidecar (verified absent under JSDOM).
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // ←/→ only — `Escape` belongs to the dialog primitive's own dismiss layer
  // (listens on `document`), so a second handler here would double-fire
  // `onClose` for one keypress. Bound to `window`, not the content element,
  // for the same reason proof-lightbox.tsx gives: focus IS trapped inside
  // the dialog so a bubbling keydown would reach either, but a window
  // listener also survives the instant right after `onNavigate` when the
  // just-pressed prev/next button becomes `disabled` and focus drops to
  // `<body>`.
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

  // Defensive only: <GalleryWorkspace> never passes an out-of-range index —
  // it closes the viewer itself when the asset it was showing disappears
  // (a bulk delete, most likely) rather than leaving a stale index around.
  if (!asset) return null;

  const src = refreshedUrls[asset.id] ?? asset.proofUrl;
  const isMarked = markedIds.has(asset.id);

  // Same 5-minute presigned-URL recovery path as every other surface that
  // shows a proof (`PRESIGNED_URL_TTL_SECONDS`, src/lib/r2.ts) — looking at
  // one photograph for longer than that is the ordinary case here, not an
  // edge case, especially once #194's lazy-loaded grid means a photo can
  // reach this screen without the TILE ever having fetched (and therefore
  // refreshed) its own copy first.
  async function handleImgError(assetId: string) {
    if (attemptedRefreshRef.current.has(assetId)) return;
    attemptedRefreshRef.current.add(assetId);
    try {
      const response = await fetch(`/api/assets/${assetId}/proof`);
      if (!response.ok) return;
      const body = (await response.json()) as { url: string };
      setRefreshedUrls((prev) => ({ ...prev, [assetId]: body.url }));
    } catch {
      // Leave the broken image as-is; nothing else to try here.
    }
  }

  const CHROME_BUTTON =
    "inline-flex items-center justify-center rounded-[3px] border border-line-2 text-fg transition-colors hover:border-accent hover:text-accent-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-2 disabled:hover:text-fg";

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* No <Overlay>: the stage is an opaque ground, not a scrim over the
            grid — same call proof-lightbox.tsx makes and for the same
            reason, a photograph is being looked at closely here. */}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // Focus restore, done by hand — same reasoning as
          // proof-lightbox.tsx's own comment: Radix restores focus to its
          // own `<Dialog.Trigger>`, and there is none here (this mounts from
          // <GalleryWorkspace>'s state, not from a per-tile dialog wrapper).
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          className="bg-bg-sunken fixed inset-0 z-50 grid grid-rows-[auto_1fr_auto] outline-none"
        >
          <div className="flex items-center justify-between gap-3 px-4 py-[10px] sm:px-7 lg:px-12">
            <div className="min-w-0">
              <p className="text-fg-dim font-mono text-xs tracking-[0.1em] tabular-nums">
                {index + 1} / {assets.length}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="text-fg-dim hover:text-fg grid h-12 w-12 shrink-0 place-items-center text-[20px] leading-none transition-colors"
            >
              ✕
            </button>
          </div>

          <div className="relative min-h-0 overflow-hidden">
            {/* Plain <img>, not next/image — same reasoning as
                asset-tile.tsx and proof-lightbox.tsx: proof URLs are
                short-lived, private, presigned R2 URLs whose query string is
                never stable between two loads. `key` on the asset id so
                navigating swaps the element, which is what keeps a failed
                load's `onError` attributable to the asset that failed. NOT
                `object-cover` (asset-tile.tsx's own choice, for grid
                density) — `object-contain`, because showing the WHOLE photo
                is this screen's entire reason to exist. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={asset.id}
              src={src}
              alt={asset.originalFilename}
              onError={() => void handleImgError(asset.id)}
              className="absolute inset-0 h-full w-full object-contain"
            />
          </div>

          <div className="grid gap-[10px] px-4 pt-3 pb-[calc(14px+env(safe-area-inset-bottom,0px))] sm:px-7 lg:px-12">
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

              {/* Task #195's own naming trap: this toggles the PHOTOGRAPHER'S
                  bulk-op mark, not the client's `isSelected` — worded and
                  coloured to look nothing like proof-lightbox.tsx's "Elegir
                  esta foto" pick button (accent/brass) or asset-tile.tsx's
                  "Elegida" badge (also accent/brass). `#e0796b` — the SAME
                  danger red asset-tile.tsx's own checkbox and error text
                  use, not the `app-danger` Tailwind utility (see that
                  file's own comment on this exact point: that utility only
                  paints under `[data-surface="app"]`, and this file's own
                  name doesn't qualify for eslint.config.mjs's
                  `no-restricted-syntax` exemption even though it only
                  renders inside the dashboard). A deliberate
                  destructive-intent signal, reused rather than invented:
                  this mark's only consequence is bulk deletion. */}
              <button
                type="button"
                onClick={() => onToggleMarked(asset.id)}
                aria-pressed={isMarked}
                className={cn(
                  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[3px] border px-5 text-sm transition-colors",
                  isMarked
                    ? "border-[#e0796b] bg-[#e0796b] font-semibold tracking-[0.02em] text-[#1a0d0a]"
                    : "border-line-2 text-fg tracking-[0.04em] hover:border-[#e0796b] hover:text-[#e0796b]",
                )}
              >
                {isMarked && <span aria-hidden="true">✓</span>}
                {isMarked ? "Marcada para borrar" : "Marcar para borrar"}
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
