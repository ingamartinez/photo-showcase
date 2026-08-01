"use client";

// The client's own view of a gallery's proofs (task #23): a responsive grid
// that reserves every tile's box up front (no cumulative layout shift while
// images load) plus a lightbox for full-screen browsing with keyboard/swipe
// navigation. Since task #145 that box is a UNIFORM 2:3 rather than each
// asset's own ratio — see proof-tile.tsx's own comment on it for what was
// measured at 390px and why the crop is the cheaper of the two costs.
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
//
// THREE STATES, THREE LAYOUTS (tasks #147/#148)
// ==============================================
// Before this pair of slices, `proofing`, `selected` and `delivered` all
// rendered the SAME tray + counter + grid + submit-panel arrangement, with
// only per-asset flags (`isLocked`, `showDownload`) changing what a given
// control looked like — epic #140's own words for this were "hoy son la
// misma pantalla con botones distintos". This file now renders three
// genuinely different bodies, gated on `isLocked` / `isDelivered`:
//
//   - `proofing` (`!isLocked`) — unchanged in substance: tray, instruction
//     line, grid, and <SelectionCounter>/<SubmitSelectionPanel> now sharing
//     one STICKY BOTTOM BAR (task #147's own "impossible to not see" — see
//     that bar's own comment below) instead of sitting in the normal
//     document flow where scrolling 84 photos could carry it off-screen.
//   - `selected` (`isLocked && !isDelivered`) — everything `proofing` shows
//     for review (tray, counter, the picked photos, the submit panel's own
//     "ya fue enviada" message) PLUS a new voice: `<SelectedStateNote>`
//     below, task #148's own acceptance criterion that this screen "explica
//     qué pasa ahora" instead of being read as a wall of disabled controls.
//     Deliberately ADDITIVE rather than a replacement of the existing view —
//     a client can still live here for days and wants to see exactly which
//     photos they are waiting on, not just be told to wait.
//   - `delivered` (`isDelivered`) — the tray, the live counter and the
//     submit panel are ALL retired here, not merely disabled: nothing about
//     the shared selection can change once delivered (`isLocked` is true
//     forever, `useSharedSelection`'s own `LIVE_SYNC_STATUSES` already
//     spends zero polls on it), and the submit panel's "tu fotógrafo ya
//     tiene acceso a esta selección" message is stale noise weeks or months
//     after the fact. In their place, `<DeliveredNote>` states what actually
//     matters now — the photos are unwatermarked (#89) and the ZIP is right
//     there — mirroring the mock's own `entregada` screen, which never shows
//     `.tray`/`.bar` either.
import { useCallback, useMemo, useState } from "react";
import { DownloadAllButton } from "@/components/download-all-button";
import { ProofLightbox } from "@/components/proof-lightbox";
import { ProofTile } from "@/components/proof-tile";
import { SelectionCounter } from "@/components/selection-counter";
import { SelectionTray } from "@/components/selection-tray";
import { SubmitSelectionPanel } from "@/components/submit-selection-panel";
import { useProofUrls } from "@/components/use-proof-urls";
import { useSharedSelection, type GalleryStatus } from "@/components/use-shared-selection";
import type { Gallery } from "@/lib/db/schema";
import type { QuotaResult } from "@/lib/quota";
import { pickerLabelFor, type SelectionPick } from "@/lib/selection-snapshot";

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
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
  originalPhotoPriceCopSnapshot,
  selectionTrayMode,
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
  //
  // Task #193 — there used to be a `packageName: string` prop right here,
  // threaded straight through to <SelectionCounter>. REMOVED, and not just
  // for overridden galleries: the owner's decision was that the package's
  // NAME must never reach a client's own view of ANY gallery, overridden or
  // not, because the ABSENCE of the name only in overridden galleries would
  // itself be the tell — a client with two galleries, or two clients who
  // talk, would learn "no name shown" means "you got a special deal" just as
  // easily as reading the name would. Removing it unconditionally is what
  // keeps every gallery's client view identical in this respect, regardless
  // of whether `termsOverridden` is true. The NUMBERS below still render —
  // this is about the package's label, not its terms.
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  // Task #206 — the gallery's frozen original-photo price, threaded the same
  // way its two siblings above are. REQUIRED, not optional: before this
  // slice, `useSharedSelection` hardcoded `0` here (see that file's own
  // former comment, and #205's "Hueco de cableado" note) because nothing
  // upstream of it carried the real value — the GraphQL `Gallery` type
  // didn't expose it and this prop didn't exist. Making it required is what
  // turns "the wiring gap is closed" into something the compiler checks
  // rather than a comment that could go stale.
  originalPhotoPriceCopSnapshot: number;
  // Task #204 — how <SelectionTray> lays out the SAME picks below: one flat
  // list (today's only behavior) or grouped one row per picker. Purely a
  // presentation choice the admin sets on the gallery itself
  // (src/app/dashboard/galleries/actions.ts's `updateSelectionTrayMode`);
  // this component makes no decision about it, only threads it through.
  selectionTrayMode: Gallery["selectionTrayMode"];
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
    setSelectionKind,
    handleSubmitted,
  } = useSharedSelection({
    galleryId,
    initialAssets,
    initialStatus,
    initialSubmittedAt,
    initialPicks,
    includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot,
  });

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Task #206 — every currently-selected asset's own type, looked up by id.
  // Built off `picks` (the shared selection's own list, which now carries
  // `selectionKind` per pick) rather than a second piece of state: an asset
  // NOT in this map is not currently selected, and the type control on both
  // the tile and the lightbox only ever renders for a selected asset anyway
  // (see <ProofTile>'s and <ProofLightbox>'s own comments — "a photo that
  // isn't picked has no type", the task's own words). `useMemo` only to avoid
  // rebuilding this on an unrelated re-render (a lightbox open/close, a
  // toggled `isStale`), matching <SelectionTray>'s own `groups` memo.
  const selectionKindById = useMemo(
    () => Object.fromEntries(picks.map((pick) => [pick.assetId, pick.selectionKind])),
    [picks],
  );

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
  // Task #29: <DeliveredNote>'s own download-all affordance only makes sense
  // once there is at least one final to actually zip — same per-asset
  // `hasFinal` truth `showDownload` below already relies on for the
  // individual buttons. Task #148 widened this from a boolean ("is there at
  // least one") to the actual count, for that note's own "N fotos" copy
  // (client.html:941's own "15 fotos editadas..."). The route re-derives its
  // own set from the database on every request regardless of what this
  // renders — this is a UI hint only, same disclaimer as `hasFinal`'s own.
  const finalAssetCount = isDelivered ? initialAssets.filter((asset) => asset.hasFinal).length : 0;

  return (
    <>
      {/* Task #148: the tray is a view of a selection that can still change
          (who has picked what, so far) — once `delivered`, PLAN.md §2's state
          machine has no path back out of it, so there is nothing left to
          watch for. Retired here rather than merely disabled, same reasoning
          <DeliveredNote> below explains for the counter and the submit
          panel. */}
      {!isDelivered && (
        <SelectionTray
          picks={picks}
          urls={urls}
          filenamesByAssetId={filenamesByAssetId}
          viewerId={viewerId}
          mode={selectionTrayMode}
          isLocked={isLocked}
          isStale={isStale}
          onOpenAsset={openAssetInLightbox}
          // The SAME `refreshUrl` the grid tiles and the lightbox use, sharing
          // the same `refreshedAssetIds` dedupe — see <SelectionTray>'s own
          // `onImageError` comment for why the tray needs it MORE than they do.
          onImageError={(assetId) => void refreshUrl(assetId)}
        />
      )}

      {isDelivered && <DeliveredNote galleryId={galleryId} finalAssetCount={finalAssetCount} />}

      {/* Task #148: `selected` gets its own voice instead of reading as a
          wall of disabled controls — <SelectionCounter> stays visible here
          (still true, still useful context while the client waits) but
          without the sticky bottom bar or the submit button, since there is
          nothing left to act on. */}
      {!isDelivered && isLocked && (
        <div className="mb-4">
          <SelectionCounter quota={quota} />
        </div>
      )}

      {!isDelivered && isLocked && (
        <SelectedStateNote
          quota={quota}
          picks={picks}
          viewerId={viewerId}
          submittedAt={submittedAt}
        />
      )}

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
          thumbnail big enough to decide on without opening it.

          `pb-32` only while the sticky bottom bar (below) is actually
          mounted — `selected` and `delivered` render no bar, so nothing
          needs clearing under the last row there. */}
      <ul
        className={`grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4 lg:gap-[3px] ${
          !isLocked ? "pb-32" : ""
        }`}
      >
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
              // Task #206 — only meaningful while `isSelected` (the tile
              // itself gates rendering the control on that), so an unselected
              // asset's `"edited"` fallback here is never actually shown.
              selectionKind={selectionKindById[asset.id] ?? "edited"}
              onSetSelectionKind={(kind) => void setSelectionKind(asset.id, kind)}
            />
          );
        })}
      </ul>

      {/* Task #147's own hardest problem, restated: the surcharge has to be
          impossible to not see BEFORE the client submits, on the phone,
          without scrolling back up — the whole reason <SelectionCounter> and
          <SubmitSelectionPanel> now share ONE bar fixed to the bottom of the
          viewport (design/system/client.html's own `.bar`, `position: fixed;
          inset: auto 0 0 0`) instead of sitting in the normal document flow
          above the grid, where 84 photos of scrolling could carry them both
          off-screen. Only while the selection can still be acted on
          (`!isLocked`) — `selected` and `delivered` render no bar at all,
          matching the mock's own `enviada`/`entregada` screens.

          `z-40`: above the tray's sticky `z-30` (selection-tray.tsx), below
          the lightbox's `z-50` (proof-lightbox.tsx) — the lightbox must
          always be able to cover this, this must always be able to cover the
          tray scrolling underneath it.

          DECLARED DEVIATION FROM THE MOCK: kept `fixed` at every breakpoint
          rather than switching to `position: sticky` at the mock's own
          1024px rule (client.html:562-566, "en una pantalla alta nada está
          fuera de alcance"). A fixed bar stays perfectly usable at the desk —
          it just does not fold back into the document flow there. Revisit if
          the owner finds it visually heavy on a large screen; nothing about
          the phone experience, the actual acceptance criterion, depends on
          it. */}
      {!isDelivered && !isLocked && (
        <div className="border-line-2 bg-bg/95 fixed inset-x-0 bottom-0 z-40 border-t px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] backdrop-blur-md min-[620px]:px-7 lg:px-12">
          <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3">
            <SelectionCounter quota={quota} />
            <div className="flex items-center gap-3">
              {toggleError && <p className="text-xs text-[#e0796b]">{toggleError}</p>}
              <SubmitSelectionPanel
                galleryId={galleryId}
                quota={quota}
                isLocked={isLocked}
                submittedAt={submittedAt}
                onSubmitted={handleSubmitted}
              />
            </div>
          </div>
        </div>
      )}

      {/* `selected`'s own submit panel — still rendered (its locked branch is
          the "ya fue enviada, tu fotógrafo ya tiene acceso" message, task
          #25's own acceptance criterion), just in the normal document flow
          rather than the fixed bar above, since there is no button left to
          keep in reach. Not rendered at all once `delivered`: see
          <DeliveredNote>'s own comment for why that message goes stale. */}
      {!isDelivered && isLocked && (
        <div className="mt-6 flex justify-end">
          <SubmitSelectionPanel
            galleryId={galleryId}
            quota={quota}
            isLocked={isLocked}
            submittedAt={submittedAt}
            onSubmitted={handleSubmitted}
          />
        </div>
      )}

      {lightboxIndex !== null && (
        <ProofLightbox
          assets={initialAssets.map((asset) => ({
            ...asset,
            isSelected: selectionById[asset.id] ?? asset.isSelected,
          }))}
          urls={urls}
          index={lightboxIndex}
          // Task #146: the same server-recomputed quota <SelectionCounter>
          // above renders, so the full-screen view can say how many are
          // chosen without the client closing it to find out. Passed whole
          // rather than as a count, because the lightbox shows the included
          // number beside it and neither value is derived twice.
          quota={quota}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onImageError={(assetId) => void refreshUrl(assetId)}
          onToggleSelection={(assetId, nextSelected) => void toggleSelection(assetId, nextSelected)}
          pendingAssetIds={pendingIds}
          isLocked={isLocked}
          isDelivered={isDelivered}
          selectionKindById={selectionKindById}
          onSetSelectionKind={(assetId, kind) => void setSelectionKind(assetId, kind)}
        />
      )}
    </>
  );
}

