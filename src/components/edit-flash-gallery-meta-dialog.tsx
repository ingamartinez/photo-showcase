"use client";

// Task #283 — the admin control for correcting an existing flash gallery's
// title and date. Same trigger-behind-a-dialog shape as
// edit-gallery-terms-dialog.tsx, and the SAME portal reasoning applies:
// <DialogContent> portals to `document.body`, outside `[data-surface="app"]`,
// so this file stays on brand tokens and literal Tailwind values, never
// `app-*`. See that file's own header comment for the fuller record.
//
// Like the terms dialog, this one does NOT auto-close on success: the success
// message renders inside the still-open dialog, where the form already is.
// Unlike it, the form state lives in an inner component: Radix unmounts
// <DialogContent> on close, so every open remounts the form from the gallery's
// CURRENT props — no leftover success/error message and no stale typed values.
import { useActionState, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  updateFlashGalleryMeta,
  type UpdateFlashGalleryMetaState,
} from "@/app/dashboard/flash/actions";

const initialState: UpdateFlashGalleryMetaState = { status: "idle" };

// Same literal stand-ins as edit-gallery-terms-dialog.tsx's own `inputClass` —
// this form renders through the identical portal, for the identical reason.
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-[5px] border bg-transparent px-4 py-3 text-sm transition-colors outline-none";

export function EditFlashGalleryMetaDialog({
  flashGalleryId,
  title,
  sessionDate,
}: {
  flashGalleryId: string;
  title: string;
  /** `YYYY-MM-DD` or null. Passed straight through, never through `new Date()`. */
  sessionDate: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="text-fg-dim hover:text-accent-2 text-xs underline transition-colors">
        Editar
      </DialogTrigger>

      <DialogContent className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-fg text-lg font-medium">Editar título y fecha</DialogTitle>
          <DialogDescription className="text-fg-dim">
            El enlace de la galería no cambia.
          </DialogDescription>
        </DialogHeader>

        <EditFlashGalleryMetaForm
          flashGalleryId={flashGalleryId}
          title={title}
          sessionDate={sessionDate}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditFlashGalleryMetaForm({
  flashGalleryId,
  title,
  sessionDate,
}: {
  flashGalleryId: string;
  title: string;
  sessionDate: string | null;
}) {
  const [state, formAction, pending] = useActionState(updateFlashGalleryMeta, initialState);

  // Controlled, not `defaultValue`: React 19 resets an uncontrolled form after
  // a server action, which would wipe what the admin typed whenever the server
  // returns an error. Initialised from the gallery's current values on mount.
  const [titleInput, setTitleInput] = useState(title);
  const [sessionDateInput, setSessionDateInput] = useState(sessionDate ?? "");

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="flashGalleryId" value={flashGalleryId} />

      <div className="flex flex-col gap-2">
        <label htmlFor="edit-flash-title" className="text-fg-mute text-xs tracking-wide uppercase">
          Título
        </label>
        <input
          id="edit-flash-title"
          name="title"
          type="text"
          required
          maxLength={200}
          value={titleInput}
          onChange={(event) => setTitleInput(event.target.value)}
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "edit-flash-meta-error" : undefined}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="edit-flash-session-date"
          className="text-fg-mute text-xs tracking-wide uppercase"
        >
          Fecha (opcional)
        </label>
        <div className="flex gap-2">
          <input
            id="edit-flash-session-date"
            name="sessionDate"
            type="date"
            value={sessionDateInput}
            onChange={(event) => setSessionDateInput(event.target.value)}
            aria-invalid={state.status === "error"}
            aria-describedby={state.status === "error" ? "edit-flash-meta-error" : undefined}
            className={`${inputClass} flex-1`}
          />
          {/* Not every browser's native date picker can be cleared back to
              empty (iOS Safari is the one the plan flagged). This posts `""`,
              which the action maps to NULL, exactly like leaving it blank. */}
          {sessionDateInput !== "" && (
            <button
              type="button"
              onClick={() => setSessionDateInput("")}
              className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-3 text-sm transition-colors"
            >
              Quitar fecha
            </button>
          )}
        </div>
      </div>

      {state.status === "error" && (
        <p id="edit-flash-meta-error" role="alert" className="text-danger text-sm">
          {state.message}
        </p>
      )}
      {state.status === "updated" && (
        <p role="status" className="text-accent-2 text-sm">
          Cambios guardados.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Guardar"}
      </button>
    </form>
  );
}
