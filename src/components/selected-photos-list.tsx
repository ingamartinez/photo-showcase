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
// EPIC #250 (task #263) REMOVED TWO PROPS. `rollingDelivery` gated the work
// queue, and decision 11 made the order semantics mandatory — the queue is
// not a feature any more, it is what the list is for. `frozenPickerIds`
// gated "only people who already sent", and under decision 10 a submit no
// longer locks anybody, so every listed photo is claimed (a submitted pick is
// what claims it) and nobody is "frozen" in that sense any more. What DID
// change is attribution: a photo can have several pickers, so the person
// filter reads `pickers` (submitted picks only — see that field's comment)
// and the row names the BILLED holder plus how many others asked.
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
  /** `assets.selected_by` (`billedTo`) — whose unit it is, for display only.
   * `null` for a legacy unit with no recorded holder ("Sin registro"). */
  billedTo?: string | null;
  originalFilename: string;
  selectionKind: "edited" | "original";
  /**
   * Every person who SUBMITTED a pick on this photo (`billed` or `joined`),
   * holder first (the entry order `buildGallerySelection` produces).
   *
   * DELIBERATELY submitted-only (task #263's weakest point, recorded where it
   * is implemented): a `cart`/`degraded` pick is not sent yet — the same rule
   * `selected-photos-list.tsx`'s predecessor used to exclude "por enviar"
   * work — and the client's own tray is where unsent picks belong. The owner
   * may later want "everything Beto touched"; this is a choice, not an
   * oversight.
   */
  pickers: string[];
  /** The edited final is already uploaded (`finalKey !== null`). */
  hasFinal?: boolean;
};

const KIND_LABELS: Record<SelectedPhotoListItem["selectionKind"], string> = {
  edited: "Editada",
  original: "Original",
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
  people = [],
}: {
  items: SelectedPhotoListItem[];
  /** The people a photo can be filtered by, `name ?? email`. Shown as a filter
   * only when there is more than one — a selector with one option decides
   * nothing. */
  people?: { id: string; label: string }[];
}) {
  const [personId, setPersonId] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  if (allItems.length === 0) return null;

  // Display-only attribution (#245): unknown or null pickers just show no name.
  const labels = new Map(people.map((person) => [person.id, person.label]));
  const items = allItems
    // Decision 1: several people can ask for the same photo, so "Beto's
    // photos" includes the ones where Beto only JOINED somebody else's unit.
    .filter((item) => personId === "" || item.pickers.includes(personId))
    // The photographer's work list: claimed and still without a final — the
    // deliver gate's own predicate (`is_selected AND final_key IS NULL`), the
    // same one `getPendingSelectionCount` and <GalleryWorkspace> use.
    .filter((item) => !onlyPending || !item.hasFinal);

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
          Pendientes de subir editada
        </label>
      </div>
      <div className="mt-4 flex flex-col gap-6">
        {isMixed ? (
          <>
            <PhotoGroup label={GROUP_LABELS.edited} items={edited} labels={labels} />
            <PhotoGroup label={GROUP_LABELS.original} items={original} labels={labels} />
          </>
        ) : (
          // Whichever of the two arrays is non-empty IS `items`, natural
          // sorted — re-sorting the already-filtered array rather than
          // reusing `edited`/`original` directly so this branch does not
          // depend on knowing which of the two happens to hold everything.
          <PhotoGroup items={items.slice().sort(compareByFilenameNatural)} labels={labels} />
        )}
      </div>
    </details>
  );
}

type CopyState = "idle" | "copied" | "error";

function PhotoGroup({
  label,
  items,
  labels,
}: {
  label?: string;
  items: SelectedPhotoListItem[];
  labels: Map<string, string>;
}) {
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
        {items.map((item) => {
          const who = item.billedTo != null ? labels.get(item.billedTo) : undefined;
          // "+N": how many OTHER people asked for the same photo. The billed
          // holder is named; the rest are counted, because the row has to stay
          // one line and the identities are the client tray's job (task #261).
          const others = item.pickers.length > 1 ? ` +${item.pickers.length - 1}` : "";
          return (
            <li key={item.id}>
              <span data-testid="photo-filename">{item.originalFilename}</span>
              <span data-testid="photo-attribution" className="text-fg-mute ml-2 font-sans">
                {who ? `${who}${others} · ` : ""}
                {KIND_LABELS[item.selectionKind]}
              </span>
            </li>
          );
        })}
      </ol>
      {copyState === "copied" && (
        <p role="status" className="text-accent-2 mt-2 text-xs">
          Copiado al portapapeles.
        </p>
      )}
      {copyState === "error" && (
        <p role="alert" className="text-danger mt-2 text-xs">
          No se pudo copiar — selecciona la lista y cópiala a mano.
        </p>
      )}
    </div>
  );
}
