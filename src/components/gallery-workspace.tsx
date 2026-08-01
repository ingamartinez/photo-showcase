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
//
// TASK #195 — THE MARKED SET LIVES HERE, ABOVE THE GRID AND THE VIEWER
// ========================================================================
// The owner's own requirement: "sin que abrir una en grande le pierda lo que
// ya marcó". <GalleryWorkspace> is already the single owner of `assets`
// (this same header, above) — the bulk-op `markedIds` set belongs at the
// exact same level, for the exact same reason: it is the one component that
// sits ABOVE both <AssetTile> (the grid) and <AdminAssetViewer> (the
// full-screen viewer), so neither surface can lose it by unmounting. If this
// set lived inside a tile, it would die with that tile on every re-render of
// the list; if it lived inside the viewer, closing the viewer would forget
// it. Putting it here is not an added feature on top of "don't lose the
// mark on open" — it IS how that requirement is satisfied, structurally,
// the same way `pendingFinalsCount`'s own bug (task #86, see this file's own
// comment below) was fixed by moving the ONE live value up here instead of
// letting a sibling read a stale snapshot.
//
// NAMING — NOT `selected`/`selection`, ANYWHERE IN THIS FEATURE
// ================================================================
// This codebase's `isSelected`/`selected` already names a DIFFERENT,
// pre-existing fact: the CLIENT's own pick during proofing (PLAN.md §2,
// `assets.isSelected`, `computeQuota`), which `asset-tile.tsx` already
// renders as an "Elegida" badge. The photographer's bulk-delete mark added
// here is a SEPARATE, ephemeral, UI-only concept — it carries no money, no
// quota, and does not survive a reload — so it gets its own name throughout:
// `markedIds` (a `Set<string>` of asset ids), never `selectedIds`. A reader
// skimming this file for "selection" state must find exactly the client's
// fact and nothing else; a same-named UI concern sitting right next to it
// would be the kind of collision that gets a photographer bulk-deleting
// photos they believe are still just the client's picks. See
// asset-tile.tsx's own header for the other half of this same guard (the
// "Elegida" badge vs. the marking checkbox's own distinct styling).
import { useCallback, useMemo, useState } from "react";
import { AdminAssetViewer } from "@/components/admin-asset-viewer";
import { AssetTile } from "@/components/asset-tile";
import { ProofUploader } from "@/components/proof-uploader";
import { DeliverGalleryButton } from "@/components/deliver-gallery-button";

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
  clientEmails,
  canDeliver,
}: {
  galleryId: string;
  initialAssets: WorkspaceAsset[];
  // Every client's email (task #94 — a gallery can have several now),
  // needed only to render <DeliverGalleryButton>'s own confirmation copy —
  // see that component's own prop comment.
  clientEmails: string[];
  // Task #86 fix: whether the gallery's OWN status is currently "selected"
  // (computed server-side — see src/app/dashboard/galleries/[galleryId]/page.tsx).
  // Hiding the button outside "selected" is UX only, same "hiding is not the
  // authority" stance as everywhere else on this page — `deliverGallery`
  // itself re-checks the status.
  //
  // Why this one is safe as a prop while `pendingFinalsCount` was NOT: this is
  // a plain prop, never seeded into `useState`, so it re-evaluates whenever the
  // server re-renders this route. `unlockSelection` — the one control on this
  // page that moves a gallery OUT of "selected" — is a Server Action calling
  // `revalidatePath`, and Next returns fresh Flight data for the whole route
  // and merges it client-side. No full browser navigation is involved, and none
  // is needed: `canDeliver` flips to `false` and the button disappears.
  // `pendingFinalsCount` broke precisely because it could NOT do that — uploads
  // mutate local state only, with no server round trip to re-render against.
  canDeliver: boolean;
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
  //
  // Task #86 fix: this is now the ONLY place `pendingFinalsCount` is
  // computed on this page. <DeliverGalleryButton> below reads THIS value
  // directly, rather than a second copy computed once, server-side, at page
  // render (`src/app/dashboard/galleries/[galleryId]/page.tsx` used to do
  // that) — the bug this fixed was exactly two counters over the same fact,
  // disagreeing because only one of them updated after an upload. There is
  // only one now.
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

  // Task #195: the bulk-op mark — see this file's own header comment for why
  // it lives here and not inside a tile or the viewer, and why it is never
  // named `selected`.
  const [markedIds, setMarkedIds] = useState<Set<string>>(() => new Set());

  const handleToggleMarked = useCallback((assetId: string) => {
    setMarkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
  }, []);

  // The full-screen viewer's open asset, tracked by ID rather than by index
  // into `sorted`. An index would go stale the instant a bulk delete (or any
  // future reorder) shifts what sits at that position; resolving the index
  // fresh from `sorted` on every render — see `viewerIndex` below — means
  // the viewer always shows exactly the asset it claims to, or closes itself
  // outright when that asset no longer exists (see `handleBulkDeleted`).
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);
  const viewerIndex = useMemo(
    () => (viewerAssetId ? sorted.findIndex((asset) => asset.id === viewerAssetId) : -1),
    [sorted, viewerAssetId],
  );

  const handleOpenViewer = useCallback((assetId: string) => {
    setViewerAssetId(assetId);
  }, []);
  const handleCloseViewer = useCallback(() => {
    setViewerAssetId(null);
  }, []);
  const handleNavigateViewer = useCallback(
    (nextIndex: number) => {
      setViewerAssetId(sorted[nextIndex]?.id ?? null);
    },
    [sorted],
  );

  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);

  // Task #195: one request for the whole marked set — see
  // src/app/api/assets/bulk-delete/route.ts's own header for why this is a
  // dedicated endpoint rather than N calls to the single-asset DELETE route.
  //
  // RECONCILED AGAINST THE SERVER'S OWN ANSWER, NOT ASSUMED OPTIMISTICALLY:
  // this only ever removes ids the response actually reports `deleted`, and
  // only ever clears the mark for THOSE ids — an id the gate refused (still
  // `gallery_locked`, say) stays both in `assets` and in `markedIds`, exactly
  // as if the photographer had never clicked anything for it. An optimistic
  // "clear everything marked, then reconcile" would briefly show the grid
  // lying about what the server actually did.
  const handleBulkDelete = useCallback(async () => {
    if (bulkDeleteBusy || markedIds.size === 0) return;
    const assetIds = [...markedIds];
    if (
      !window.confirm(
        `¿Eliminar ${assetIds.length} foto${assetIds.length === 1 ? "" : "s"} marcada${assetIds.length === 1 ? "" : "s"}? Esta acción no se puede deshacer.`,
      )
    ) {
      return;
    }
    setBulkDeleteBusy(true);
    setBulkDeleteError(null);
    try {
      const response = await fetch("/api/assets/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds }),
      });
      if (!response.ok) {
        setBulkDeleteError("No se pudo eliminar.");
        return;
      }
      const body = (await response.json()) as {
        deleted: string[];
        failed: { id: string; error: string }[];
      };
      const deletedSet = new Set(body.deleted);
      setAssets((prev) => prev.filter((asset) => !deletedSet.has(asset.id)));
      setMarkedIds((prev) => {
        const next = new Set(prev);
        for (const id of body.deleted) next.delete(id);
        return next;
      });
      // The viewer was showing an asset that just got deleted out from under
      // it — close it rather than leave it pointing at nothing (`asset` in
      // <AdminAssetViewer> would be `undefined` for an out-of-range index,
      // which it already treats as "render nothing", but closing is the
      // honest state here, not a silent blank screen).
      if (viewerAssetId && deletedSet.has(viewerAssetId)) {
        setViewerAssetId(null);
      }
      if (body.failed.length > 0) {
        setBulkDeleteError(
          `No se ${body.failed.length === 1 ? "pudo eliminar 1 foto" : `pudieron eliminar ${body.failed.length} fotos`}.`,
        );
      }
    } catch {
      setBulkDeleteError("No se pudo conectar.");
    } finally {
      setBulkDeleteBusy(false);
    }
  }, [bulkDeleteBusy, markedIds, viewerAssetId]);

  return (
    <div className="flex flex-col gap-6">
      <ProofUploader galleryId={galleryId} onUploaded={handleUploaded} />

      {/* Task #134: density. The grid starts at the mock's `minmax(92px,1fr)`
          (3-4 columns on a phone) and GROWS to `minmax(122px,1fr)` on the
          desk — epic #125's own rule that a volume surface grows when it has
          room, rather than being cropped when it doesn't
          (design/system/dashboard.html:426-429, :603). */}
      {sorted.length === 0 ? (
        <p className="text-fg-dim text-[15px] leading-relaxed">
          Todavía no subiste fotos de esta sesión — usá el selector de arriba.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5 sm:gap-2 lg:grid-cols-[repeat(auto-fill,minmax(122px,1fr))]">
          {sorted.map((asset, index) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              isFirst={index === 0}
              isLast={index === sorted.length - 1}
              isMarked={markedIds.has(asset.id)}
              onDeleted={handleDeleted}
              onMoved={handleMoved}
              onFinalUploaded={handleFinalUploaded}
              onOpen={() => handleOpenViewer(asset.id)}
              onToggleMarked={handleToggleMarked}
            />
          ))}
        </ul>
      )}

      {/* Task #195: the bulk-delete bar, only present once at least one
          photo is marked — no reason to occupy space in the common case
          (nothing marked). Placement mirrors the sticky "Entregar galería"
          bar right below it (task #133's own reasoning: reachable one-handed
          after scrolling past a long grid), but this is a SEPARATE bar, not
          folded into that one — the two are unrelated actions gated on
          unrelated state (`markedIds` here vs. `canDeliver`/`selectedCount`
          there), and conflating them would make either one harder to reason
          about in isolation. */}
      {markedIds.size > 0 && (
        <div className="bg-bg/90 sticky bottom-[calc(var(--app-tabbar-h)+8px)] z-20 flex flex-wrap items-center justify-between gap-4 rounded-[6px] border border-[#e0796b]/60 p-3 backdrop-blur-sm lg:static lg:bg-transparent lg:backdrop-blur-none">
          <p className="text-fg-dim text-sm">
            {markedIds.size} foto{markedIds.size === 1 ? "" : "s"} marcada
            {markedIds.size === 1 ? "" : "s"} para borrar.
          </p>
          <div className="flex items-center gap-3">
            {bulkDeleteError && (
              <p className="text-xs text-[#e0796b]" role="alert">
                {bulkDeleteError}
              </p>
            )}
            {/* `#e0796b` directly, not the `app-danger` Tailwind utility —
                see asset-tile.tsx's own comment on this same choice: that
                utility only paints under `[data-surface="app"]`, and this
                file's name doesn't qualify for eslint.config.mjs's
                `no-restricted-syntax` exemption even though it only ever
                renders inside the dashboard. */}
            <button
              type="button"
              disabled={bulkDeleteBusy}
              onClick={() => void handleBulkDelete()}
              className="min-h-9 rounded-[4px] border border-[#e0796b] px-3 text-xs font-semibold tracking-[0.04em] text-[#e0796b] uppercase transition-colors hover:bg-[#e0796b] hover:text-[#1a0d0a] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkDeleteBusy
                ? "Eliminando…"
                : `Eliminar ${markedIds.size} marcada${markedIds.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {/* Task #195: mounted only while an asset is actually being viewed —
          `viewerIndex` resolves fresh from `sorted` on every render (see its
          own comment above), so this naturally stops rendering the instant
          the asset it was showing no longer exists, with no separate
          "close because deleted" branch to keep in sync. `markedIds`/
          `handleToggleMarked` are the SAME instances the grid above uses —
          this is the "state lives above both surfaces" requirement made
          concrete: there is exactly one Set, read and written from either
          place. */}
      {viewerIndex !== -1 && (
        <AdminAssetViewer
          assets={sorted}
          index={viewerIndex}
          markedIds={markedIds}
          onToggleMarked={handleToggleMarked}
          onClose={handleCloseViewer}
          onNavigate={handleNavigateViewer}
        />
      )}

      {/* Task #133's mobile-first note, LA decisión de esta pantalla: after
          scrolling past 84 thumbnails, "Entregar galería" still has to be
          reachable — `position: sticky` just above the bottom tab bar
          (`--app-tabbar-h`, set by <DashboardNav>) on a phone, and back to a
          normal static block once the desk has no scroll problem to solve
          (design/system/dashboard.html:401-412, :592-598).

          SOURCE ORDER, ON PURPOSE: this renders AFTER the asset grid above,
          not before it — sticky positioning is a paint-time effect, it does
          not move where this sits in the DOM/reading/tab order.

          Task #86's own fix stays intact: <DeliverGalleryButton> is not a
          sibling fed a server snapshot, it reads `pendingFinalsCount`
          straight off this component's own live state, one render below. */}
      {(selectedCount > 0 || canDeliver) && (
        <div className="bg-bg/90 border-line-2 sticky bottom-[calc(var(--app-tabbar-h)+8px)] z-20 flex flex-wrap items-center justify-between gap-4 rounded-[6px] border p-3 backdrop-blur-sm lg:static lg:border-none lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
          {selectedCount > 0 && (
            <p className="text-fg-dim text-sm">
              {pendingFinalsCount > 0
                ? `Faltan ${pendingFinalsCount} de ${selectedCount} finales por subir.`
                : `Los ${selectedCount} finales de la selección ya están subidos.`}
            </p>
          )}

          {/* Task #27: guarded server-side by deliverGallery() itself
              (selected-only, no missing finals) — hiding the button once the
              gallery has moved past "selected" is UX, not the authority; see
              src/app/dashboard/galleries/actions.ts's isDeliverable(). Task
              #86 fix: rendered HERE, reading `pendingFinalsCount` straight
              off this component's own live state, rather than as a sibling
              fed a server-rendered snapshot that never updated after an
              upload. */}
          {canDeliver && (
            <DeliverGalleryButton
              galleryId={galleryId}
              clientEmails={clientEmails}
              pendingFinalsCount={pendingFinalsCount}
            />
          )}
        </div>
      )}
    </div>
  );
}
