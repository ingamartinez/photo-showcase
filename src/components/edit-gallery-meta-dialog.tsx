"use client";

// Task #281 — the admin control for correcting an EXISTING gallery's title and
// session date. Follows `edit-gallery-terms-dialog.tsx` (task #200) for the
// portal/brand-token reasoning and the no-auto-close decision; see that file's
// header comment rather than re-explaining it here.
//
// The fields are CONTROLLED, not `defaultValue`: React 19 auto-resets a form's
// uncontrolled inputs after its action resolves, INCLUDING when it resolves
// with an error state — which would wipe exactly what the admin typed at the
// moment the dialog is telling them to fix it. Controlled state survives that
// reset, and `handleOpenChange(true)` still seeds it from the props, so
// abandoned edits are discarded on every open.
//
// `sessionDate` is a `YYYY-MM-DD` STRING end to end, initialised from the prop
// verbatim: never `new Date(...)`, never `toISOString`, never
// `toLocaleDateString` — the column is a `date()` in string mode and any
// `Date` round-trip can shift the day across a timezone.
import { useActionState, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { updateGalleryMeta, type UpdateGalleryMetaState } from "@/app/dashboard/galleries/actions";

const initialState: UpdateGalleryMetaState = { status: "idle" };

// Same literal stand-ins as gallery-form.tsx's own `inputClass` — this form
// renders through the identical portal, outside `[data-surface="app"]`, for the
// identical reason (see edit-gallery-terms-dialog.tsx's header comment).
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-[5px] border bg-transparent px-4 py-3 text-sm transition-colors outline-none";

export function EditGalleryMetaDialog({
  galleryId,
  title,
  sessionDate,
}: {
  galleryId: string;
  title: string;
  sessionDate: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateGalleryMeta, initialState);

  const [titleInput, setTitleInput] = useState(title);
  const [sessionDateInput, setSessionDateInput] = useState(sessionDate);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setTitleInput(title);
      setSessionDateInput(sessionDate);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger className="text-fg-dim hover:text-accent-2 text-xs underline transition-colors">
        Editar galería
      </DialogTrigger>

      <DialogContent className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-fg text-lg font-medium">Editar galería</DialogTitle>
          <DialogDescription className="text-fg-dim">
            Se guarda al instante, en cualquier estado de la galería. La app no le avisa al cliente
            — coordinalo por fuera.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="galleryId" value={galleryId} />

          <div className="flex flex-col gap-2">
            <label
              htmlFor="edit-meta-title"
              className="text-fg-mute text-xs tracking-wide uppercase"
            >
              Título
            </label>
            <input
              id="edit-meta-title"
              name="title"
              type="text"
              required
              placeholder="Boda Ana y Beto"
              value={titleInput}
              onChange={(event) => setTitleInput(event.target.value)}
              aria-invalid={state.status === "error"}
              aria-describedby={state.status === "error" ? "edit-meta-error" : undefined}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="edit-meta-session-date"
              className="text-fg-mute text-xs tracking-wide uppercase"
            >
              Fecha de la sesión
            </label>
            <input
              id="edit-meta-session-date"
              name="sessionDate"
              type="date"
              required
              value={sessionDateInput}
              onChange={(event) => setSessionDateInput(event.target.value)}
              aria-invalid={state.status === "error"}
              aria-describedby={state.status === "error" ? "edit-meta-error" : undefined}
              className={inputClass}
            />
          </div>

          {state.status === "error" && (
            <p id="edit-meta-error" role="alert" className="text-danger text-sm">
              {state.message}
            </p>
          )}
          {state.status === "updated" && (
            <p role="status" className="text-accent-2 text-sm">
              Galería actualizada.
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
      </DialogContent>
    </Dialog>
  );
}
