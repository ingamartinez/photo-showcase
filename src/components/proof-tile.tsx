"use client";

// ONE tile of the client's proof grid (task #23), split out of proof-grid.tsx
// by task #144. Presentational only: it holds no state, issues no request and
// decides nothing — every flag below is computed by <ProofGrid> and every
// click is handed straight back to it.
import { DownloadFinalButton } from "@/components/download-final-button";
import type { ProofAsset } from "@/components/proof-grid";

export function ProofTile({
  asset,
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
        className="focus-visible:ring-accent block w-full rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {/* Aspect ratio reserved from `proofWidth`/`proofHeight` BEFORE the
            image ever arrives — this is what makes the grid load with zero
            cumulative layout shift, the columns this task's acceptance
            criterion is about. */}
        <div
          className="bg-bg-2 relative overflow-hidden rounded-sm"
          style={{ aspectRatio: `${asset.proofWidth} / ${asset.proofHeight}` }}
        >
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
            className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
          />
        </div>
      </button>

      {/* A sibling of the "open lightbox" button above, not nested inside
          it — a nested button would be invalid HTML (buttons can't nest) and
          would also make this click bubble into `onOpen`. Positioned on top
          of the tile only visually, via absolute placement on the `relative`
          <li>. Never blocks or scolds going over quota (task #24) — this
          control does exactly one thing, flip this one asset's selection,
          regardless of how many are already selected. */}
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
        className={`absolute top-2 right-2 z-10 rounded-full px-2 py-1 text-xs font-medium shadow transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          isSelected ? "bg-accent text-bg" : "bg-bg/85 text-fg hover:bg-bg"
        }`}
      >
        {isSelected ? "✓ Seleccionada" : "Seleccionar"}
      </button>

      {/* Bottom-right, not on top of the selection badge above — task #28's
          own affordance, shown only once the gallery is delivered AND this
          specific asset actually has a final (see <ProofGrid>'s own
          `showDownload` computation). */}
      {showDownload && (
        <div className="absolute right-2 bottom-2 z-10">
          <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
        </div>
      )}
    </li>
  );
}
