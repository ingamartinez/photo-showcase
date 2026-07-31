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
              onDeleted={handleDeleted}
              onMoved={handleMoved}
              onFinalUploaded={handleFinalUploaded}
            />
          ))}
        </ul>
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
