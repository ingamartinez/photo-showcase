"use client";

// The client's own view of a gallery's proofs (task #23): a responsive grid
// that reserves each tile's exact aspect ratio up front (no cumulative
// layout shift while images load) plus a lightbox for full-screen browsing
// with keyboard/swipe navigation.
//
// WHAT LIVES WHERE (task #144)
// ============================
// This file used to be 1045 lines carrying five separate concerns at once,
// which made any redesign of the MARKUP arrive in the same diff as the live
// synchronisation logic — the hardest part of this product to review. Task
// #144 split it, moving each block of reasoning with the code it describes
// rather than summarising anything:
//
//   - `use-proof-urls.ts` — the URL-EXPIRY STRATEGY (why a presigned proof URL
//     goes stale mid-session, and the one-shot per-asset re-sign that heals it
//     in place without losing the client's scroll position).
//   - `use-shared-selection.ts` — selection, the live quota counter (#24), the
//     "LIVE SYNC" section (#95: the conflict rule and the submit lock) and the
//     "PUSH TRANSPORT" section (#114: the SSE wiring and what "issue clock"
//     means for a pushed event). Cross-references elsewhere in the repo
//     (PLAN.md §2, src/lib/selection-events.ts, the selection route) that name
//     "proof-grid.tsx's LIVE SYNC / PUSH TRANSPORT sections" mean that file
//     now — the text moved whole.
//   - `proof-tile.tsx` — one tile's markup, including the aspect-ratio
//     reservation and the #25 lock on its toggle button.
//
// What stays HERE is composition: the props the server component hands down,
// the two facts derived from `initialStatus` (#28/#29's download affordances),
// the lightbox index, and the layout that arranges tray, counter, grid and
// submit panel. That is deliberately the part a redesign touches.
import { useCallback, useMemo, useState } from "react";
import { DownloadAllButton } from "@/components/download-all-button";
import { ProofLightbox } from "@/components/proof-lightbox";
import { ProofTile } from "@/components/proof-tile";
import { SelectionCounter } from "@/components/selection-counter";
import { SelectionTray } from "@/components/selection-tray";
import { SubmitSelectionPanel } from "@/components/submit-selection-panel";
import { useProofUrls } from "@/components/use-proof-urls";
import { useSharedSelection, type GalleryStatus } from "@/components/use-shared-selection";
import type { SelectionPick } from "@/lib/selection-snapshot";

// Re-exported, not re-declared: `GalleryStatus` and the fallback poll's
// cadence belong next to the status machine and the loop they pace
// (use-shared-selection.ts), but `@/components/proof-grid` is the import path
// every caller and proof-grid.test.tsx already had. Task #144 was not allowed
// to change a single test, so the path stays exactly where it was.
export type { GalleryStatus };
export { SELECTION_POLL_INTERVAL_MS } from "@/components/use-shared-selection";

export type ProofAsset = {
  id: string;
  originalFilename: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  proofUrl: string;
  // Whether this asset's final is actually downloadable (task #28): selected
  // AND edited AND a final object exists — the SAME three-condition gate
  // `GET /api/assets/[assetId]/final` itself enforces (see that route's own
  // comment), computed server-side by the page that renders this component
  // (src/app/galleries/[publicSlug]/page.tsx) and handed down as a plain
  // boolean. Deliberately NOT the raw `finalKey` — same "the raw R2 key must
  // never reach the browser" discipline `WorkspaceAsset.hasFinal` already
  // follows in src/components/gallery-workspace.tsx. This is a UI hint ONLY:
  // the route re-checks all three conditions itself on every request, so a
  // stale or wrong value here can make the download button render when it
  // shouldn't (or not render when it should) but can never actually unlock a
  // final this session doesn't own or that isn't really ready.
  hasFinal: boolean;
  // Task #89: the presigned URL of this asset's UNWATERMARKED, browsing-sized
  // derivative, or `null` when this asset isn't showing one — either because
  // the gallery isn't delivered yet, or because this particular photo was
  // never selected/edited and therefore has no final to derive from. A
  // delivered gallery containing both kinds at once is the normal case, which
  // is why this is per-asset rather than one flag on the gallery.
  //
  // When present it REPLACES `proofUrl` as what the grid and the lightbox
  // display (see `useProofUrls`' seeded map) — the client paid, so the
  // watermark should be gone from what they look at, not only from what they
  // download. `proofUrl` is still carried on every asset regardless, as the
  // fallback that hook's `refreshUrl` drops back to if the display object
  // turns out not to exist.
  //
  // Same "UI hint, never the gate" disclaimer as `hasFinal` above: the bytes
  // behind this URL are private R2 objects, and the page that presigned it
  // (src/app/galleries/[publicSlug]/page.tsx) had already verified this
  // session owns the gallery. A wrong value here cannot unlock anything; it
  // can only make this component request a URL that 404s.
  displayUrl: string | null;
};

