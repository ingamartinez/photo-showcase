"use client";

// Deliver action (task #27), rendered by <GalleryWorkspace> — which owns the
// live asset list — and gated on its `canDeliver` prop, i.e. only while
// `gallery.status === "selected"`. Task #86 moved it here from the gallery
// detail page: as a sibling of the workspace it was fed a pending-finals count
// computed once at page render, so it stayed disabled after the last final
// uploaded while the counter beside it already said everything was in. Reading
// the workspace's own live count is what stops those two ever disagreeing.
// Same "hiding is UX, not authority" stance
// documented on `isDeliverable()` in
// src/app/dashboard/galleries/actions.ts: `deliverGallery` re-checks the
// gallery's real status AND every selected asset's own `finalKey` itself, on
// every call, regardless of what this component ever renders.
import { useActionState } from "react";
import { deliverGallery, type DeliverGalleryState } from "@/app/dashboard/galleries/actions";

const initialState: DeliverGalleryState = { status: "idle" };

export function DeliverGalleryButton({
  galleryId,
  clientEmails,
  pendingFinalsCount,
}: {
  galleryId: string;
  // Task #94: a gallery can have several clients now — every address in
  // this list got the delivery email, see deliverGallery()'s own header
  // comment for how a partial send is handled.
  clientEmails: string[];
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
        Entregada — le enviamos un correo a {clientEmails.join(", ")}.
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
        disabled={pending || blockedByMissingFinals}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
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
