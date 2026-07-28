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
//
// Selection + live quota counter (task #24) live in THIS component, not a
// separate one, because the counter and the grid share the exact same
// selection state: toggling a tile must update the counter in the same
// render, and there is nowhere else both already meet. The counter's
// numbers, though, are never computed here — every response from `PATCH
// /api/assets/[assetId]/selection` (src/app/api/assets/[assetId]/selection/route.ts)
// already carries a freshly server-recomputed `quota` (via `computeQuota`,
// src/lib/quota.ts), and this component does nothing but store exactly
// that object in state and hand it to <SelectionCounter>. There is no local
// increment/decrement anywhere in this file — the acceptance criterion "the
// counter matches a server-side recomputation; the client cannot influence
// the numbers by editing anything" is satisfied by never giving the client
// anything to compute in the first place, not by re-deriving the same maths
// twice and hoping they stay in sync.
import { useCallback, useRef, useState } from "react";
import { ProofLightbox } from "@/components/proof-lightbox";
import { SelectionCounter } from "@/components/selection-counter";
import { computeQuota, type QuotaResult } from "@/lib/quota";

export type ProofAsset = {
  id: string;
  originalFilename: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  proofUrl: string;
};

type SelectionResponse = {
  asset: { id: string; isSelected: boolean; selectedAt: string | null };
  quota: QuotaResult;
};

export function ProofGrid({
  initialAssets,
  packageName,
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
}: {
  initialAssets: ProofAsset[];
  // The gallery's own frozen commercial terms (schema.ts's
  // `includedPhotosSnapshot` / `extraPhotoPriceCopSnapshot`) — passed
  // through from the server component that renders this page
  // (src/app/galleries/[publicSlug]/page.tsx), never re-fetched from the
  // live `packages` row here. Only needed for the INITIAL paint's quota
  // (before any toggle has happened yet); every toggle after that replaces
  // the whole `quota` state with the server's own recomputation, which
  // already carries these same numbers back.
  packageName: string;
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
}) {
  const [urls, setUrls] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialAssets.map((asset) => [asset.id, asset.proofUrl])),
  );
  // A Set (not state) — which assets have already been refreshed doesn't
  // need to trigger a re-render on its own, only the `urls` update it
  // causes does.
  const refreshedAssetIds = useRef<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // `is_selected` per asset. Seeded from the initial server-rendered paint,
  // then only ever overwritten by a toggle response's own `asset.isSelected`
  // — never flipped locally before the round trip confirms it, so what this
  // renders can never drift from what the database actually holds.
  const [selectionById, setSelectionById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialAssets.map((asset) => [asset.id, asset.isSelected])),
  );
  const [quota, setQuota] = useState<QuotaResult>(() =>
    computeQuota(initialAssets.filter((asset) => asset.isSelected).length, {
      includedPhotosSnapshot,
      extraPhotoPriceCopSnapshot,
    }),
  );
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // The ACTUAL guard against a same-asset double toggle — `pendingIds`
  // (state, above) only disables the button visually and lags one render
  // behind; a second click issued before that render commits would not see
  // it. This ref is mutated synchronously and read at the very top of
  // `toggleSelection`, so the early return below is a real guard "by
  // design", not an incidental side effect of the UI being disabled.
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Monotonic counter, incremented once per toggle at ISSUE time (not at
  // response time) — this is what keeps the live counter honest when two
  // toggles land on DIFFERENT assets and their responses resolve OUT OF
  // ORDER (a normal occurrence on a phone connection, not an edge case):
  // toggling asset A, then asset B, with B's response arriving before A's,
  // must still leave the counter showing B's numbers (the LAST thing
  // actually issued), not A's (the last thing to ARRIVE) — otherwise the
  // client reads a stale, lower count as if it were current, right before
  // closing the tab and quoting the wrong surcharge over WhatsApp. Every
  // response's own sequence number is compared against the highest sequence
  // number applied so far; a response from an earlier-issued request that
  // arrives after a later one is applied is discarded rather than
  // overwriting the newer number. `selectionById` needs no equivalent guard:
  // `pendingIdsRef` already prevents two in-flight requests for the SAME
  // asset, so each asset's own key can only ever be written by its own
  // single in-flight request at a time.
  const quotaSequenceRef = useRef(0);
  const appliedQuotaSequenceRef = useRef(0);

  const toggleSelection = useCallback(async (assetId: string, nextSelected: boolean) => {
    if (pendingIdsRef.current.has(assetId)) return;
    pendingIdsRef.current.add(assetId);
    setPendingIds(new Set(pendingIdsRef.current));
    setToggleError(null);

    const sequence = ++quotaSequenceRef.current;
    try {
      const response = await fetch(`/api/assets/${assetId}/selection`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: nextSelected }),
      });
      if (!response.ok) {
        setToggleError("No se pudo actualizar la selección.");
        return;
      }
      const body = (await response.json()) as SelectionResponse;
      // The asset's own confirmed flag — no sequencing needed, see this
      // block's own comment above for why.
      setSelectionById((prev) => ({ ...prev, [body.asset.id]: body.asset.isSelected }));
      // The server's own recomputed quota — only applied if no LATER-issued
      // toggle's response has already been applied. See the header comment
      // on `quotaSequenceRef` above.
      if (sequence > appliedQuotaSequenceRef.current) {
        appliedQuotaSequenceRef.current = sequence;
        setQuota(body.quota);
      }
    } catch {
      setToggleError("No se pudo conectar.");
    } finally {
      pendingIdsRef.current.delete(assetId);
      setPendingIds(new Set(pendingIdsRef.current));
    }
  }, []);

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <SelectionCounter packageName={packageName} quota={quota} />
        {toggleError && <p className="text-xs text-[#e0796b]">{toggleError}</p>}
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {initialAssets.map((asset, index) => {
          const isSelected = selectionById[asset.id] ?? asset.isSelected;
          return (
            <ProofTile
              key={asset.id}
              asset={asset}
              src={urls[asset.id] ?? asset.proofUrl}
              isSelected={isSelected}
              isPending={pendingIds.has(asset.id)}
              onError={() => void refreshUrl(asset.id)}
              onOpen={() => setLightboxIndex(index)}
              onToggleSelection={() => void toggleSelection(asset.id, !isSelected)}
            />
          );
        })}
      </ul>

      {lightboxIndex !== null && (
        <ProofLightbox
          assets={initialAssets.map((asset) => ({
            ...asset,
            isSelected: selectionById[asset.id] ?? asset.isSelected,
          }))}
          urls={urls}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onImageError={(assetId) => void refreshUrl(assetId)}
          onToggleSelection={(assetId, nextSelected) => void toggleSelection(assetId, nextSelected)}
          pendingAssetIds={pendingIds}
        />
      )}
    </>
  );
}

function ProofTile({
  asset,
  src,
  isSelected,
  isPending,
  onError,
  onOpen,
  onToggleSelection,
}: {
  asset: ProofAsset;
  src: string;
  isSelected: boolean;
  isPending: boolean;
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
        disabled={isPending}
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
    </li>
  );
}
