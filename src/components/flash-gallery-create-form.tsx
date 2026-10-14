"use client";

// Create form for a flash gallery (epic #232 / task #233): a title and an
// optional date — nothing else, because a flash gallery has no package, price
// or client requirement. On success it sends the admin to the detail page,
// where the photos are uploaded and the gallery is shared.
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createFlashGallery, type CreateFlashGalleryState } from "@/app/dashboard/flash/actions";

const initialState: CreateFlashGalleryState = { status: "idle" };

const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute text-sm rounded-[5px] border bg-transparent px-4 py-3 transition-colors outline-none";

export function FlashGalleryCreateForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(createFlashGallery, initialState);

  useEffect(() => {
    if (state.status === "created") {
      router.push(`/dashboard/flash/${state.flashGalleryId}`);
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-1">
        <label htmlFor="flash-title" className="text-fg-mute text-xs">
          Título
        </label>
        <input
          id="flash-title"
          name="title"
          type="text"
          required
          maxLength={200}
          placeholder="Ej. Fotos del cumpleaños de Sofía"
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "flash-create-error" : undefined}
          className={inputClass}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="flash-session-date" className="text-fg-mute text-xs">
          Fecha (opcional)
        </label>
        <input id="flash-session-date" name="sessionDate" type="date" className={inputClass} />
      </div>
      <button
        type="submit"
        disabled={pending || state.status === "created"}
        className="bg-accent text-ink hover:bg-accent-2 inline-flex min-h-11 items-center justify-center rounded-[5px] px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Creando…" : "Crear galería flash"}
      </button>
      {state.status === "error" && (
        <p id="flash-create-error" role="alert" className="text-danger text-xs sm:basis-full">
          {state.message}
        </p>
      )}
    </form>
  );
}
