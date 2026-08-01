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
      {/* Task #135 sweep: this used to be the marketing CTA — uppercase,
          0.1em-tracked, 13px — the same button shape as the public site's
          hero/header buttons. The mock's own plain `.btn`
          (design/system/dashboard.html:220-227) never uppercases or tracks a
          button label at all; its only states are a border and an
          `--app-raised` hover wash, never brass (epic #125's own rule that
          brass is a fill, never a hover/focus wash). Brand tokens
          (`bg-bg-2`), not `app-*`, on purpose: this file is not named
          `dashboard-*` and does not live under `src/app/dashboard/**`, so
          task #175's ESLint rule correctly refuses `app-*` here even though
          the component only ever renders inside that scope — `bg-bg-2` IS
          `--app-raised`'s own value (globals.css's `--app-raised: var(--bg-2)`
          under `[data-surface="app"]`), so this reads identically without
          reaching for a token this file is not allowed to name. */}
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
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
