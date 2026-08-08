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
//
// TASK #199 — ONE ENDPOINT, TWO CLIENT-SIDE ACTIONS, SAME RECONCILIATION
// ========================================================================
// `assets.sortOrder` is still the single source of truth for the grid's
// order (PLAN.md), and this component is still the ONE place that owns it
// locally (this file's own header, above). Drag-and-drop (`handleDragEnd`)
// and the "Ordenar por nombre de archivo" button (`handleSortAlphabetically`)
// both compute a full, ordered id list and hand it to the SAME
// `persistReorder` — see src/app/api/galleries/[galleryId]/reorder/route.ts's
// own header for why a single whole-list endpoint replaced the old
// neighbor-swap route.
//
// OPTIMISTIC, BUT RECONCILED — same discipline `handleBulkDelete` below
// already uses, applied to reordering: `persistReorder` applies the new
// order to local state BEFORE the request resolves (a drag that visibly
// snapped back only once the network round trip finished would feel broken),
// but keeps a snapshot of `assets` from before that optimistic write and
// restores it verbatim on any non-2xx response or network failure — a
// `selected`/`delivered`/`archived` gallery's 409 must not leave the grid
// LYING about an order the server refused to persist.
import { useCallback, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
} from "@dnd-kit/sortable";
import { AdminAssetViewer } from "@/components/admin-asset-viewer";
import { AssetTile } from "@/components/asset-tile";
import { ProofUploader } from "@/components/proof-uploader";
import { FinalsBulkUploader } from "@/components/finals-bulk-uploader";
import { DeliverGalleryButton } from "@/components/deliver-gallery-button";
import { compareByFilenameNatural } from "@/lib/natural-sort";

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
  // in order — `handleReordered` below only patches whichever rows'
  // `sortOrder` values changed, it does not itself reorder the array.
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
  const selectedAssets = useMemo(() => sorted.filter((asset) => asset.isSelected), [sorted]);
  const selectedCount = selectedAssets.length;
  const pendingFinalsCount = useMemo(
    () => sorted.filter((asset) => asset.isSelected && !asset.hasFinal).length,
    [sorted],
  );

  const handleUploaded = useCallback((asset: WorkspaceAsset) => {
    setAssets((prev) => [...prev, asset]);
  }, []);

  // Task #195: the bulk-op mark — see this file's own header comment for why
  // it lives here and not inside a tile or the viewer, and why it is never
  // named `selected`. Declared BEFORE `handleDeleted` below on purpose: the
  // INDIVIDUAL delete path (the tile's own "Eliminar" button, task #20, kept
  // alive on purpose right next to the new marking checkbox — criterion #8)
  // has to prune this same set too, not just the bulk path's own
  // `handleBulkDelete`. Without that prune, deleting a marked asset one at a
  // time leaves a mark pointing at a row that no longer exists: the bulk-
  // delete bar's own count goes stale, its confirm dialog overstates how
  // many photos an irreversible action is about to remove, and if the STALE
  // id is the only thing left marked, the bar becomes unreachable — nothing
  // in the grid still carries a "Desmarcar" control for an id that isn't
  // rendered anymore. Fixed after code review found it unguarded by any
  // test; see gallery-workspace.test.tsx's own "the two delete paths agree"
  // describe block below for the regression coverage this was missing.
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

  const handleDeleted = useCallback((assetId: string) => {
    setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
    // Prune the mark, if any — see the comment on `markedIds` above for why
    // this is required, not merely tidy. `has()` first, so this never
    // allocates a new `Set` (and therefore never triggers a re-render) for
    // the common case of deleting an asset that was never marked.
    setMarkedIds((prev) => {
      if (!prev.has(assetId)) return prev;
      const next = new Set(prev);
      next.delete(assetId);
      return next;
    });
  }, []);

  // Task #199: patches `sortOrder` for whichever ids appear in `updates` —
  // used both for the OPTIMISTIC write (before the request resolves) and
  // for reconciling against the server's own `updated` array afterward. See
  // this file's own header for why both drag-and-drop and the alphabetical
  // button route through the same `persistReorder` below, which is the only
  // caller of this function.
  const handleReordered = useCallback((updates: { id: string; sortOrder: number }[]) => {
    if (updates.length === 0) return;
    setAssets((prev) =>
      prev.map((asset) => {
        const update = updates.find((u) => u.id === asset.id);
        return update ? { ...asset, sortOrder: update.sortOrder } : asset;
      }),
    );
  }, []);

  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);

  // Task #199: the ONE place that talks to
  // POST /api/galleries/[galleryId]/reorder — both `handleDragEnd` and
  // `handleSortAlphabetically` below just compute an ordered id list and
  // call this. See this file's own header comment for the
  // optimistic-but-reconciled contract this follows.
  const persistReorder = useCallback(
    async (orderedIds: string[]) => {
      if (reorderBusy) return;
      const previousAssets = assets;
      setReorderBusy(true);
      setReorderError(null);
      handleReordered(orderedIds.map((id, index) => ({ id, sortOrder: index })));
      try {
        const response = await fetch(`/api/galleries/${galleryId}/reorder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetIds: orderedIds }),
        });
        if (!response.ok) {
          // Reverts wholesale, not merely "stop showing a spinner" — a
          // gallery that just moved to `selected` under this photographer's
          // feet (another tab, say) refuses with 409, and the grid must not
          // keep claiming an order the server never actually accepted.
          setAssets(previousAssets);
          setReorderError("No se pudo reordenar.");
          return;
        }
        const body = (await response.json()) as { updated: { id: string; sortOrder: number }[] };
        handleReordered(body.updated);
      } catch {
        setAssets(previousAssets);
        setReorderError("No se pudo conectar.");
      } finally {
        setReorderBusy(false);
      }
    },
    [assets, galleryId, handleReordered, reorderBusy],
  );

  // Task #199's central risk, written down where the fix lives: without an
  // activation constraint, EVERY pointer-down on the drag handle (see
  // asset-tile.tsx's own header for why the handle is a dedicated control)
  // would register as a drag before any click ever fires, which would not
  // look like a drag bug — it would look like "the handle sometimes does
  // nothing." `distance: 8` is dnd-kit's own documented starting point for
  // telling an intentional drag apart from a tap's incidental finger
  // movement.
  //
  // THE PRIMARY DEFENSE IS STRUCTURAL, NOT THIS CONSTRAINT: the open-viewer
  // button (`absolute inset-0`, asset-tile.tsx) carries no drag listeners at
  // all, only the handle does, so a tap anywhere on the photo cannot become
  // a drag regardless of how `distance` is tuned. This constraint only
  // matters for taps ON the handle itself.
  //
  // AT 390PX (the dashboard epic's own mobile reference, #125): the control
  // row (this handle + "Eliminar") was measured, not eyeballed — a
  // standalone HTML page reproducing the control row's own markup, loaded in
  // a real Chromium instance against this project's own compiled Tailwind
  // output, at a 390px viewport, three tiles per row (the actual column
  // count `grid-cols-[repeat(auto-fill,minmax(92px,1fr))]` produces once
  // `main`'s own `px-4` is subtracted), measured ~101px of usable tile width
  // against a combined ~69px for the handle (24px) + "Eliminar" (~45px) —
  // roughly 30px of slack, no overflow, no wrap. That check was NOT run
  // through the committed `e2e/` capture
  // harness: `global-setup.ts`'s fixture-gallery seeding currently fails
  // against this dev database independently of this slice (task #100's
  // `galleries_active_client_check` trigger rejects the gallery insert
  // before a client is attached in the same transaction) — a pre-existing
  // gap this task does not own and did not introduce, reported separately
  // rather than patched here.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // Criterion #6: reordering must work with a keyboard, not only a
    // pointer — the up/down buttons this replaces were clumsy but
    // accessible, and dropping keyboard support here would be a real
    // regression wearing an upgrade's clothes. `sortableKeyboardCoordinates`
    // is dnd-kit's own grid-aware coordinate getter: Space picks a tile up,
    // arrow keys move it, Space again drops it, Escape cancels.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Criterion: "anunciá el resultado del movimiento con aria-live... no
  // sólo el estado de arrastre." dnd-kit renders its own visually-hidden
  // live region (<DndContext accessibility>) and calls these for every
  // sensor — pointer AND keyboard alike, so this is the one place that
  // covers both. Overridden here only for Spanish copy and the
  // filename/position framing the kanban body asked for by name
  // ("IMG_0007.JPG movida a la posición 3 de 84"); dnd-kit's English
  // defaults would otherwise announce active/over ids, meaningless to a
  // screen-reader user.
  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }) {
        const asset = sorted.find((item) => item.id === active.id);
        return asset ? `${asset.originalFilename} levantada para reordenar.` : undefined;
      },
      onDragOver({ active, over }) {
        if (!over) return undefined;
        const asset = sorted.find((item) => item.id === active.id);
        const position = sorted.findIndex((item) => item.id === over.id) + 1;
        return asset
          ? `${asset.originalFilename} sobre la posición ${position} de ${sorted.length}.`
          : undefined;
      },
      onDragEnd({ active, over }) {
        const asset = sorted.find((item) => item.id === active.id);
        if (!asset) return undefined;
        if (!over) return `${asset.originalFilename} soltada sin cambiar de posición.`;
        const position = sorted.findIndex((item) => item.id === over.id) + 1;
        return `${asset.originalFilename} movida a la posición ${position} de ${sorted.length}.`;
      },
      onDragCancel({ active }) {
        const asset = sorted.find((item) => item.id === active.id);
        return asset ? `Reordenamiento de ${asset.originalFilename} cancelado.` : undefined;
      },
    }),
    [sorted],
  );

  // A drop can land anywhere in the grid, not just next to a neighbor —
  // `arrayMove` computes the WHOLE resulting order, which is exactly the
  // shape `persistReorder`/the reorder endpoint expect (see this file's own
  // header and that route's).
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = sorted.findIndex((asset) => asset.id === active.id);
      const newIndex = sorted.findIndex((asset) => asset.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(sorted, oldIndex, newIndex);
      void persistReorder(reordered.map((asset) => asset.id));
    },
    [sorted, persistReorder],
  );

  // The "Ordenar por nombre de archivo" button (task #199's second entry
  // point into `persistReorder`): computed CLIENT-SIDE off the already-
  // loaded, already-correct `sorted` list, with the SAME natural-order
  // comparator src/lib/natural-sort.ts documents (numeric-aware, case-
  // insensitive on the extension, id tie-break for duplicate filenames).
  // Deliberately not a server round trip to compute the order — this
  // component already holds every `originalFilename` it needs.
  const handleSortAlphabetically = useCallback(() => {
    const naturallyOrdered = [...sorted].sort(compareByFilenameNatural);
    void persistReorder(naturallyOrdered.map((asset) => asset.id));
  }, [sorted, persistReorder]);

  const handleFinalUploaded = useCallback((assetId: string) => {
    setAssets((prev) =>
      prev.map((asset) => (asset.id === assetId ? { ...asset, hasFinal: true } : asset)),
    );
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

      {/* Task #217: bulk final upload, proposed-then-confirmed by filename
          match. Shares the exact same `handleFinalUploaded` the per-tile
          "Subir final" control already uses (asset-tile.tsx), which stays
          untouched and reachable right on the grid below — see this file's
          own header on `pendingFinalsCount` for why there is exactly one
          live counter to keep in sync, and this component updates it the
          same way a single-tile upload does.

          TASK #223 CHANGED BOTH THE INPUT AND THE GATE. It used to receive
          `selectedAssets` and render only once at least one photo was
          selected ("no candidates to map against otherwise"). Both followed
          from a rule that no longer holds: an unselected asset could not
          receive a final. The photographer can now deliver photos the client
          never picked, so the candidate pool is every asset and the only
          honest gate is "are there any photos at all" — a gallery whose
          client chose nothing is exactly a case where the photographer may
          still want to gift a few. */}
      {sorted.length > 0 && (
        <FinalsBulkUploader assets={sorted} onFinalUploaded={handleFinalUploaded} />
      )}

      {/* Task #199: the alphabetical-sort action — an ACTION, not a mode
          (the owner's own explicit decision, this task's kanban body): once
          pressed, the gallery's `sortOrder` is renumbered by natural
          filename order and stays that way until something else (a drag, or
          this button again) changes it. Only shown once there is more than
          one photo to meaningfully order. Copy says what it DOES ("Ordenar
          por nombre de archivo"), not "Reset" — nothing here is destructive,
          only renumbered. */}
      {sorted.length > 1 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={reorderBusy}
            onClick={handleSortAlphabetically}
            className="border-line-2 hover:border-accent min-h-9 rounded-[4px] border px-3 text-xs font-semibold tracking-[0.04em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Ordenar por nombre de archivo
          </button>
          {reorderError && (
            <p className="text-xs text-[#e0796b]" role="alert">
              {reorderError}
            </p>
          )}
        </div>
      )}

      {/* Task #134: density. The grid starts at the mock's `minmax(92px,1fr)`
          (3-4 columns on a phone) and GROWS to `minmax(122px,1fr)` on the
          desk — epic #125's own rule that a volume surface grows when it has
          room, rather than being cropped when it doesn't
          (design/system/dashboard.html:426-429, :603).

          Task #199: the grid itself is now the drag-and-drop surface —
          <DndContext> wires up the pointer/keyboard sensors and the
          announcements above, <SortableContext> hands every tile the SAME
          ordered id list this component already renders from, so dnd-kit's
          own notion of "current order" never drifts from `sorted`. */}
      {sorted.length === 0 ? (
        <p className="text-fg-dim text-[15px] leading-relaxed">
          Todavía no subiste fotos de esta sesión — usá el selector de arriba.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements }}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sorted.map((asset) => asset.id)} strategy={rectSortingStrategy}>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1.5 sm:gap-2 lg:grid-cols-[repeat(auto-fill,minmax(122px,1fr))]">
              {sorted.map((asset) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  isMarked={markedIds.has(asset.id)}
                  onDeleted={handleDeleted}
                  onFinalUploaded={handleFinalUploaded}
                  onOpen={() => handleOpenViewer(asset.id)}
                  onToggleMarked={handleToggleMarked}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
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
