"use client";

// Per-client selection status and admin actions for one row of the gallery
// detail page (epic #239, task #242; rewritten by epic #250, task #263).
//
// TWO PIECES, ONE CONTROLLER. <GalleryClientRow> owns the row's single 44px
// "Acciones" (⋯) menu, so the lock / unlock / remove-picks entries live in
// THAT menu (<ClientSelectionMenuItems>) rather than as a second set of small
// buttons on the row. The inline part (<GalleryClientSelection>) shows the
// per-person tally, the destructive confirmations and the latest result. Both
// share one controller (`useClientSelectionController`), called by the row.
//
// ONE `useActionState` FOR ALL THREE ACTIONS. Their results are mutually
// exclusive in meaning ("Bloqueamos…" then "Desbloqueamos…" must not both be
// on screen), and a single state is, by construction, the most recent result.
// The runner picks the server action from a hidden `op` field.
//
// TWO OF THE THREE ACTIONS NOW ASK FIRST (task #263):
//   - `lock` claims the person's cart at their name (decision 18), so it moves
//     money between people and MUST show the before/after the action will
//     produce. The numbers come from `previewByClient[clientId].lock`, which
//     runs the SAME planner `lockGalleryClientSelection` executes.
//   - `remove` deletes every pick of that person and re-resolves the assets,
//     previewed the same way from `.removePicks`.
//   - `unlock` moves no money, so it still submits straight away.
//
// The preview is computed AT RENDER. If another write lands before Confirm,
// the executed `delta` the action answers with is the truth and is rendered in
// its place under `role="status"` — the preview never blocks the action.
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
  clientPersonTallyLabel,
  clientSelectionStateLabel,
  formatAttributionShare,
  type ClientSelectionView,
} from "@/lib/client-selection-state";
import { formatCop } from "@/lib/format";
import type { AttributionDelta } from "@/lib/pick-plans";
import { UNATTRIBUTED_PICKER_LABEL } from "@/lib/selection-snapshot";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

type Op = "lock" | "unlock" | "remove";

const idle: GalleryClientSelectionActionState = { status: "idle" };

export function useClientSelectionController() {
  // WHICH confirmation is open, not just whether one is: lock and remove are
  // different destructive steps with different previews and different hidden
  // `op` values, and one boolean cannot say which one to render.
  const [confirming, setConfirming] = useState<Op | null>(null);
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
      if (op !== "unlock" && result.status !== "idle") setConfirming(null);
      return result;
    },
    idle,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const opRef = useRef<HTMLInputElement>(null);

  /** Unlock: no confirmation and no money, submit the hidden form right away. */
  function submit(op: "unlock") {
    if (opRef.current) opRef.current.value = op;
    formRef.current?.requestSubmit();
  }

  return {
    state,
    formAction,
    pending,
    confirming,
    setConfirming,
    formRef,
    opRef,
    submit,
  };
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
    locked: selection.locked,
    sent: selection.sent,
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
    locked: selection.locked,
    sent: selection.sent,
    pickCount: selection.pickCount,
  });
  return (
    <>
      {actions.canLock && (
        // Asks for confirmation first — see this file's header comment. The
        // menu CLOSES before the prompt renders, so the confirm button and the
        // menu's destructive red are never on screen together.
        <DropdownMenuItem
          disabled={controller.pending}
          onSelect={() => controller.setConfirming("lock")}
        >
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
        <DropdownMenuItem variant="destructive" onSelect={() => controller.setConfirming("remove")}>
          Quitar sus fotos elegidas
        </DropdownMenuItem>
      )}
    </>
  );
}

/**
 * The admin's BEFORE/AFTER: who moves, by how much, and the gallery's own
 * surcharge. The frame is #214's — "Hoy: … / Al confirmar: …" — the same one
 * <AllowsOriginalSelectionControl> uses for a money-affecting change, so the
 * two read as one feature. `people` only lists the people whose share actually
 * moves (that is what `AttributionDelta` means); "Sin registro" appears only
 * when the unattributed bucket really differs.
 */
function DeltaPreview({ delta }: { delta: AttributionDelta }) {
  const unattributed = delta.unattributed;
  if (delta.people.length === 0 && !unattributed) {
    return <p className="text-fg-mute text-xs">No cambia ningún número.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {delta.people.map((person) => (
        <div key={person.userId} data-testid="delta-person">
          <p className="text-fg text-xs font-medium">{person.label}</p>
          <p className="text-fg-dim text-xs">Hoy: {formatAttributionShare(person.before)}</p>
          <p className="text-fg text-xs">Al confirmar: {formatAttributionShare(person.after)}</p>
        </div>
      ))}
      {unattributed && (
        <div data-testid="delta-unattributed">
          <p className="text-fg text-xs font-medium">{UNATTRIBUTED_PICKER_LABEL}</p>
          <p className="text-fg-dim text-xs">Hoy: {formatAttributionShare(unattributed.before)}</p>
          <p className="text-fg text-xs">
            Al confirmar: {formatAttributionShare(unattributed.after)}
          </p>
        </div>
      )}
      <p className="text-fg-dim text-xs">
        Recargo de la galería: Hoy {formatCop(delta.gallery.before.surchargeCop)} · Al confirmar{" "}
        {formatCop(delta.gallery.after.surchargeCop)}
      </p>
    </div>
  );
}

