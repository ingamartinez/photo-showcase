"use client";

// Task #287 — the recovery affordance for a reopen whose PHYSICAL cleanup did
// not finish.
//
// WHY THIS IS A SEPARATE COMPONENT FROM THE REOPEN PANEL. The reopen action
// commits the whole database reset and then drains a durable
// `gallery_final_cleanup` obligation afterwards. If that drain fails, the
// gallery really is reopened — it lands in `proofing` — so the delivered-only
// trigger that started it is GONE by the time the admin reloads, and the
// pending obligation would disappear with it. This component is rendered by
// the gallery detail page whenever the server-side read
// (`readGalleryFinalCleanup`) returns a row, whatever the gallery's status is,
// so the obligation survives a refresh and the delivered panel unmounting.
// Plan v3 §3 requires exactly that.
//
// WHAT THE RETRY SENDS, AND WHAT IT CANNOT SEND. The form submits the gallery
// id and the epoch the notice was RENDERED with — never object keys. The
// manifest is the only source of truth for what to delete
// (`retryReopenedFinalCleanup`); a client-supplied key would be a way to
// delete anything in the bucket. The epoch is what makes a stale notice
// refuse instead of sweeping a newer reopen's obligation.
//
// THE COPY IS THE OWNER'S, VERBATIM (kanban #287, "Copy de UI — APPROVED by
// owner", 2026-10-25), including the three retry outcomes. The design mock
// (`design/system/dashboard.html`) has no cleanup-recovery design at all: this
// reuses the page's existing bordered card plus the mock's plain secondary
// button (`:220-227`), and invents no visual language of its own.
import { useActionState } from "react";
import {
  retryReopenedFinalCleanup,
  type RetryReopenedFinalCleanupState,
} from "@/app/dashboard/galleries/actions";

const initialState: RetryReopenedFinalCleanupState = { status: "idle" };

// Same literal classes as <UnlockSelectionPanel>/<ReopenDeliveredGalleryPanel>
// — the mock's plain `.btn` (design/system/dashboard.html:220-227), brand
// tokens rather than `app-*` for the same ESLint-scope reason those files
// document.
const plainButtonClass =
  "border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6";

const CLEANED = "Limpieza de finales completada.";

/** The approved pending paragraph. The count is the durable remainder read
 * server-side — never a number kept in this component. */
function pendingText(remainingKeys: number): string {
  return (
    "La galería quedó reabierta, pero no pudimos borrar todos los finales viejos " +
    `(${remainingKeys} archivo(s) pendiente(s)). Reintentá la limpieza; mientras tanto no ` +
    "reabras ni elimines esta galería."
  );
}

/** What to show when the retry did not finish the job. The action sends a
 * `message` when the drainer itself threw (it cannot count in that case) and
 * only a count when it knows how many keys are still owed; both are approved
 * strings, so nothing is composed here beyond inserting the number. */
function retryFailureText(state: RetryReopenedFinalCleanupState): string {
  if (state.message !== undefined) return state.message;
  if (state.remainingCleanupKeys !== undefined) {
    return (
      "No pudimos terminar la limpieza. Quedan " +
      `${state.remainingCleanupKeys} archivo(s) pendiente(s); reintentá en un rato.`
    );
  }
  // Unreachable: the action reports the count for `cleanup_failed` and a
  // message for the rest. Kept so a committed obligation cannot render as
  // nothing at all.
  return "No pudimos terminar la limpieza. Reintentá en un rato.";
}

export function PendingFinalCleanupNotice({
  galleryId,
  reopenEpoch,
  remainingKeys,
}: {
  galleryId: string;
  reopenEpoch: string;
  remainingKeys: number;
}) {
  const [state, formAction, pending] = useActionState(retryReopenedFinalCleanup, initialState);

  // The obligation is gone: nothing is owed any more, so the notice and its
  // retry button are replaced by the confirmation.
  if (state.status === "cleaned") {
    return (
      <p role="status" className="text-accent-2 text-sm">
        {CLEANED}
      </p>
    );
  }

  // A stale or refused retry: the notice on screen no longer describes this
  // gallery (`La limpieza pendiente ya no corresponde…`, the action's own
  // message), so it is replaced instead of sitting above a contradiction. The
  // page re-reads the real obligation on the next render.
  if (state.status === "error") {
    return (
      <p role="alert" className="text-danger text-sm">
        {state.message}
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col items-start gap-3">
      <p role="alert" className="text-danger text-sm">
        {pendingText(remainingKeys)}
      </p>

      {state.status === "cleanup_failed" && (
        <p role="alert" className="text-danger text-sm">
          {retryFailureText(state)}
        </p>
      )}

      <form action={formAction} className="flex flex-col items-start gap-2">
        <input type="hidden" name="galleryId" value={galleryId} />
        {/* The epoch this notice was rendered with — the action refuses a
            stale one instead of draining a newer reopen's obligation. */}
        <input type="hidden" name="expectedEpoch" value={reopenEpoch} />
        <button type="submit" disabled={pending} className={plainButtonClass}>
          {pending ? "Reintentando…" : "Reintentar limpieza"}
        </button>
      </form>
    </div>
  );
}
