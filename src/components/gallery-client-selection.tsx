"use client";

// Per-client selection status and admin actions for one row of the gallery
// detail page (epic #239, task #242).
//
// TWO PIECES, ONE CONTROLLER. <GalleryClientRow> owns the row's single 44px
// "Acciones" (⋯) menu, so the lock / unlock / remove-picks entries live in
// THAT menu (<ClientSelectionMenuItems>) rather than as a second set of small
// buttons on the row. The inline part (<GalleryClientSelection>) shows the pick
// count + state line, the destructive confirmation and the latest result. Both
// share one controller (`useClientSelectionController`), called by the row.
//
// ONE `useActionState` FOR ALL THREE ACTIONS. Their results are mutually
// exclusive in meaning ("Bloqueamos…" then "Desbloqueamos…" must not both be
// on screen), and a single state is, by construction, the most recent result.
// The runner picks the server action from a hidden `op` field.
//
// Hiding an entry is UX, never the authority: each server action re-checks the
// admin session, the gallery status and the client's active membership.
import { useActionState, useRef, useState } from "react";
import {
  lockGalleryClientSelection,
  removeGalleryClientPicks,
  unlockGalleryClientSelection,
  type GalleryClientSelectionActionState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";
import {
  clientLockActions,
  clientOrderTallyLabel,
  clientPickCountLabel,
  clientSelectionStateLabel,
  type ClientSelectionView,
} from "@/lib/client-selection-state";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

type Op = "lock" | "unlock" | "remove";

const idle: GalleryClientSelectionActionState = { status: "idle" };

export function useClientSelectionController() {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (
      prev: GalleryClientSelectionActionState,
      formData: FormData,
    ): Promise<GalleryClientSelectionActionState> => {
      const op = formData.get("op") as Op;
      const run =
        op === "lock"
          ? lockGalleryClientSelection
          : op === "unlock"
            ? unlockGalleryClientSelection
            : removeGalleryClientPicks;
      const result = await run(prev, formData);
      // The destructive step is done (or the server refused it): either way
      // the confirmation prompt must not linger and invite a second wipe.
      if (op === "remove" && result.status !== "idle") setConfirming(false);
      return result;
    },
    idle,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const opRef = useRef<HTMLInputElement>(null);

  /** Lock / unlock: no confirmation, submit the hidden form right away. */
  function submit(op: "lock" | "unlock") {
    if (opRef.current) opRef.current.value = op;
    formRef.current?.requestSubmit();
  }

  return { state, formAction, pending, confirming, setConfirming, formRef, opRef, submit };
}

export type ClientSelectionController = ReturnType<typeof useClientSelectionController>;

/** Whether the ⋯ menu would have any per-client selection entry. */
export function hasClientSelectionActions(
  galleryStatus: Gallery["status"],
  selection: ClientSelectionView | undefined,
): boolean {
  if (!selection) return false;
  const actions = clientLockActions({
    galleryStatus,
    state: selection.state,
    pickCount: selection.pickCount,
  });
  return actions.canLock || actions.canUnlock || actions.canRemovePicks;
}

/** The entries added to the row's ⋯ menu. Render INSIDE <DropdownMenuContent>. */
export function ClientSelectionMenuItems({
  galleryStatus,
  selection,
  controller,
}: {
  galleryStatus: Gallery["status"];
  selection: ClientSelectionView;
  controller: ClientSelectionController;
}) {
  const actions = clientLockActions({
    galleryStatus,
    state: selection.state,
    pickCount: selection.pickCount,
  });
  return (
    <>
      {actions.canLock && (
        <DropdownMenuItem disabled={controller.pending} onSelect={() => controller.submit("lock")}>
          Bloquear selección
        </DropdownMenuItem>
      )}
      {actions.canUnlock && (
        <DropdownMenuItem
          disabled={controller.pending}
          onSelect={() => controller.submit("unlock")}
        >
          Desbloquear selección
        </DropdownMenuItem>
      )}
      {actions.canRemovePicks && (
        // Distinct from "Quitar" (removes the PERSON from the gallery): this
        // only wipes their picks.
        <DropdownMenuItem variant="destructive" onSelect={() => controller.setConfirming(true)}>
          Quitar sus fotos elegidas
        </DropdownMenuItem>
      )}
    </>
  );
}

export function GalleryClientSelection({
  galleryId,
  clientId,
  galleryStatus,
  selection,
  controller,
}: {
  galleryId: string;
  clientId: string;
  galleryStatus: Gallery["status"];
  selection: ClientSelectionView;
  controller: ClientSelectionController;
}) {
  const { state, formAction, pending, confirming, setConfirming, formRef, opRef } = controller;
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
        {selection.order
          ? clientOrderTallyLabel(selection.order)
          : clientPickCountLabel(selection.pickCount)}{" "}
        · {clientSelectionStateLabel(selection.state, selection.submittedOn)}
      </p>

      {/* No visible submit control — the ⋯ menu items submit this through a
          ref, exactly like the row's "Reenviar acceso" form. */}
      <form ref={formRef} action={formAction}>
        {hidden}
        <input ref={opRef} type="hidden" name="op" defaultValue="lock" />
      </form>

      {actions.canRemovePicks && confirming && (
        <form action={formAction} className="flex flex-col items-start gap-2">
          {hidden}
          <input type="hidden" name="op" value="remove" />
          <p className="text-danger text-xs">
            Se van a quitar las fotos que eligió esta persona y se reabre su selección. No se le
            avisa por correo.
          </p>
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={pending}
              className="text-danger min-h-11 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
            >
              {pending ? "Quitando…" : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-fg-dim hover:text-accent-2 min-h-11 text-sm transition-colors lg:min-h-6"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Only the MOST RECENT result, never a stack of stale ones. */}
      {(state.status === "error" || state.status === "done_email_failed") && (
        <p role="alert" className="text-danger text-xs">
          {state.message}
        </p>
      )}
      {state.status === "done" && (
        <p role="status" className="text-accent-2 text-xs">
          {state.message}
        </p>
      )}
    </div>
  );
}