/** The EXECUTED delta the action answered with, when the page's preview may
 * be stale. Same formatter as the preview, so the two cannot read differently
 * — only one of them is guaranteed to describe what actually happened. */
function ExecutedDelta({ delta }: { delta: AttributionDelta }) {
  const parts = delta.people.map(
    (person) => `${person.label}: ${formatAttributionShare(person.after)}`,
  );
  const unattributed = delta.unattributed
    ? `${UNATTRIBUTED_PICKER_LABEL}: ${formatAttributionShare(delta.unattributed.after)}`
    : null;
  const body = [...parts, ...(unattributed ? [unattributed] : [])].join(" · ");
  return (
    <p role="status" className="text-accent-2 text-xs" data-testid="executed-delta">
      Quedó: {body || "sin cambios"} · recargo de la galería{" "}
      {formatCop(delta.gallery.after.surchargeCop)}
    </p>
  );
}

export function GalleryClientSelection({
  galleryId,
  clientId,
  galleryStatus,
  selection,
  preview,
  controller,
}: {
  galleryId: string;
  clientId: string;
  galleryStatus: Gallery["status"];
  selection: ClientSelectionView;
  /** This person's lock / remove-picks before/after, from
   * `getDashboardSelection(...).previewByClient[clientId]`. */
  preview?: { lock: AttributionDelta; removePicks: AttributionDelta };
  controller: ClientSelectionController;
}) {
  const { state, formAction, pending, confirming, setConfirming, formRef, opRef } = controller;
  const actions = clientLockActions({
    galleryStatus,
    locked: selection.locked,
    sent: selection.sent,
    pickCount: selection.pickCount,
  });

  const hidden = (
    <>
      <input type="hidden" name="galleryId" value={galleryId} />
      <input type="hidden" name="clientId" value={clientId} />
    </>
  );

  const delta = confirming === "lock" ? preview?.lock : preview?.removePicks;

  return (
    <div className="flex flex-col gap-2 pb-1">
      {/* Decision 14's four numbers, unconditional since #250 (decision 11 made
          the order semantics mandatory, so the rolling-delivery gate went).
          "a su nombre" is the tooltip, never the label — "pedidas" is the
          approved word (owner answer, 2026-10-18). */}
      <p className="text-fg-mute text-xs" title="Las fotos pedidas quedan a su nombre">
        {clientPersonTallyLabel(selection.person)} ·{" "}
        {clientSelectionStateLabel(selection.state, selection.submittedOn)}
      </p>

      {/* No visible submit control — the ⋯ menu items submit this through a
          ref, exactly like the row's "Reenviar acceso" form. */}
      <form ref={formRef} action={formAction}>
        {hidden}
        <input ref={opRef} type="hidden" name="op" defaultValue="unlock" />
      </form>

      {actions.canLock && confirming === "lock" && (
        <form action={formAction} className="flex flex-col items-start gap-2">
          {hidden}
          <input type="hidden" name="op" value="lock" />
          <p className="text-danger text-xs">
            Se reclaman a su nombre las fotos que tiene por enviar y no va a poder seguir eligiendo.
            No se le avisa por correo.
          </p>
          {delta && <DeltaPreview delta={delta} />}
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={pending}
              className="text-danger min-h-11 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
            >
              {pending ? "Bloqueando…" : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="text-fg-dim hover:text-accent-2 min-h-11 text-sm transition-colors lg:min-h-6"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {actions.canRemovePicks && confirming === "remove" && (
        <form action={formAction} className="flex flex-col items-start gap-2">
          {hidden}
          <input type="hidden" name="op" value="remove" />
          <p className="text-danger text-xs">
            Se van a quitar las fotos que eligió esta persona y se reabre su selección. No se le
            avisa por correo.
          </p>
          {delta && <DeltaPreview delta={delta} />}
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
              onClick={() => setConfirming(null)}
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
      {/* The EXECUTED before/after, from the rows the action really wrote —
          the truth happens to disagree with the render-time preview whenever
          somebody else wrote in between. */}
      {state.status === "done" && state.delta && <ExecutedDelta delta={state.delta} />}
    </div>
  );
}
