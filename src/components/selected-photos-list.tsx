"use client";

// Task #216 — the owner's own words: "necesito ... el listado de las fotos
// seleccionadas ... para poder escogerlas en Lightroom y empezar la
// edicion". The admin detail page already SAYS how many are selected (the
// "Seleccionadas" `<dd>` on that page), but not WHICH ones — finding out
// meant scrolling the ~84-tile grid and reading each tile's "Elegida" badge
// by eye. This renders the actual filenames, in the SAME order Lightroom's
// own filmstrip would show them, plus a one-click copy so they never have to
// be retyped.
//
// TEXT ONLY, no R2 keys and no presigned URLs — same posture
// src/lib/gallery-selection.ts's own header comment holds for the client
// tray: this is a second way to READ what was picked, never a second way to
// reach the bytes.
//
// Props are the ALREADY-FILTERED selected list, not the full gallery —
// `src/app/dashboard/galleries/[galleryId]/page.tsx` derives this from the
// exact same `gallery.assets` array `selectedCount` and the
// `selectedEditedCount`/`selectedOriginalCount` split already read (see that
// page's own comment on why a SECOND filter reading the same fact
// differently is the "two reads subtracted" bug task #206 shipped and #210
// documented). This component itself never filters `isSelected` — it only
// splits what it was already handed by `selectionKind`.
//
// SERVER-RENDERED PROPS, not live client state: `isSelected` only ever
// changes from the CLIENT side of the app (the gallery's own picking UI),
// never from this admin screen, so there is nothing here to keep in sync
// with a local mutation — see this task's own "Contexto verificado" for why
// <GalleryWorkspace> is deliberately not the owner of this list.
//
// Brand tokens (`border-line-2`, `text-fg-mute`, …), not `app-*`: this file
// lives under `src/components/`, not `src/app/dashboard/**`, and epic #125's
// ESLint rule (task #175) only allows `app-*` utilities inside that
// directory — see <SelectionTrayModeControl>'s own comment for the identical
// reasoning, another `src/components/*` file rendered exclusively on this
// same dashboard page.
import { useState } from "react";
import { compareByFilenameNatural } from "@/lib/natural-sort";

export type SelectedPhotoListItem = {
  id: string;
  /** `assets.selected_by` — who picked it (epic #239). Optional: callers that
   * cannot attribute picks never get the per-person filter. */
  selectedBy?: string | null;
  originalFilename: string;
  selectionKind: "edited" | "original";
  /** Task #244 — rolling delivery: the client ORDERED this pick. */
  isRequested?: boolean;
  /** Task #244 — the edited final is already uploaded. */
  hasFinal?: boolean;
};

const GROUP_LABELS: Record<SelectedPhotoListItem["selectionKind"], string> = {
  // Exactly the set that goes into Lightroom — the reason this task exists.
  edited: "Para editar",
  // The client asked for these raw; the photographer does NOT edit them.
  // Mixing this into the "Para editar" list would have the photographer
  // import photos to edit that are actually meant to ship untouched.
  original: "Entrega sin editar",
};

/**
 * The admin detail page's "which photos, by name" apartado — collapsible,
 * closed by default, with a copyable filename list per `selectionKind`.
 *
 * Renders nothing when `items` is empty: a `draft`/`proofing` gallery with no
 * picks yet has nothing to list, and an empty collapsible would just be dead
 * chrome on a page that already reads "Seleccionadas: 0" a few lines up.
 */
