"use client";

// Task #223 — the photographer's own control for "a qué persona va asignada"
// each gifted EXTRA (their words, 2026-08-07).
//
// AN EXTRA is a photo the client never picked that the photographer decided to
// deliver anyway. It is recorded by `assets.is_extra`, set by
// POST /api/assets/[assetId]/final when the upload targets an unselected
// asset. Because nobody picked it, it carries no `selected_by`, and therefore
// has no person attached — which is exactly the gap this component fills, via
// `assets.delivered_for` (a SEPARATE column; see its own schema comment for
// why reusing `selected_by` would render an unpicked photo as somebody's
// active pick).
//
// TEXT-ONLY, deliberately, exactly like <SelectedPhotosList> (task #216) whose
// shape this mirrors: filenames and a person picker, never a thumbnail. That
// keeps R2 keys and presigned URLs out of this component entirely — the photos
// themselves are already right below in <GalleryWorkspace>'s grid.
//
// ONE FORM PER ROW rather than one form for the whole list. A single batched
// form would make assigning one person to one photo a submission that also
// re-writes every other row's attribution, which is a much larger blast radius
// than the action the photographer thinks they are taking — and it would make
// a validation failure on ANY row (e.g. a client removed from the gallery
// between render and submit) reject the entire batch.
//
// WHY THIS RENDERS ONLY IN `by-person` MODE: in `flat` mode the client's tray
// is a single list with no person rows at all, so there is nothing an
// attribution could change. Offering the control there would be asking the
// photographer to make a decision with no effect. This mirrors the owner's own
// framing — "SI está la opción de agrupación por persona, yo escogería…".
import { useActionState } from "react";
import {
  assignExtraToPerson,
  type AssignExtraToPersonState,
} from "@/app/dashboard/galleries/actions";

const initialState: AssignExtraToPersonState = { status: "idle" };

export type ExtraItem = {
  id: string;
  originalFilename: string;
  /** `assets.delivered_for` — the `users.id` this gift is assigned to, or
   * `null` for one the photographer has not attributed yet. Drives the
   * `<select>`'s starting value only; the next choice is whatever they pick. */
  deliveredFor: string | null;
};

export type ExtraPerson = {
  id: string;
  /** `name ?? email` — the SAME fallback every other person-shaped surface in
   * this app uses (src/lib/clients.ts, the gallery header's client rows,
   * `SelectionPicker.label`), so a client with no name never renders blank. */
  label: string;
};

function ExtraRow({ extra, people }: { extra: ExtraItem; people: ExtraPerson[] }) {
  const [state, formAction, pending] = useActionState(assignExtraToPerson, initialState);
  const selectId = `extra-person-${extra.id}`;

  return (
    <li className="flex flex-col gap-1">
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="assetId" value={extra.id} />
        <label htmlFor={selectId} className="text-fg-dim min-w-0 flex-1 truncate text-sm">
          {extra.originalFilename}
        </label>
        <select
          id={selectId}
          name="deliveredFor"
          defaultValue={extra.deliveredFor ?? ""}
          className="border-line-2 focus-visible:border-accent text-fg rounded-[5px] border bg-transparent px-3 py-2 text-sm transition-colors outline-none"
        >
          {/* The empty value is the "clear it" path, and it is FIRST so that
              an unattributed extra's `<select>` shows this rather than
              silently defaulting to whichever client happens to sort first —
              a wrong name is worse than an admitted blank. */}
          <option value="">Sin asignar</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
        >
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </form>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
      {state.status === "updated" && (
        <p role="status" className="text-accent-2 text-sm">
          Asignación actualizada.
        </p>
      )}
    </li>
  );
}

export function ExtrasPersonAssignment({
  extras,
  people,
}: {
  /** Every `is_extra` asset of this gallery. */
  extras: ExtraItem[];
  /** The gallery's ACTIVE clients — the same list the page header renders,
   * already filtered by `removedAt` upstream. The server action re-checks
   * membership itself against `gallery_clients`; this list only decides what
   * the picker OFFERS, and is never the gate. */
  people: ExtraPerson[];
}) {
  // Nothing to assign, or nobody to assign to — either way there is no
  // decision to present. A gallery with extras but zero attached clients is
  // reachable (a draft that was never attached), and rendering an empty
  // picker there would read as a broken control rather than an absent one.
  if (extras.length === 0 || people.length === 0) return null;

  return (
    <section className="border-line-2 mt-10 rounded-[6px] border p-4">
      <h2 className="text-fg text-sm font-medium">
        Fotos extra{" "}
        <span className="text-fg-mute font-normal">
          ({extras.length}
          {extras.length === 1 ? " foto" : " fotos"})
        </span>
      </h2>
      <p className="text-fg-dim mt-1 text-xs">
        Estas fotos no fueron elegidas por el cliente y se entregan igual, sin costo. Elegí a qué
        persona corresponde cada una.
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {extras.map((extra) => (
          <ExtraRow key={extra.id} extra={extra} people={people} />
        ))}
      </ul>
    </section>
  );
}
