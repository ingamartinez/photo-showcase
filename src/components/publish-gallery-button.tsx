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
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:border-accent hover:text-accent-2 min-h-11 rounded-[6px] border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
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
