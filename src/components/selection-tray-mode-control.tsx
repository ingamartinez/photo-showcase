"use client";

// Task #204 — the admin control for changing an EXISTING gallery's client-
// facing "Fotos elegidas" tray layout: `flat` (today's only behavior, one
// list) or `by-person` (one row per picker). Changeable at ANY gallery
// status — this is a presentation choice, not a commercial term, so unlike
// <EditGalleryTermsDialog> there is no before/after preview to protect and no
// `status` prop gating one.
//
// Deliberately NOT a dialog. <EditGalleryTermsDialog> hides its form behind a
// trigger because it is two numeric fields plus a before/after preview — real
// content worth folding away. A single two-option `<select>` has nothing
// comparable to hide; a dialog here would be ceremony over one control.
//
// Brand tokens (`border-line-2`, `bg-bg-2`, …), not `app-*`: this file lives
// under `src/components/`, not `src/app/dashboard/**`, and epic #125's own
// ESLint rule (task #175) only allows `app-*` utilities inside that
// directory — see <PublishGalleryButton>'s own comment for the identical
// reasoning, another `src/components/*` file rendered exclusively on this
// same dashboard page.
import { useActionState } from "react";
import {
  updateSelectionTrayMode,
  type UpdateSelectionTrayModeState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";

const initialState: UpdateSelectionTrayModeState = { status: "idle" };

export function SelectionTrayModeControl({
  galleryId,
  selectionTrayMode,
}: {
  galleryId: string;
  /** The gallery's CURRENT effective mode — read straight off
   * `GalleryDetail.selectionTrayMode` (src/lib/galleries.ts), never derived.
   * Used only as the `<select>`'s starting value; the admin's next pick is
   * whatever they choose from here. */
  selectionTrayMode: Gallery["selectionTrayMode"];
}) {
  const [state, formAction, pending] = useActionState(updateSelectionTrayMode, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="galleryId" value={galleryId} />
      <label htmlFor="selection-tray-mode" className="text-fg-mute text-xs tracking-wide uppercase">
        Bandeja de elegidas
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="selection-tray-mode"
          name="selectionTrayMode"
          defaultValue={selectionTrayMode}
          className="border-line-2 focus-visible:border-accent text-fg rounded-[5px] border bg-transparent px-3 py-2 text-sm transition-colors outline-none"
        >
          <option value="flat">Lista simple</option>
          <option value="by-person">Agrupada por persona</option>
        </select>
        <button
          type="submit"
          disabled={pending}
          className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
        >
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
      {state.status === "updated" && (
        <p role="status" className="text-accent-2 text-sm">
          Modo actualizado.
        </p>
      )}
    </form>
  );
}
