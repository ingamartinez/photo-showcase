"use client";

// Full-screen viewer for one proof at a time (task #23). Owns keyboard
// navigation (←/→/Esc) and a light touch-swipe gesture — the "works on a
// phone, in bed, right after the shoot" acceptance criterion this task
// calls out explicitly. Rendered by <ProofGrid> only while a tile is open;
// unmounting it is what removes the keydown listener, so there is nothing
// else to gate "is this even open" on.
import { useEffect, useRef } from "react";
import { DownloadFinalButton } from "@/components/download-final-button";
import type { ProofAsset } from "@/components/proof-grid";

export function ProofLightbox({
  assets,
  urls,
  index,
  onClose,
  onNavigate,
  onImageError,
  onToggleSelection,
  pendingAssetIds,
  isLocked,
  isDelivered,
}: {
  assets: ProofAsset[];
  // Keyed by asset id. <ProofGrid> owns this state and shares it with the
  // grid tile for the SAME asset — see that file's header comment for why
  // the refreshed-URL state lives one level up instead of being duplicated
  // per surface.
  urls: Record<string, string>;
  index: number;
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
}) {
  const asset = assets[index];
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef<number | null>(null);

  // Focus the close button on open, both as a sane a11y default for a modal
  // dialog and so Escape/Tab work immediately without a prior click.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Body scroll lock while the lightbox is mounted — otherwise a swipe or
  // arrow-key navigation on a long gallery page also scrolls the page
  // underneath on some mobile browsers.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const hasPrev = index > 0;
  const hasNext = index < assets.length - 1;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
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
  }, [index, hasPrev, hasNext, onClose, onNavigate]);

  // Defensive only: <ProofGrid> never passes an out-of-range index, but this
  // keeps the component from throwing if it ever did.
  if (!asset) return null;

  const src = urls[asset.id] ?? asset.proofUrl;

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={asset.originalFilename}
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
    >
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <p className="text-fg-dim truncate text-xs sm:text-sm">
          {index + 1} / {assets.length} · {asset.originalFilename}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onToggleSelection(asset.id, !asset.isSelected)}
            disabled={pendingAssetIds.has(asset.id) || isLocked}
            aria-pressed={asset.isSelected}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              asset.isSelected ? "bg-accent text-bg" : "bg-fg/10 text-fg hover:bg-fg/20"
            }`}
          >
            {asset.isSelected ? "✓ Seleccionada" : "Seleccionar"}
          </button>
          {isDelivered && asset.hasFinal && (
            <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
          )}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="text-fg hover:text-accent-2 -m-2 p-2 text-2xl leading-none transition-colors"
          >
            ×
          </button>
        </div>
      </div>

      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden px-2 pb-4 sm:px-4"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {hasPrev && (
          <button
            type="button"
            onClick={() => onNavigate(index - 1)}
            aria-label="Foto anterior"
            className="text-fg absolute top-1/2 left-1 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-2xl leading-none transition-colors hover:bg-black/60 sm:left-4"
          >
            ‹
          </button>
        )}

        {/* Plain <img>, not next/image: same reasoning as asset-tile.tsx —
            proof URLs are short-lived, private, presigned R2 URLs whose
            query string is never stable between two loads. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={asset.id}
          src={src}
          alt={asset.originalFilename}
          onError={() => onImageError(asset.id)}
          className="max-h-full max-w-full object-contain"
        />

        {hasNext && (
          <button
            type="button"
            onClick={() => onNavigate(index + 1)}
            aria-label="Foto siguiente"
            className="text-fg absolute top-1/2 right-1 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-2xl leading-none transition-colors hover:bg-black/60 sm:right-4"
          >
            ›
          </button>
        )}
      </div>
    </div>
  );
}
