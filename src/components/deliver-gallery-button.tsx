"use client";

// Deliver action (task #27), rendered by the gallery detail page ONLY while
// `gallery.status === "selected"` — same "hiding is UX, not authority" stance
// documented on `isDeliverable()` in
// src/app/dashboard/galleries/actions.ts: `deliverGallery` re-checks the
// gallery's real status AND every selected asset's own `finalKey` itself, on
// every call, regardless of what this component ever renders.
import { useActionState } from "react";
import { deliverGallery, type DeliverGalleryState } from "@/app/dashboard/galleries/actions";

const initialState: DeliverGalleryState = { status: "idle" };

export function DeliverGalleryButton({
  galleryId,
  clientEmail,
  pendingFinalsCount,
}: {
  galleryId: string;
  clientEmail: string;
  // Server-computed count of selected assets still missing a final (same
  // number <GalleryWorkspace>'s own live counter shows, task #26) — used
  // ONLY to disable the button and explain why, never as the actual guard.
  // `deliverGallery` refuses the same delivery even if this were wrong or
  // stale.
  pendingFinalsCount: number;
}) {
  const [state, formAction, pending] = useActionState(deliverGallery, initialState);

  if (state.status === "delivered") {
    return (
      <p role="status" className="text-accent-2 text-sm">
        Entregada — le enviamos un correo a {clientEmail}.
      </p>
    );
  }

  // Distinct from the plain success case above: the state transition already
  // committed (the gallery IS delivered), but the client themselves has no
  // way to learn that on their own — same "surfaced distinctly, never
  // swallowed" stance as unlockSelection's own `unlocked_email_failed` case.
  if (state.status === "delivered_email_failed") {
    return (
      <p role="alert" className="text-sm text-[#e0796b]">
        {state.message}
      </p>
    );
  }

  const blockedByMissingFinals = pendingFinalsCount > 0;

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="galleryId" value={galleryId} />
      <button
        type="submit"
        disabled={pending || blockedByMissingFinals}
        className="border-line-2 hover:border-accent hover:text-accent-2 rounded-sm border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Entregando…" : "Entregar galería"}
      </button>
      {blockedByMissingFinals && (
        <p className="text-fg-mute max-w-xs text-right text-xs">
          Subí los finales que faltan antes de poder entregar la galería.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
    </form>
  );
}
