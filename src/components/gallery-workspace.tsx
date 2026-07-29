"use client";

// The photographer's actual workspace (task #20): owns the live list of an
// open gallery's assets client-side, and wires the upload widget and the
// asset grid together against that single source of truth. The server
// component above this (src/app/dashboard/galleries/[galleryId]/page.tsx)
// only ever provides the INITIAL list — every mutation afterward (a new
// upload, a delete, a reorder) updates this component's state directly from
// the mutating request's own response, with no `router.refresh()` anywhere
// in this tree. That matters for the ~100-file upload case this task is
// built around: refreshing the whole server component after every file (or
// even once per batch) would re-run `getGalleryDetail()` and re-presign
// every asset's URL for no reason — the response each request already
// carries is enough to update local state exactly, and cheaply.
import { useCallback, useMemo, useState } from "react";
import { AssetTile } from "@/components/asset-tile";
import { ProofUploader } from "@/components/proof-uploader";

export type WorkspaceAsset = {
  id: string;
  originalFilename: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  sortOrder: number;
  proofUrl: string;
  // Whether `assets.final_key` is set — task #26. Deliberately a boolean,
  // not the raw R2 key: this client component never needs the key itself
  // (uploading and previewing both go through their own routes), and a
  // private R2 key has no reason to travel to the browser at all.
  hasFinal: boolean;
};

export function GalleryWorkspace({
  galleryId,
  initialAssets,
}: {
  galleryId: string;
  initialAssets: WorkspaceAsset[];
}) {
  const [assets, setAssets] = useState<WorkspaceAsset[]>(initialAssets);

  // Re-sorted on every render off `sortOrder`, never assumed to already be
  // in order — `handleMoved` below only patches the two changed rows'
  // `sortOrder` values, it does not itself reorder the array.
  const sorted = useMemo(() => [...assets].sort((a, b) => a.sortOrder - b.sortOrder), [assets]);

  // Task #26's own scope note: "the screen should make the remaining work
  // obvious — which selected assets still lack a final." Derived from this
  // component's own live `assets` state (not re-read from the server) so it
  // updates the instant a final finishes uploading, with no
  // `router.refresh()` — same reasoning as every other mutation in this
  // component.
  const selectedCount = useMemo(() => sorted.filter((asset) => asset.isSelected).length, [sorted]);
  const pendingFinalsCount = useMemo(
    () => sorted.filter((asset) => asset.isSelected && !asset.hasFinal).length,
    [sorted],
  );

  const handleUploaded = useCallback((asset: WorkspaceAsset) => {
    setAssets((prev) => [...prev, asset]);
  }, []);

  const handleDeleted = useCallback((assetId: string) => {
    setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
  }, []);

  const handleMoved = useCallback((updates: { id: string; sortOrder: number }[]) => {
    if (updates.length === 0) return;
    setAssets((prev) =>
      prev.map((asset) => {
        const update = updates.find((u) => u.id === asset.id);
        return update ? { ...asset, sortOrder: update.sortOrder } : asset;
      }),
    );
  }, []);

  const handleFinalUploaded = useCallback((assetId: string) => {
    setAssets((prev) =>
      prev.map((asset) => (asset.id === assetId ? { ...asset, hasFinal: true } : asset)),
    );
  }, []);

  return (
    <div className="flex flex-col gap-10">
      <ProofUploader galleryId={galleryId} onUploaded={handleUploaded} />

      {selectedCount > 0 && (
        <p className="text-fg-dim text-sm">
          {pendingFinalsCount > 0
            ? `Faltan ${pendingFinalsCount} de ${selectedCount} finales por subir.`
            : `Los ${selectedCount} finales de la selección ya están subidos.`}
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="text-fg-dim text-[15px] leading-relaxed">
          Todavía no subiste fotos de esta sesión — usá el selector de arriba.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {sorted.map((asset, index) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              isFirst={index === 0}
              isLast={index === sorted.length - 1}
              onDeleted={handleDeleted}
              onMoved={handleMoved}
              onFinalUploaded={handleFinalUploaded}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
