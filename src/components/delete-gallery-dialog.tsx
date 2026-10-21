"use client";

// Task #282 — the confirm-before-delete dialog for a gallery. Same
// trigger-behind-a-dialog shape as `edit-gallery-terms-dialog.tsx`: this file
// renders through <DialogContent>'s portal to `document.body`, OUTSIDE
// `[data-surface="app"]`, so it uses brand tokens and literal Tailwind values
// and never an `app-*` utility (see `dashboard-gallery-create-dialog.tsx`'s
// own header for the full reasoning).
//
// The typed title is UX, not authority. It exists so a mis-click cannot erase
// a gallery, and that is all the server assumes about it: `deleteGallery`
// takes an id, validates it, and never receives this text. The `matches`
// guard therefore lives in the SUBMIT HANDLER as well as on the disabled
// button — a disabled attribute alone does not cover every submit path
// (a form can be submitted programmatically), and the component test proves
// exactly that.
//
// On success it navigates to the list whatever `r2Failures` is (owner
// decision, 2026-10-20): a leaked orphan is unreachable and costs only
// storage, and the photographer cannot act on the number, so silence matches
// the flash and bulk-delete precedents.
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { deleteGallery, type DeleteGalleryResult } from "@/app/dashboard/galleries/actions";

// Same literal stand-in as the terms dialog's own `inputClass`: this form
// renders through the identical portal, outside `[data-surface="app"]`.
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-[5px] border bg-transparent px-4 py-3 text-sm transition-colors outline-none";

export function DeleteGalleryDialog({ galleryId, title }: { galleryId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  // Case- and accent-sensitive: "el título exacto" is the owner's decision.
  // Trimming only forgives paste whitespace at the edges — the stored title
  // itself was already trimmed by the create schema.
  const matches = typed.trim() === title;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Reset on every open: never carry a previous session's typed
      // confirmation (or a stale error) into a fresh attempt.
      setTyped("");
      setMessage("");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches) return;

    startTransition(async () => {
      const result: DeleteGalleryResult = await deleteGallery(galleryId);
      if (result.ok) {
        router.push("/dashboard/galleries");
      } else {
        setMessage(result.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger className="text-danger text-xs underline transition-colors">
        Eliminar galería
      </DialogTrigger>

      <DialogContent className="border-line-2 gap-5 border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-danger text-lg font-medium">Eliminar galería</DialogTitle>
          <DialogDescription className="text-fg-dim">
            Se borran la galería, todas sus fotos y el acceso de sus clientes. Los clientes no se
            borran. No se puede deshacer.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="delete-gallery-title"
              className="text-fg-mute text-xs tracking-wide uppercase"
            >
              Escribe el título de la galería para confirmar: «{title}»
            </label>
            <input
              id="delete-gallery-title"
              name="title"
              type="text"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className={inputClass}
            />
          </div>

          {message !== "" && (
            <p role="alert" className="text-danger text-sm">
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={!matches || pending}
            className="border-line-2 text-danger hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Eliminando…" : "Eliminar galería"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