// Task #148 — `selected`'s own voice: "qué eligió, qué pasa ahora... y qué
// hacer si se equivocó" (that task's own body), mirroring
// design/system/client.html's `enviada` screen (:898-931) in CONTENT rather
// than its exact markup (that screen is a whole separate page in the mock;
// here it is a block inside the same one, additive to the tray/counter/grid
// this component already renders for a locked gallery — see the "THREE
// STATES" section of this file's own header comment for why additive was
// chosen over replacing the existing view).
//
// No invented turnaround time. The mock's own copy promises "entre una y
// dos semanas" — a number this app has no column for (`packages` carries a
// SESSION `durationLabel`, not an editing SLA) and inventing one here would
// be exactly the kind of claim this component cannot back up, the same
// standard <SubmitSelectionPanel>'s own header comment already holds itself
// to for "has access" vs. "was notified". This says only what is true:
// editing is in progress, the client is told by email when it's done.
function SelectedStateNote({
  quota,
  picks,
  viewerId,
  submittedAt,
}: {
  quota: QuotaResult;
  picks: SelectionPick[];
  /** Same prop <SelectionTray> already takes — the viewer's own picks read
   * "Vos" in the per-picker recap below too, for the same reason. */
  viewerId: string;
  submittedAt: string | null;
}) {
  // Per-picker tally (task #94's shared gallery, not per-client): "Vos 9 ·
  // Beto 4 · Sara 2" (client.html:726, :848-850), computed off the SAME
  // `picks` list <SelectionTray> renders — never a second count of anything,
  // matching this whole file's own "quota is derived once, never twice"
  // stance for the numeric quota above it.
  const perPicker = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const pick of picks) {
      const key = pick.pickedBy?.id ?? "unattributed";
      const label = pickerLabelFor(pick.pickedBy, viewerId);
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { label, count: 1 });
    }
    return [...counts.values()];
  }, [picks, viewerId]);

  return (
    <div className="border-line-2 mt-2 mb-6 rounded-sm border p-[18px]">
      <h2 className="font-serif text-lg">¿Qué pasa ahora?</h2>
      <p className="text-fg-dim mt-2 text-sm">
        Tu fotógrafo ya tiene la selección
        {submittedAt
          ? ` — la enviaste el ${new Date(submittedAt).toLocaleDateString("es-CO")}`
          : ""}{" "}
        y está editando {quota.selected} foto{quota.selected === 1 ? "" : "s"} en alta resolución y
        sin marca de agua. Te avisamos por correo apenas estén.
      </p>
      <p className="text-fg-dim mt-2 text-sm">
        ¿Te arrepentiste de alguna? La selección quedó cerrada, pero escribile a tu fotógrafo y él
        la reabre.
      </p>
      {/* Only worth a breakdown once more than one person actually picked
          something — a solo client seeing "Vos: 15" would just be the same
          number repeated with no new information. */}
      {perPicker.length > 1 && (
        <dl className="mt-4 grid gap-2 text-sm">
          {perPicker.map(({ label, count }) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-fg-mute">{label}</dt>
              <dd className="tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// Task #148 — `delivered`'s own header, replacing the tray/counter/submit
// row this component retires once nothing about the selection can change
// anymore (see the "THREE STATES" section above). Mirrors the mock's own
// `entregada` copy (client.html:941: "15 fotos editadas, en alta resolución
// y sin marca de agua") rather than its full-bleed hero treatment
// (client.html:452-460) — DECLARED DEVIATION: a hero needs a chosen hero
// image, a scrim, and a decision about which component owns the gallery
// TITLE once it moves inside that hero (today `src/app/galleries/
// [publicSlug]/page.tsx` owns it, unconditionally, for all three statuses).
// That is a real design question, not a shortcut taken to save time, and
// answering it by fiat inside this slice risked exactly the kind of
// undiscussed cross-file ownership change this epic's own review has flagged
// before. Left for the owner to weigh in on; nothing about the stated
// acceptance criteria (the three states distinguish immediately, no
// watermark, both downloads work, the ZIP shows it takes a while) depends on
// the hero specifically.
function DeliveredNote({
  galleryId,
  finalAssetCount,
}: {
  galleryId: string;
  finalAssetCount: number;
}) {
  return (
    <div className="mb-6">
      <p className="text-fg-dim text-sm">
        {finalAssetCount} foto{finalAssetCount === 1 ? "" : "s"} editada
        {finalAssetCount === 1 ? "" : "s"}, en alta resolución y sin marca de agua — esto es lo que
        vas a volver a ver cuando quieras.
      </p>
      {finalAssetCount > 0 && (
        <div className="mt-3">
          <DownloadAllButton galleryId={galleryId} assetCount={finalAssetCount} />
        </div>
      )}
    </div>
  );
}