export function ProofGrid({
  galleryId,
  initialAssets,
  initialStatus,
  initialSubmittedAt,
  initialPicks,
  viewerId,
  packageName,
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
}: {
  // Task #25's submit route is keyed on this — see that route's own header
  // comment for why the internal id, not the page's `publicSlug`, is the
  // right identifier for a same-origin `fetch()` call.
  galleryId: string;
  initialAssets: ProofAsset[];
  initialStatus: GalleryStatus;
  initialSubmittedAt: string | null;
  // Task #95: the shared, attributed selection as of the server render, built
  // by the SAME `getGallerySelection()` the live route calls — see that
  // module's header comment for why one function feeds both. Only the FIRST
  // paint comes from here; every refresh afterwards replaces it wholesale
  // with a fresh snapshot.
  initialPicks: SelectionPick[];
  // The signed-in user's own id, so the tray can render their own picks as
  // "Vos" rather than their own name (see `pickerLabelFor`). Nothing is
  // authorized by this value — it is a display detail; every route this
  // component calls resolves the acting session server-side and would refuse
  // a request regardless of what is passed here.
  viewerId: string;
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
  // One map of presigned URLs, shared by the tray, every grid tile and the
  // lightbox — see use-proof-urls.ts's own header comment for why it is one
  // map and not one per surface.
  const { urls, refreshUrl } = useProofUrls(initialAssets);

  // Everything the gallery's shared selection consists of: this session's
  // toggles, other sessions' picks arriving live, the server-recomputed quota
  // and the submit lock. See use-shared-selection.ts.
  const {
    selectionById,
    quota,
    picks,
    isLocked,
    submittedAt,
    pendingIds,
    toggleError,
    isStale,
    toggleSelection,
    handleSubmitted,
  } = useSharedSelection({
    galleryId,
    initialAssets,
    initialStatus,
    initialSubmittedAt,
    initialPicks,
    includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot,
  });

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Task #95: the tray's accessible labels, and nothing else. Frozen off the
  // server-rendered props on purpose — a snapshot can name an asset this page
  // never rendered, and <SelectionTray> handles that explicitly rather than
  // this map pretending to know a filename it was never given.
  const filenamesByAssetId = useMemo(
    () =>
      Object.fromEntries(
        initialAssets.map((asset) => [asset.id, asset.originalFilename]),
      ) as Record<string, string>,
    [initialAssets],
  );

  const openAssetInLightbox = useCallback(
    (assetId: string) => {
      const index = initialAssets.findIndex((asset) => asset.id === assetId);
      // -1 for a pick whose asset this page never rendered — nothing to open,
      // and opening the lightbox at index -1 would blank it.
      if (index >= 0) setLightboxIndex(index);
    },
    [initialAssets],
  );

  if (initialAssets.length === 0) {
    return (
      <p className="text-fg-dim text-[15px] leading-relaxed">
        Tu fotógrafo todavía no subió fotos para esta galería.
      </p>
    );
  }

  // Task #28: a gallery only ever reaches `delivered` once (PLAN.md §2's
  // state machine has no path back out of it toward the client-visible
  // statuses), so — unlike the live `status`/`isLocked` the hook above tracks
  // — this never needs to flip after mount; `initialStatus` alone is enough
  // for this component's whole lifetime.
  //
  // Deliberately read off `initialStatus`, NOT the live `status`, even though
  // one now exists (task #95): the download affordances depend on per-asset
  // facts the SERVER computed at render time (`hasFinal`, `displayUrl`),
  // which a live status change cannot bring with it. A gallery that becomes
  // `delivered` while a client watches would otherwise sprout download
  // buttons for assets this page knows nothing about. It stays read-only
  // until the client loads the page again, which is when those facts arrive.
  // Whether a GIVEN asset's download button actually renders is
  // still per-asset (`asset.hasFinal` below): a delivered gallery can easily
  // contain unselected assets that were never edited and have no final at
  // all.
  const isDelivered = initialStatus === "delivered";
  // Task #29: the button only makes sense once there is at least one final
  // to actually zip — same per-asset `hasFinal` truth `showDownload` below
  // already relies on for the individual buttons, just reduced to "is there
  // at least one". The route re-derives this exact set itself from the
  // database on every request (see its own comment); this is a UI hint only,
  // same disclaimer as `hasFinal`'s own.
  const hasAnyFinal = isDelivered && initialAssets.some((asset) => asset.hasFinal);

  return (
    <>
      {/* Task #95 — the owner's request, literally: the chosen photos live in
          a list at the TOP of the page, in the same thumbnail style as the
          grid, saying who chose each one. Rendered above the counter and the
          grid, always, including before anybody has picked anything: see
          <SelectionTray>'s own header comment for why it does not appear on
          first pick. */}
      <SelectionTray
        picks={picks}
        urls={urls}
        filenamesByAssetId={filenamesByAssetId}
        viewerId={viewerId}
        isLocked={isLocked}
        isStale={isStale}
        onOpenAsset={openAssetInLightbox}
        // The SAME `refreshUrl` the grid tiles and the lightbox use, sharing
        // the same `refreshedAssetIds` dedupe — see <SelectionTray>'s own
        // `onImageError` comment for why the tray needs it MORE than they do.
        onImageError={(assetId) => void refreshUrl(assetId)}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <SelectionCounter packageName={packageName} quota={quota} />
        <div className="flex items-center gap-3">
          {toggleError && <p className="text-xs text-[#e0796b]">{toggleError}</p>}
          {hasAnyFinal && <DownloadAllButton galleryId={galleryId} />}
        </div>
      </div>

      {/* Task #145 — the one instruction the redesigned tile needs, and the
          mock's own words for it (design/system/client.html:714). The pick
          control became an empty 48px circle with no label in it, so the
          screen has to say once what it does; without this line the only
          affordance is a bare ring. Hidden once `isLocked`, because there is
          then no circle to press and the sentence would be a lie.

          Lives here rather than in the page's header block
          (src/app/galleries/[publicSlug]/page.tsx), where the mock puts its
          `.lede`: that header renders for `selected` and `delivered` too, and
          only this component knows whether the selection is still open. */}
      {!isLocked && (
        <p className="text-fg-dim mb-3 text-sm">
          Tocá una foto para verla grande. El círculo la elige.
        </p>
      )}

      {/* client.html:180 (`repeat(2, 1fr)`, `gap: 2px`), :532 (three columns
          from 620px — Tailwind's `sm` is 640px, the nearest stop in the
          project's own scale, and no slice in this epic gets to invent a
          breakpoint) and :556 (four columns and a 3px gap at the desk).
          The near-zero gutter is the point rather than a detail: it buys the
          phone's two columns their width back, which is what makes a
          thumbnail big enough to decide on without opening it. */}
      <ul className="grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4 lg:gap-[3px]">
        {initialAssets.map((asset, index) => {
          const isSelected = selectionById[asset.id] ?? asset.isSelected;
          return (
            <ProofTile
              key={asset.id}
              asset={asset}
              position={index + 1}
              src={urls[asset.id] ?? asset.proofUrl}
              isSelected={isSelected}
              isPending={pendingIds.has(asset.id)}
              isLocked={isLocked}
              showDownload={isDelivered && asset.hasFinal}
              onError={() => void refreshUrl(asset.id)}
              onOpen={() => setLightboxIndex(index)}
              onToggleSelection={() => void toggleSelection(asset.id, !isSelected)}
            />
          );
        })}
      </ul>

      <div className="mt-6 flex justify-end">
        <SubmitSelectionPanel
          galleryId={galleryId}
          quota={quota}
          isLocked={isLocked}
          submittedAt={submittedAt}
          onSubmitted={handleSubmitted}
        />
      </div>

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
          isLocked={isLocked}
          isDelivered={isDelivered}
        />
      )}
    </>
  );
}
