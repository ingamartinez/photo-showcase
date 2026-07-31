"use client";

// Admin unlock action (task #73), rendered by the gallery detail page ONLY
// while `gallery.status === "selected"` — same "hiding is UX, not authority"
// stance documented on `isUnlockable()` in
// src/app/dashboard/galleries/actions.ts: `unlockSelection` re-checks the
// gallery's real status itself, on every call, regardless of what this
// component ever renders.
import { useActionState } from "react";
import { unlockSelection, type UnlockSelectionState } from "@/app/dashboard/galleries/actions";

const initialState: UnlockSelectionState = { status: "idle" };

export function UnlockSelectionPanel({ galleryId }: { galleryId: string }) {
  const [state, formAction, pending] = useActionState(unlockSelection, initialState);

  if (state.status === "unlocked") {
    return (
      <p role="status" className="text-accent-2 text-sm">
        Selección desbloqueada — el cliente puede volver a elegir, y le avisamos por correo.
      </p>
    );
  }

  // Distinct from the plain success case above: the state transition
  // already committed (the client CAN toggle again right now), but the
  // client themselves has no way to learn that on their own — see
  // `unlockSelection`'s own header comment for why this is surfaced as an
  // `alert`, not folded into the quiet `status` case above.
  if (state.status === "unlocked_email_failed") {
    return (
      <p role="alert" className="text-sm text-[#e0796b]">
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-xs flex-col items-end gap-2">
      {/* Task #133: no `.label` (globals.css's mono, uppercase,
          0.22em-tracked eyebrow style) survives under /dashboard — epic
          #125's own done-when. Plain text instead. */}
      <label htmlFor="unlock-reason" className="text-fg-dim w-full text-left text-xs">
        Nota (opcional)
      </label>
      <textarea
        id="unlock-reason"
        name="reason"
        rows={2}
        placeholder="Por qué desbloqueás esta selección…"
        className="border-line-2 w-full rounded-sm border bg-transparent px-3 py-2 text-sm"
      />
      <input type="hidden" name="galleryId" value={galleryId} />
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:border-accent hover:text-accent-2 min-h-11 rounded-[6px] border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
      >
        {pending ? "Desbloqueando…" : "Desbloquear selección"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
    </form>
  );
}
