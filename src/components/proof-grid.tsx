"use client";

// The client's own view of a gallery's proofs (task #23): a responsive grid
// that reserves each tile's exact aspect ratio up front (no cumulative
// layout shift while images load) plus a lightbox for full-screen browsing
// with keyboard/swipe navigation.
//
// URL-expiry strategy — decided and written down here, not left implicit:
// presigned proof URLs are good for `PRESIGNED_URL_TTL_SECONDS` (5 minutes,
// src/lib/r2.ts) from the moment the server component that renders this
// page presigned them. A client is expected to leave this tab open past
// that (this is "browse your wedding photos", not a five-minute task,
// especially from bed on a phone) — so a page that only ever trusted its
// initial batch of URLs would start showing broken images partway through
// a normal session.
//
// The admin workspace (task #20, src/components/asset-tile.tsx) already
// solved the identical problem for its own grid with a per-tile <img
// onError> one-shot refetch against the SAME read route this app already
// has (`GET /api/assets/[assetId]/proof`, task #16) — that approach is
// reused here rather than inventing a batch-refresh-on-a-timer scheme: it
// only ever re-signs an asset that is actually on screen and actually
// stale, and needs no new endpoint.
//
// One deliberate difference from asset-tile.tsx: THIS surface renders the
// same asset in two different DOM nodes at once when the lightbox is open
// (the grid tile behind it, and the full-screen image) — the admin grid
// never does that. Refreshed-URL state therefore lives HERE, one level up,
// keyed by asset id, and is shared by both <ProofTile> and <ProofLightbox>
// for the same asset — so a URL that has already been refreshed by one
// surface doesn't need re-fetching by the other, and each asset is still
// only ever refreshed once (guarded by `refreshedAssetIds`), exactly like
// the admin version's `refreshedOnce` guard.
//
// Because the fix is "swap this one asset's src in place" rather than a
// hard reload, the client's scroll position and any open lightbox survive
// a stale-URL recovery untouched — the acceptance criterion this task
// calls out ("a stale page recovers... without a hard reload losing the
// client's place").
import { useCallback, useRef, useState } from "react";
import { ProofLightbox } from "@/components/proof-lightbox";

export type ProofAsset = {
  id: string;
  originalFilename: string;
  proofWidth: number;
  proofHeight: number;
  // Carried through even though nothing here reads it yet — task #24 adds
  // the selection toggle and live quota counter on top of this same grid;
  // keeping the field on the shared asset shape now means that slice can
  // extend <ProofTile> without reshaping the data every page already passes
  // down.
  isSelected: boolean;
  proofUrl: string;
};

export function ProofGrid({ initialAssets }: { initialAssets: ProofAsset[] }) {
  const [urls, setUrls] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialAssets.map((asset) => [asset.id, asset.proofUrl])),
  );
  // A Set (not state) — which assets have already been refreshed doesn't
  // need to trigger a re-render on its own, only the `urls` update it
  // causes does.
  const refreshedAssetIds = useRef<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const refreshUrl = useCallback(async (assetId: string) => {
    if (refreshedAssetIds.current.has(assetId)) return;
    refreshedAssetIds.current.add(assetId);
    try {
      const response = await fetch(`/api/assets/${assetId}/proof`);
      if (!response.ok) return;
      const body = (await response.json()) as { url: string };
      setUrls((prev) => ({ ...prev, [assetId]: body.url }));
    } catch {
      // Leave the broken thumbnail as-is; nothing else to try here — same
      // fallback as asset-tile.tsx's handleImgError.
    }
  }, []);

  if (initialAssets.length === 0) {
    return (
      <p className="text-fg-dim text-[15px] leading-relaxed">
        Tu fotógrafo todavía no subió fotos para esta galería.
      </p>
    );
  }

  return (
    <>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {initialAssets.map((asset, index) => (
          <ProofTile
            key={asset.id}
            asset={asset}
            src={urls[asset.id] ?? asset.proofUrl}
            onError={() => void refreshUrl(asset.id)}
            onOpen={() => setLightboxIndex(index)}
          />
        ))}
      </ul>

      {lightboxIndex !== null && (
        <ProofLightbox
          assets={initialAssets}
          urls={urls}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onImageError={(assetId) => void refreshUrl(assetId)}
        />
      )}
    </>
  );
}

function ProofTile({
  asset,
  src,
  onError,
  onOpen,
}: {
  asset: ProofAsset;
  src: string;
  onError: () => void;
  onOpen: () => void;
}) {
  return (
    <li>
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
    </li>
  );
}
