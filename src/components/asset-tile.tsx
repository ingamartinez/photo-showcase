"use client";

// One proof in the admin grid (task #20): the thumbnail itself (with
// on-demand presigned-URL refresh), plus reorder and delete controls. Task
// #26 adds a final-upload control, rendered only for SELECTED assets — see
// its own comment below for why that follows the exact same "most assets
// never get one" rule the write route itself enforces. Task #199 (see its
// own comment further down) later replaces the original "move up"/"move
// down" reorder buttons with a drag handle — the delete/final-upload
// controls are untouched by that change.
//
// Task #134 — state legibility "at a glance across the whole grid, not one
// tile at a time": the three states that matter (proof only / selected /
// selected+final) are now visible ON the thumbnail itself, as overlay
// badges (design/system/dashboard.html:441-455's `.asset__flag`/
// `.asset__final`), not only in the below-image controls a photographer
// would have to open one tile at a time to read. Neither badge is
// colour-only — "Elegida" is a real word, the final badge is a "✓" glyph —
// and the delete/final-upload CONTROLS below the image are unchanged in
// text/role, on purpose: this file's own existing tests (task #20/#26)
// already prove those interactions work, and this slice is a restyle, not a
// rewrite of the interaction model. (The reorder control itself is the one
// exception — task #199 replaces it outright; see that task's own comment.)
//
// Task #195 adds two more controls on THIS thumbnail: clicking the image
// opens <AdminAssetViewer> (the full-screen, object-contain view — the
// mirror-image request the owner made of #134's own crop) via `onOpen`, and
// a bulk-op "marked" checkbox via `isMarked`/`onToggleMarked`. Neither piece
// of state is OWNED here: both are lifted to <GalleryWorkspace>, which is
// what makes "open a marked photo full screen without losing the mark" true
// — see that file's own header comment. This tile only ever reads
// `isMarked` and reports a toggle upward; it holds no state of its own for
// either feature.
//
// NAMING, ON PURPOSE: `isMarked`/`onToggleMarked`, never `selected`/
// `isSelected`/`onToggleSelection` — `asset.isSelected` two lines below is
// already a DIFFERENT fact (the CLIENT's choice, task #24), and the
// "Elegida" badge already renders it. Confusing the two names here would be
// exactly the trap gallery-workspace.tsx's header comment calls out: a
// photographer bulk-deleting what they believe is their own admin-side
// pick, when the code actually marked the client's already-committed
// selection.
//
// TASK #199 — A THIRD GESTURE, VIA A DEDICATED HANDLE, NOT THE WHOLE TILE
// ========================================================================
// This tile already carries two conflicting full-surface interactions: the
// "open viewer" button covers the ENTIRE image box (`absolute inset-0`,
// below), and the marking checkbox sits on top of it in one corner. dnd-kit's
// own docs are explicit about this exact situation: when a sortable item
// contains its own interactive children, `listeners`/`attributes` belong on
// a dedicated DRAG HANDLE, not on the item itself — spreading them on the
// whole tile would mean every pointer-down on the open button or the
// checkbox is ALSO a drag-sensor candidate, and the two would have to be
// disambiguated by tuning alone. A handle sidesteps the ambiguity
// structurally instead: it is placed in the below-image control row (where
// the removed "Mover antes"/"Mover después" buttons used to live), not
// anywhere on the photo, so it never competes with the open-viewer tap or
// the 24px checkbox for the same pixels, and dragging never needs to
// distinguish "the user meant to open this" from "the user meant to move
// this" — a press on the handle can only ever mean the second thing.
// `touch-none` (CSS `touch-action: none`) is scoped to JUST this small
// button, not the tile or the grid, so a photographer can still scroll the
// grid normally by touching anywhere else on a tile — sacrificing native
// touch scrolling only over the one control whose entire job is dragging.
import { useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { WorkspaceAsset } from "@/components/gallery-workspace";
import { cn } from "@/lib/utils";

export function AssetTile({
  asset,
  isMarked,
  onDeleted,
  onFinalUploaded,
  onOpen,
  onToggleMarked,
}: {
  asset: WorkspaceAsset;
  // Task #195: whether the PHOTOGRAPHER marked this tile for a bulk
  // operation — owned by <GalleryWorkspace>, read-only here. Distinct from
  // `asset.isSelected` (the client's own pick) — see the file header.
  isMarked: boolean;
  onDeleted: (assetId: string) => void;
  onFinalUploaded: (assetId: string) => void;
  // Task #195: opens <AdminAssetViewer> on this tile's own asset. Takes no
  // argument — <GalleryWorkspace> already knows which asset this tile is
  // for (it's the one bound in the `.map()` that renders this component),
  // so there is nothing this tile needs to hand back beyond "open".
  onOpen: () => void;
  onToggleMarked: (assetId: string) => void;
}) {
  // Task #199: this tile IS the sortable item — <GalleryWorkspace> renders
  // the <SortableContext> around the grid and supplies the ordered id list;
  // everything else dnd-kit needs (measuring this node, computing the drag
  // transform, wiring the keyboard sensor) is local to this component,
  // keyed on the one id <GalleryWorkspace> already uses to identify this
  // asset everywhere else.
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: asset.id });
  const sortableStyle = { transform: CSS.Transform.toString(transform), transition };

  const [src, setSrc] = useState(asset.proofUrl);
  const [refreshedOnce, setRefreshedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalBusy, setFinalBusy] = useState(false);
  const [finalError, setFinalError] = useState<string | null>(null);
  const finalInputRef = useRef<HTMLInputElement>(null);

  // A presigned proof URL is only good for 5 minutes
  // (`PRESIGNED_URL_TTL_SECONDS`, src/lib/r2.ts). On a gallery page left
  // open longer than that (uploading ~100 photos is not a 5-minute job),
  // the <img> below fails to load with the ORIGINAL url — this refetches a
  // fresh one from the read route (task #16) ONCE, on demand, rather than
  // polling every tile on a timer regardless of whether it's even still on
  // screen. Guarded by `refreshedOnce` so a genuinely broken/deleted object
  // fails once and stays failed, instead of retrying forever.
  //
  // Task #194 note: with `loading="lazy"` on the <img> below, a tile that
  // never scrolled into view never fires `load` OR `error` — the browser
  // hasn't fetched anything for it yet. That's fine; it just means the
  // FIRST fetch, once it finally happens on scroll, is now more likely to
  // already be racing a presign that's close to (or past) its TTL on a tab
  // left open a while. This handler doesn't change: it still fires once,
  // refetches once, and `refreshedOnce` still stops it from looping if the
  // refreshed URL is itself already bad (a genuinely deleted object, say).
  // What changes is only how OFTEN this path gets exercised in practice —
  // it moves from "rare" to "the normal case for a long-lived tab" — not
  // whether it stays idempotent.
  async function handleImgError() {
    if (refreshedOnce) return;
    setRefreshedOnce(true);
    try {
      const response = await fetch(`/api/assets/${asset.id}/proof`);
      if (!response.ok) return;
      const body = (await response.json()) as { url: string };
      setSrc(body.url);
    } catch {
      // Leave the broken thumbnail as-is; nothing else to try here.
    }
  }

  async function handleDelete() {
    if (busy) return;
    if (
      !window.confirm(`¿Eliminar "${asset.originalFilename}"? Esta acción no se puede deshacer.`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      if (!response.ok) {
        setError("No se pudo eliminar.");
        return;
      }
      onDeleted(asset.id);
    } catch {
      setError("No se pudo conectar.");
    } finally {
      setBusy(false);
    }
  }

  // Task #26: attaches (or replaces) this asset's final. The route itself
  // is the real guard (an unselected asset gets refused with 409) — this
  // control is only ever RENDERED for a selected asset in the first place
  // (see below), so that refusal should never actually be reachable from
  // this UI, but the route never trusts this component to have gotten that
  // right.
  async function handleFinalFileChosen(file: File) {
    if (finalBusy) return;
    setFinalBusy(true);
    setFinalError(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch(`/api/assets/${asset.id}/final`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setFinalError(body.error ?? `Error ${response.status}`);
        return;
      }
      onFinalUploaded(asset.id);
    } catch {
      setFinalError("No se pudo conectar.");
    } finally {
      setFinalBusy(false);
      if (finalInputRef.current) finalInputRef.current.value = "";
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={sortableStyle}
      className={cn(
        "border-line-2 flex flex-col gap-1.5 rounded-[6px] border p-1.5",
        asset.isSelected && "outline-accent outline-2 -outline-offset-2",
        // Task #199: lifted above its siblings and slightly faded while
        // actively being dragged, so the tile currently under the pointer/
        // keyboard focus reads as "picked up" rather than looking identical
        // to the rest of the grid mid-reorder.
        isDragging && "z-10 opacity-60",
      )}
    >
      {/* Task #134: a FIXED aspect ratio (the mock's 3/2), not each photo's
          own natural ratio — a uniform grid is what actually buys the
          density this task asks for, since rows can pack predictably
          instead of each tile claiming whatever height its own image
          happens to want. `object-cover` already did the cropping; only the
          box's own ratio changed. */}
      <div className="bg-line-2 relative aspect-[3/2] overflow-hidden rounded-[4px]">
        {/* Plain <img>, not next/image: proof URLs are short-lived, private,
            presigned R2 URLs whose query string (and therefore exact form)
            is never stable between two loads of the same asset — configuring
            a next/image remote pattern for that buys nothing, since
            processProof already downscales/compresses server-side. */}
        {/* Task #194: `loading="lazy"` is the actual fix for the owner's
            report ("al abrir la galería me carga todas las imágenes") — a
            gallery with ~84 proofs used to fire ~84 eager downloads on
            first paint because a bare <img> defaults to eager. The box
            above is a FIXED `aspect-[3/2]`, so this introduces no CLS: the
            layout already reserves the space before the image ever
            arrives, lazy or not. `decoding="async"` rides along with it —
            without it, the browser can still decode dozens of JPEGs on the
            main thread as they cross into view, which is a scroll-jank
            problem `loading="lazy"` alone doesn't solve (it only staggers
            the network fetch, not the decode). Neither attribute touches
            `getPresignedUrl` or the read route — signing is a local HMAC,
            not an R2 round trip, so 84 signatures were never the cost (see
            this task's own kanban body for why that's a decoy). */}
        {/* Task #195: the whole image is the "open full screen" control.
            A real <button>, not a click handler on a bare <img> or a
            keyboard-inaccessible <div>, so Enter/Space already work with no
            extra wiring. The badges, filename and marking checkbox below
            are SIBLINGS, not children — an interactive <button> (the
            marking checkbox) cannot legally nest inside another <button>
            (this one). They paint on top of this one by ordinary DOM
            stacking (later siblings paint over earlier ones at the same
            `z-index: auto`), and a click always targets the topmost element
            at that point, so the checkbox intercepts its own clicks without
            needing `stopPropagation` — they are siblings, not ancestor and
            descendant, so a click on one never bubbles into the other. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Ver ${asset.originalFilename} en grande`}
          className="absolute inset-0 block h-full w-full cursor-zoom-in"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={asset.originalFilename}
            loading="lazy"
            decoding="async"
            onError={() => void handleImgError()}
            className="h-full w-full object-cover"
          />
        </button>

        {/* State badges, at a glance across the whole grid — task #134.
            Neither is colour-only: "Elegida" is a real word, and the final
            badge carries a "✓" glyph plus a title, matching the mock's own
            `.asset__flag` / `.asset__final` (dashboard.html:443-455). */}
        {asset.isSelected && (
          <span className="bg-accent pointer-events-none absolute top-1 left-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-[0.04em] text-[#14100a] uppercase">
            Elegida
          </span>
        )}
        {asset.isSelected && asset.hasFinal && (
          <span
            title="Final subido"
            aria-hidden="true"
            className="pointer-events-none absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-[#7a9b82] text-[10px] font-bold text-[#08150c]"
          >
            ✓
          </span>
        )}

        {/* Filename, overlaid on a bottom gradient scrim rather than a
            separate line below the image (design/system/dashboard.html:
            432-440) — frees up the vertical space the old layout spent on
            it, which is the whole point of this slice's density goal. The
            scrim is a SEPARATE layer behind the text (not a `bg-clip-text`
            mask on the text itself) — that trick makes the glyphs show the
            gradient THROUGH them, which is illegible against a dark tile;
            plain light text over a dark-to-transparent scrim is what the
            mock actually does. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/75 to-transparent"
        />

        {/* Task #195's "marked" checkbox — bottom-left, over the same scrim
            the filename sits on. Deliberately NOT styled like "Elegida"
            (top-left, brass pill, plain text): different corner, different
            shape (a small square checkbox instead of a text pill), and the
            SAME `#e0796b` danger red this file already uses for its own
            inline error text (the `error`/`finalError` paragraphs below) —
            reused, not a new colour invented for this, and a semantically
            honest one: the only thing this mark does is queue the photo for
            bulk deletion. `#e0796b` directly, not the `app-danger` Tailwind
            utility: that utility only paints under `[data-surface="app"]`
            (globals.css, task #175) and eslint.config.mjs's own
            `no-restricted-syntax` rule refuses it outside
            `src/app/dashboard/**`/`src/components/dashboard-*`, which this
            file's own name is neither — even though it only ever renders
            inside the dashboard. See the file header for why this is
            `isMarked`/`onToggleMarked`, never `selected`.

            SIZE AND CONTRAST, fixed after code review: `size-6` (24px), not
            the original `size-4` (16px) — matching the `min-h-6 min-w-6`
            drag-handle/delete controls in the same tile, below. 16px was
            smaller than every other control on this
            component, sitting on a grid whose tiles run as small as ~92px
            wide, with the ENTIRE rest of the tile behind it wired to open
            the full-screen viewer instead — a near-miss tap there opens a
            photo rather than marking it, on the path that ends in an
            irreversible bulk delete. The unmarked state is also more
            opaque now (`bg-black/60`, `border-fg-dim` at full opacity
            instead of `/70`) — a control the photographer has to notice in
            order to use needed better contrast against an arbitrary
            photograph than a faint outline. */}
        <button
          type="button"
          onClick={() => onToggleMarked(asset.id)}
          aria-pressed={isMarked}
          aria-label={
            isMarked
              ? `Desmarcar ${asset.originalFilename}`
              : `Marcar ${asset.originalFilename} para borrar`
          }
          className={cn(
            "absolute bottom-1 left-1 flex size-6 items-center justify-center rounded-[3px] border transition-colors",
            isMarked
              ? "border-[#e0796b] bg-[#e0796b] text-[#1a0d0a]"
              : "border-fg-dim bg-black/60 text-transparent hover:border-[#e0796b]",
          )}
        >
          <span aria-hidden="true" className="text-xs leading-none font-bold">
            ✓
          </span>
        </button>
        <p
          className="text-fg-dim pointer-events-none absolute right-1.5 bottom-1.5 left-9 truncate font-mono text-[9px]"
          title={asset.originalFilename}
        >
          {asset.originalFilename}
        </p>
      </div>
      {error && <p className="text-xs text-[#e0796b]">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        {/* Task #199: the ONE drag handle — see the file header for why this
            lives here (its own row, off the photo) rather than as a
            listeners-bearing prop on the whole tile or a corner overlay
            fighting the marking checkbox for the same pixels. `touch-none`
            is scoped to this 24px control alone: dnd-kit's own guidance for
            a `PointerSensor` drag source is `touch-action: none` on the
            ACTIVATOR element, so a touch-and-hold here is unambiguously "pick
            this up," never "start scrolling the page" — every other pixel
            of the tile keeps its native touch-scroll behavior. */}
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reordenar ${asset.originalFilename}`}
          className="border-line-2 hover:border-accent flex min-h-6 min-w-6 touch-none items-center justify-center rounded-[4px] border px-1 py-1 transition-colors active:cursor-grabbing"
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleDelete()}
          className="min-h-6 text-xs text-[#e0796b] transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          Eliminar
        </button>
      </div>

      {/* Task #26: only rendered for a SELECTED asset — most assets never
          get a final (schema.ts's own comment on `assets.finalKey`), and
          showing this control on every tile would bury the ones that
          actually need attention among the ones that never will. This is
          also the "make the remaining work obvious" acceptance criterion,
          applied per-tile: `!asset.hasFinal` is visually distinct (the
          "falta" text below), not merely absent. */}
      {asset.isSelected && (
        <div className="border-line-2 flex flex-col gap-1 border-t pt-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className={asset.hasFinal ? "text-accent-2 text-xs" : "text-xs text-[#e0796b]"}>
              {asset.hasFinal ? "Final subido" : "Falta el final"}
            </span>
            <label className="hover:text-accent-2 min-h-6 cursor-pointer text-xs tracking-[0.04em] uppercase transition-colors">
              {finalBusy ? "Subiendo…" : asset.hasFinal ? "Reemplazar" : "Subir final"}
              <input
                ref={finalInputRef}
                type="file"
                // Narrowed to match the server's own format allowlist
                // (`ACCEPTED_FINAL_FORMATS` in
                // src/app/api/assets/[assetId]/final/route.ts) — JPEG and PNG
                // as of task #220. This is a HINT for the OS file dialog, not
                // the real gate (the server 415s anything else regardless).
                // #220 fixed a real instance of these two drifting: #218 left
                // this at `image/jpeg` only, which meant a PNG the server
                // would now happily accept was greyed out in the native
                // picker — the owner could never SELECT the files that
                // started this whole task, even after the server-side fix
                // shipped. Keep this string's format list literally in sync
                // with that map's keys by hand; a route-handler module is
                // server-only and cannot be imported here to derive it (see
                // this task's own report for why that was tried and
                // rejected, not merely skipped).
                accept="image/jpeg,image/png"
                disabled={finalBusy}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFinalFileChosen(file);
                }}
              />
            </label>
          </div>
          {finalError && <p className="text-xs text-[#e0796b]">{finalError}</p>}
        </div>
      )}
    </li>
  );
}
