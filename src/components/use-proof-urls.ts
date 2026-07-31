"use client";

// The presigned-URL freshness of the client's gallery view (task #23), lifted
// out of <ProofGrid> by task #144 — the code and its reasoning moved together,
// unchanged. <ProofGrid> calls this hook; nothing else does, and nothing here
// knows anything about selection, quota or live sync.
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
// never does that. Refreshed-URL state therefore lives HERE, in a hook
// <ProofGrid> calls one level up from the tiles, keyed by asset id, and is
// shared by both <ProofTile> and <ProofLightbox> for the same asset — so a
// URL that has already been refreshed by one surface doesn't need re-fetching
// by the other, and each asset is still only ever refreshed once (guarded by
// `refreshedAssetIds`), exactly like the admin version's `refreshedOnce`
// guard.
//
// Because the fix is "swap this one asset's src in place" rather than a
// hard reload, the client's scroll position and any open lightbox survive
// a stale-URL recovery untouched — the acceptance criterion this task
// calls out ("a stale page recovers... without a hard reload losing the
// client's place").
import { useCallback, useRef, useState } from "react";

/** The three fields of `ProofAsset` (src/components/proof-grid.tsx) this hook
 * actually reads. Declared structurally rather than importing `ProofAsset`
 * itself: the URL map has no opinion about selection or downloads, and taking
 * only what it needs keeps this module free of any dependency on the component
 * that calls it. */
export type ProofUrlAsset = {
  id: string;
  proofUrl: string;
  displayUrl: string | null;
};

export function useProofUrls(initialAssets: ProofUrlAsset[]) {
  // Task #89: seeded from the DISPLAY url when the page provided one, falling
  // back to the proof. Seeding this ONE map — rather than teaching <ProofTile>
  // and <ProofLightbox> each to prefer a different field — is what makes the
  // unwatermarked image appear in the grid AND the lightbox from a single
  // change: both surfaces already read this map, keyed by asset id, and have
  // done since task #23.
  const [urls, setUrls] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialAssets.map((asset) => [asset.id, asset.displayUrl ?? asset.proofUrl]),
    ),
  );
  // A Set (not state) — which assets have already been refreshed doesn't
  // need to trigger a re-render on its own, only the `urls` update it
  // causes does.
  const refreshedAssetIds = useRef<Set<string>>(new Set());

  // Which assets were rendered with a DISPLAY url rather than a proof url
  // (task #89), captured ONCE from the server-rendered props. `refreshUrl`
  // below is a `useCallback` with an empty dependency array — deliberately,
  // like `toggleSelection` in use-shared-selection.ts — so it cannot read
  // `initialAssets` directly without either going stale or dragging the whole
  // array into its dependencies. A lazily-initialized ref gives it a stable,
  // render-count-independent answer instead. Safe to freeze at first render:
  // whether an asset HAS a display derivative is decided by the gallery's
  // status and the photographer's uploads, neither of which changes without a
  // page load.
  const displayAssetIds = useRef<Set<string> | null>(null);
  if (displayAssetIds.current === null) {
    displayAssetIds.current = new Set(
      initialAssets.filter((asset) => asset.displayUrl !== null).map((asset) => asset.id),
    );
  }

  const refreshUrl = useCallback(async (assetId: string) => {
    if (refreshedAssetIds.current.has(assetId)) return;
    refreshedAssetIds.current.add(assetId);
    try {
      // Task #89: an asset showing its unwatermarked derivative must be
      // re-signed against THAT object, not the proof — asking `/proof` here
      // would silently put the watermark back on a delivered photo the first
      // time its URL aged past PRESIGNED_URL_TTL_SECONDS.
      //
      // Two-step, in this order, because the display route can legitimately
      // answer 404 for a reason the proof route cannot: a final uploaded
      // BEFORE task #89 shipped has no display object in R2 until
      // `bun run backfill:display` has run, and that route does a HEAD check
      // rather than handing back a presigned URL for something absent (see
      // its own comment). Falling back to the proof then is a DEGRADED but
      // correct outcome — the client sees the watermarked version of a photo
      // they own, not a broken tile — and it fails in the protective
      // direction, which is the right way for this particular thing to fail.
      if (displayAssetIds.current?.has(assetId)) {
        const displayResponse = await fetch(`/api/assets/${assetId}/display`);
        if (displayResponse.ok) {
          const body = (await displayResponse.json()) as { url: string };
          setUrls((prev) => ({ ...prev, [assetId]: body.url }));
          return;
        }
      }

      const response = await fetch(`/api/assets/${assetId}/proof`);
      if (!response.ok) return;
      const body = (await response.json()) as { url: string };
      setUrls((prev) => ({ ...prev, [assetId]: body.url }));
    } catch {
      // Leave the broken thumbnail as-is; nothing else to try here — same
      // fallback as asset-tile.tsx's handleImgError.
    }
  }, []);

  return { urls, refreshUrl };
}
