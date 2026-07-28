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

  return (
    <div className="flex flex-col gap-10">
      <ProofUploader galleryId={galleryId} onUploaded={handleUploaded} />

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
            />
          ))}
        </ul>
      )}
    </div>
  );
}
