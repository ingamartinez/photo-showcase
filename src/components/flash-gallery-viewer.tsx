"use client";

// The client-facing flash gallery (task #237): the SAME grid, tiles and
// full-screen viewer a delivered normal gallery uses — <PhotoTile> and
// <PhotoViewer> are the presentational layer extracted from <ProofTile> and
// <ProofLightbox> — minus everything that is about choosing. There is no
// selection state here, no quota, no tray, no shared-selection polling and no
// request of any kind besides the browser loading the photos and following the
// download links. All URLs are flash's own routes under `/flash/<slug>/…`,
// gated by `resolveFlashGallery` on the server; nothing points at the normal
// gallery routes.
import { useState } from "react";
import { DownloadAllButton } from "@/components/download-all-button";
import { PhotoTile } from "@/components/photo-tile";
import { PhotoViewer } from "@/components/photo-viewer";

export type FlashViewerAsset = { id: string; originalFilename: string };

const DOWNLOAD_CLASS =
  "bg-accent text-bg rounded-full px-3 py-1 text-xs font-medium shadow transition-opacity";

export function FlashGalleryViewer({
  publicSlug,
  assets,
}: {
  publicSlug: string;
  // Already in the gallery's display order (`sortOrder, createdAt, id`); this
  // component never reorders.
  assets: FlashViewerAsset[];
}) {
  const base = `/flash/${publicSlug}`;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (assets.length === 0) return null;

  const current = openIndex === null ? null : assets[openIndex];

  return (
    <>
      <div className="mb-6">
        <DownloadAllButton href={`${base}/zip`} assetCount={assets.length} />
      </div>

      <ul className="grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4 lg:gap-[3px]">
        {assets.map((asset, index) => (
          <PhotoTile
            key={asset.id}
            name={asset.originalFilename}
            position={index + 1}
            src={`${base}/display/${asset.id}`}
            // The display route redirects to a fresh presigned URL on every
            // request, so a reload is the recovery path; there is no
            // client-side refresh endpoint to call.
            onError={() => {}}
            onOpen={() => setOpenIndex(index)}
          >
            <div className="absolute bottom-2 left-2 z-10">
              <a
                href={`${base}/final/${asset.id}`}
                aria-label={`Descargar: ${asset.originalFilename}`}
                className={DOWNLOAD_CLASS}
              >
                Descargar
              </a>
            </div>
          </PhotoTile>
        ))}
      </ul>

      {current && openIndex !== null && (
        <PhotoViewer
          photos={assets.map((a) => ({
            id: a.id,
            src: `${base}/display/${a.id}`,
            name: a.originalFilename,
          }))}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onNavigate={setOpenIndex}
          onImageError={() => {}}
          footerExtras={
            <div className="flex justify-center">
              <a
                href={`${base}/final/${current.id}`}
                aria-label={`Descargar: ${current.originalFilename}`}
                className={DOWNLOAD_CLASS}
              >
                Descargar
              </a>
            </div>
          }
        />
      )}
    </>
  );
}
