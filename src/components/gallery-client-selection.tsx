"use client";

// Per-client selection status and admin actions for one row of the gallery
// detail page (epic #239, task #242). Rendered by <GalleryClientRow> under the
// name/email line: how many photos this person holds, what state they are in
// (Eligiendo / Envió el … / Bloqueado por vos), and the buttons that are VALID
// for that state — lock, unlock, remove picks.
//
// Hiding a button is UX, never the authority: each server action re-checks the
// admin session, the gallery status and the client's active membership itself.
// `clientLockActions` is the same pure predicate the page can reason about; it
// lives in a module without `server-only` so this Client Component can import it.
//
// "Quitar fotos" is destructive (it wipes the person's picks and reopens their
// selection) and asks for a confirmation that says exactly that. No email goes
// out for lock or remove; unlock emails THAT person, best-effort — a failed
// email is shown as an alert so the photographer can warn them another way.
import { useActionState, useState } from "react";
import {
  lockGalleryClientSelection,
  removeGalleryClientPicks,
  unlockGalleryClientSelection,
  type GalleryClientSelectionActionState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";
import {
  clientLockActions,
  clientPickCountLabel,
  clientSelectionStateLabel,
  type ClientSelectionView,
} from "@/lib/client-selection-state";

const idle: GalleryClientSelectionActionState = { status: "idle" };

const BUTTON =
  "border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6";

export function GalleryClientSelection({
  galleryId,
  clientId,
  galleryStatus,
  selection,
}: {
  galleryId: string;
  clientId: string;
  galleryStatus: Gallery["status"];
  selection: ClientSelectionView;
}) {
  const [lockState, lockAction, lockPending] = useActionState(lockGalleryClientSelection, idle);
  const [unlockState, unlockAction, unlockPending] = useActionState(
    unlockGalleryClientSelection,
    idle,
  );
  const [removeState, removeAction, removePending] = useActionState(removeGalleryClientPicks, idle);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const actions = clientLockActions({
    galleryStatus,
    state: selection.state,
    pickCount: selection.pickCount,
  });

  const hidden = (
    <>
      <input type="hidden" name="galleryId" value={galleryId} />
      <input type="hidden" name="clientId" value={clientId} />
    </>
  );

  return (
    <div className="flex flex-col gap-2 pb-1">
      <p className="text-fg-mute text-xs">
        {clientPickCountLabel(selection.pickCount)} ·{" "}
        {clientSelectionStateLabel(selection.state, selection.submittedOn)}
      </p>

      {(actions.canLock || actions.canUnlock || actions.canRemovePicks) && (
        <div className="flex flex-wrap gap-2">
          {actions.canLock && (
            <form action={lockAction}>
              {hidden}
              <button type="submit" disabled={lockPending} className={BUTTON}>
                {lockPending ? "Bloqueando…" : "Bloquear"}
              </button>
            </form>
          )}
          {actions.canUnlock && (
            <form action={unlockAction}>
              {hidden}
              <button type="submit" disabled={unlockPending} className={BUTTON}>
                {unlockPending ? "Desbloqueando…" : "Desbloquear"}
              </button>
            </form>
          )}
          {actions.canRemovePicks && !confirmingRemove && (
            <button type="button" onClick={() => setConfirmingRemove(true)} className={BUTTON}>
              Quitar fotos
            </button>
          )}
        </div>
      )}

      {actions.canRemovePicks && confirmingRemove && (
        <form action={removeAction} className="flex flex-col items-start gap-2">
          {hidden}
          <p className="text-danger text-xs">
            Se van a quitar las fotos que eligió esta persona y se reabre su selección. No se le
            avisa por correo.
          </p>
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={removePending}
              className="text-danger min-h-11 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
            >
              {removePending ? "Quitando…" : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemove(false)}
              className="text-fg-dim hover:text-accent-2 min-h-11 text-sm transition-colors lg:min-h-6"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {[lockState, unlockState, removeState].map((state, index) =>
        state.status === "error" || state.status === "done_email_failed" ? (
          <p key={index} role="alert" className="text-danger text-xs">
            {state.message}
          </p>
        ) : state.status === "done" ? (
          <p key={index} role="status" className="text-accent-2 text-xs">
            {state.message}
          </p>
        ) : null,
      )}
    </div>
  );
}
