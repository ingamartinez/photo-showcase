"use client";

// Publish action (task #21), rendered by the gallery detail page ONLY while
// `gallery.status === "draft"` — same "hiding is UX, not authority" stance
// documented on `isPublishable()` in
// src/app/dashboard/galleries/actions.ts: `publishGallery` re-checks the
// status and the asset count itself, on every call, regardless of what this
// component ever renders.
import { useActionState } from "react";
import { publishGallery, type PublishGalleryState } from "@/app/dashboard/galleries/actions";

const initialState: PublishGalleryState = { status: "idle" };

export function PublishGalleryButton({
  galleryId,
  clientEmails,
}: {
  galleryId: string;
  // Task #94: a gallery can have several clients now — every address in
  // this list got the same magic-link email, see publishGallery()'s own
  // header comment for how a partial send (some addresses fail, others
  // don't) is handled.
  clientEmails: string[];
}) {
  const [state, formAction, pending] = useActionState(publishGallery, initialState);

  if (state.status === "published") {
    return (
      <p role="status" className="text-accent-2 text-sm">
        Publicada — le enviamos un correo a {clientEmails.join(", ")}.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="galleryId" value={galleryId} />
      {/* Task #135 sweep: this used to be the marketing CTA — uppercase,
          0.1em-tracked, 13px. The mock's own plain `.btn`
          (design/system/dashboard.html:220-227) never uppercases or tracks a
          button label; its only states are a border and an `--app-raised`
          hover wash, never brass (epic #125's rule that brass is a fill,
          never a hover/focus wash). Brand tokens (`bg-bg-2`), not `app-*`,
          on purpose: this file is not named `dashboard-*` and does not live
          under `src/app/dashboard/**`, so task #175's ESLint rule correctly
          refuses `app-*` here even though the component only ever renders
          inside that scope — `bg-bg-2` IS `--app-raised`'s own value
          (globals.css's `--app-raised: var(--bg-2)` under
          `[data-surface="app"]`), so this reads identically without
          reaching for a token this file is not allowed to name. */}
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
      >
        {pending ? "Publicando…" : "Publicar galería"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
    </form>
  );
}
