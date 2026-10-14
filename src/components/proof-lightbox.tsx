"use client";

// Full-screen viewer for one proof at a time (tasks #23, #24, #28, #146, #206,
// #214) — the SELECTION flavour of <PhotoViewer>. Since task #237 the viewing
// mechanics (modal, scroll lock, arrows, pinch-safe swipe, prev/next, stage)
// live in photo-viewer.tsx so the flash gallery page can mount the very same
// viewer without any of this file's selection wiring. What stays here is what
// is specific to picking: the "cuántas van" line, the pick button, the
// edited/original type control and the delivered per-photo download. It is
// composed into the viewer's slots; no layout or behaviour moved.
import { DownloadFinalButton } from "@/components/download-final-button";
import { Check } from "@/components/icons";
import { PhotoViewer } from "@/components/photo-viewer";
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
  // grid tile for the SAME asset.
  urls: Record<string, string>;
  index: number;
  // Task #146: the SAME server-recomputed `QuotaResult` <SelectionCounter>
  // renders, passed through untouched — this component does no arithmetic on
  // it. On a phone the grid's own counter is inside the `aria-hidden` region
  // the modal puts behind itself, so its `aria-live` cannot announce.
  quota: QuotaResult;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onImageError: (assetId: string) => void;
  // Task #24: the client can also toggle selection from the full-screen
  // view — same handler <ProofGrid> passes to <ProofTile>.
  onToggleSelection: (assetId: string, nextSelected: boolean) => void;
  pendingAssetIds: Set<string>;
  // Task #25: UX-only mirror of the server-side lock.
  isLocked: boolean;
  // Task #28: combined per-render with the CURRENT asset's own `hasFinal`
  // (not hoisted into one boolean) because which asset is current changes on
  // every navigation within this same mounted component.
  isDelivered: boolean;
  // Task #206 — every selected asset's own type, keyed by id, the SAME map
  // <ProofGrid> hands to <ProofTile>. An unselected asset has no entry.
  selectionKindById: Record<string, SelectionKind>;
  // Generic over `assetId` (unlike the tile's already-bound version) because
  // this component iterates over `assets` by `index`.
  onSetSelectionKind: (assetId: string, kind: SelectionKind) => void;
  /** Task #214 — `false` (the default for every gallery) hides this screen's
   * type control entirely, regardless of `isSelected`/`isLocked`. */
  allowsOriginalSelection: boolean;
}) {
  const asset = assets[index];
  // Defensive only: <ProofGrid> never passes an out-of-range index.
  if (!asset) return null;

  const isSelected = asset.isSelected;
  const isPickDisabled = pendingAssetIds.has(asset.id) || isLocked;
  // Task #206 — only meaningful while `isSelected`.
  const selectionKind = selectionKindById[asset.id] ?? "edited";

  return (
    <PhotoViewer
      photos={assets.map((a) => ({
        id: a.id,
        src: urls[a.id] ?? a.proofUrl,
        name: a.originalFilename,
      }))}
      index={index}
      onClose={onClose}
      onNavigate={onNavigate}
      onImageError={onImageError}
      subtitle={
        // "Cuántas van" (client.html:701). `aria-live` because toggling
        // changes it while the client is looking at the photo, not at this
        // line, and the grid's own counter is `aria-hidden` behind the dialog.
        <p className="text-fg-mute mt-[2px] text-xs" aria-live="polite">
          {quota.selected} elegidas · {quota.includedPhotosSnapshot} incluidas
        </p>
      }
      centerAction={
        /* `.btn.btn--primary.btn--wide` when picked, the plain `.btn` outline
           when not. PICKED IS NEVER COLOUR ALONE: a ✓ glyph (shape), the
           label "Elegida" (wording) and a filled block (figure/ground);
           `aria-pressed` carries it to assistive tech. The accessible name is
           the visible label, NOT the tile's "Seleccionar: IMG_0001.JPG", so
           `getByRole("button", { name })` is not ambiguous while the tile is
           still mounted behind the dialog. */
        <button
          type="button"
          onClick={() => onToggleSelection(asset.id, !isSelected)}
          disabled={isPickDisabled}
          aria-pressed={isSelected}
          className={`inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[3px] border px-5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
            isSelected
              ? "border-accent bg-accent text-ink font-semibold tracking-[0.02em]"
              : "border-line-2 text-fg hover:border-accent hover:text-accent-2 tracking-[0.04em]"
          }`}
        >
          {isSelected && (
            <span aria-hidden="true">
              <Check />
            </span>
          )}
          {isSelected ? "Elegida" : "Elegir esta foto"}
        </button>
      }
      footerExtras={
        <>
          {/* Task #206 — the type control appears only once picked and
              unlocked, and only when the gallery allows originals; same gate
              as <ProofTile>'s own. Two explicit buttons rather than a flip,
              mirroring the PATCH route's body shape. */}
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
                    ? "bg-accent text-ink font-semibold"
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
                    ? "bg-accent text-ink font-semibold"
                    : "text-fg hover:text-accent-2"
                }`}
              >
                Original
              </button>
            </div>
          )}

          {/* Task #28's per-asset download, re-derived on every navigation. */}
          {isDelivered && asset.hasFinal && (
            <div className="flex justify-center">
              <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
            </div>
          )}
        </>
      }
    />
  );
}