export function SelectedPhotosList({
  items: allItems,
  frozenPickerIds = [],
  rollingDelivery = false,
  people = [],
}: {
  items: SelectedPhotoListItem[];
  /** Active clients whose selection is locked (they submitted, or the admin
   * locked them) — their picks will not change, so the photographer can start
   * editing them. Epic #239 (#242). */
  frozenPickerIds?: string[];
  /** Task #244 — rolling delivery: adds the work-queue filters below. */
  rollingDelivery?: boolean;
  /** Task #244 — the gallery's active clients, for the per-person filter. */
  people?: { id: string; label: string }[];
}) {
  const [onlyFrozen, setOnlyFrozen] = useState(false);
  const [personId, setPersonId] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  if (allItems.length === 0) return null;

  const frozen = new Set(frozenPickerIds);
  const items = allItems
    .filter((item) => !onlyFrozen || (item.selectedBy != null && frozen.has(item.selectedBy)))
    .filter((item) => !rollingDelivery || personId === "" || item.selectedBy === personId)
    // The photographer's work list: ORDERED and still without a final. Photos
    // still "por enviar" are not work yet and never appear here.
    .filter(
      (item) => !rollingDelivery || !onlyPending || (item.isRequested === true && !item.hasFinal),
    );

  const edited = items
    .filter((item) => item.selectionKind === "edited")
    .sort(compareByFilenameNatural);
  const original = items
    .filter((item) => item.selectionKind === "original")
    .sort(compareByFilenameNatural);

  // Both groups populated is the ONLY case that earns two headed sub-lists —
  // task #214 defaults `allows_original_selection` to `false`, so every
  // gallery shipped before that switch existed (and every one it stays off
  // for) has `original.length === 0` here, and must keep reading as the
  // single plain list it always was, not pay ceremony for a distinction it
  // does not have.
  const isMixed = edited.length > 0 && original.length > 0;

  return (
    <details className="border-line-2 mt-10 rounded-[6px] border p-4">
      <summary className="text-fg cursor-pointer text-sm font-medium">
        Fotos seleccionadas ({items.length})
      </summary>
      {frozen.size > 0 && (
        <label className="text-fg mt-4 flex min-h-11 items-center gap-2 text-sm lg:min-h-6">
          <input
            type="checkbox"
            checked={onlyFrozen}
            onChange={(event) => setOnlyFrozen(event.target.checked)}
          />
          Solo de quienes ya enviaron o quedaron bloqueados
        </label>
      )}
      {rollingDelivery && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {people.length > 1 && (
            <label className="text-fg flex items-center gap-2 text-sm">
              Persona
              <select
                value={personId}
                onChange={(event) => setPersonId(event.target.value)}
                className="border-line-2 text-fg rounded-[5px] border bg-transparent px-2 py-1 text-sm"
              >
                <option value="">Todas</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-fg flex min-h-11 items-center gap-2 text-sm lg:min-h-6">
            <input
              type="checkbox"
              checked={onlyPending}
              onChange={(event) => setOnlyPending(event.target.checked)}
            />
            Solo pedidas sin editar
          </label>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-6">
        {isMixed ? (
          <>
            <PhotoGroup label={GROUP_LABELS.edited} items={edited} />
            <PhotoGroup label={GROUP_LABELS.original} items={original} />
          </>
        ) : (
          // Whichever of the two arrays is non-empty IS `items`, natural
          // sorted — re-sorting the already-filtered array rather than
          // reusing `edited`/`original` directly so this branch does not
          // depend on knowing which of the two happens to hold everything.
          <PhotoGroup items={items.slice().sort(compareByFilenameNatural)} />
        )}
      </div>
    </details>
  );
}

type CopyState = "idle" | "copied" | "error";

function PhotoGroup({ label, items }: { label?: string; items: SelectedPhotoListItem[] }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  // `navigator.clipboard` can be missing entirely (non-secure context) — the
  // list stays fully visible and selectable by hand either way, so a failed
  // copy is a small inline message, never a dead screen.
  async function handleCopy() {
    const text = items.map((item) => item.originalFilename).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        {label ? (
          <h3 className="text-fg-mute text-xs tracking-wide uppercase">
            {label} ({items.length})
          </h3>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 shrink-0 items-center justify-center rounded-[5px] border px-3 text-xs transition-colors lg:min-h-6"
        >
          Copiar
        </button>
      </div>
      <ol className="text-fg list-decimal space-y-1 pl-5 font-mono text-xs">
        {items.map((item) => (
          <li key={item.id}>{item.originalFilename}</li>
        ))}
      </ol>
      {copyState === "copied" && (
        <p role="status" className="text-accent-2 mt-2 text-xs">
          Copiado al portapapeles.
        </p>
      )}
      {copyState === "error" && (
        <p role="alert" className="text-danger mt-2 text-xs">
          No se pudo copiar — seleccioná la lista y copiala a mano.
        </p>
      )}
    </div>
  );
}
