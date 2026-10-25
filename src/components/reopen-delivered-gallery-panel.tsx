"use client";

// Task #287 — the admin trigger for reopening a DELIVERED gallery: the
// client's selection goes back to editable carts, every uploaded final is
// physically deleted and the gallery returns to `proofing`
// (`reopenDeliveredGallery`, src/app/dashboard/galleries/actions.ts).
//
// Rendered by the gallery detail page ONLY while `gallery.status ===
// "delivered"`, same "hiding is UX, not authority" stance as
// <UnlockSelectionPanel> right next to it: the action re-checks the real
// status itself, on every call, through its own delivered CAS.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT:
//
// 1. THE DIALOG IS THE CONFIRMATION, and nothing about it is the guard. The
//    trigger opens it and never submits; the Cancel button is `type="button"`
//    inside the form (`<DialogClose asChild>`), so it closes without sending
//    anything. Only the confirm button submits — the pattern
//    `allows-original-selection-control.tsx` already established for the one
//    other destructive admin change on this page. The component test proves
//    the trigger and cancel paths call the action zero times.
//
// 2. A COMMITTED OUTCOME REPLACES THIS PANEL, the same shape
//    <UnlockSelectionPanel> uses: once the reopen has answered
//    (`reopened`/`reopened_email_failed`/`reopened_cleanup_failed`) the
//    trigger is gone, so the dialog cannot be left open with a stale
//    confirmation behind it, and no result is ever rendered inside an
//    aria-hidden page while a modal is up. A REFUSED reopen (`error`) is the
//    one outcome that stays INSIDE the dialog: nothing happened, the admin is
//    still there, and the message belongs next to the button they pressed.
//
// 3. THE RESULT STATES ARE DISTINCT ON PURPOSE. A reopen that could not delete
//    every old final (`reopened_cleanup_failed`) is NOT a success: the gallery
//    really is reopened, but a durable cleanup obligation survives and has to
//    be retried from <PendingFinalCleanupNotice>, which the page renders
//    outside this panel so it also survives a refresh and this panel
//    unmounting. An email failure keeps the action's own message (it names the
//    addresses), never a generic one.
//
// THE COPY IS THE OWNER'S, VERBATIM (kanban #287, "Copy de UI — APPROVED by
// owner", 2026-10-25). Do not paraphrase, do not add strings that are not
// there: this file contains no sentence the owner did not approve. The one
// exception is `Nota (opcional)`, which already ships verbatim in
// <UnlockSelectionPanel> for the same optional-reason field; the unlock
// panel's unlock-specific placeholder is deliberately NOT reused because it
// would invent a reopen sentence the owner never saw.
//
// 4. THE EMAIL WARNING IS NEVER FOLDED AWAY (task #287 UI review, finding 1).
//    `reopened_cleanup_failed` owns `message` with its cleanup text, so the
//    notification outcome travels in `emailMessage` and the two approved
//    alerts are rendered SIDE BY SIDE when both failed — no invented combined
//    sentence, and nothing the admin needs disappears because a second thing
//    also broke.
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  reopenDeliveredGallery,
  type ReopenDeliveredGalleryState,
} from "@/app/dashboard/galleries/actions";

const initialState: ReopenDeliveredGalleryState = { status: "idle" };

// The mock's own plain `.btn` treatment (design/system/dashboard.html:220-227,
// secondary button: a `--line-2` border, an `--app-raised` hover wash, never
// brass, never uppercase/tracked) — the same literal classes
// <UnlockSelectionPanel> uses, and the same reason it uses brand tokens rather
// than `app-*`: this file is not named `dashboard-*` and does not live under
// `src/app/dashboard/**`, so task #175's ESLint rule correctly refuses `app-*`
// here even though the component only ever renders inside that scope.
const plainButtonClass =
  "border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6";

// The destructive confirm: the plain treatment plus `--danger` text, the
// combination <DeleteGalleryDialog> already uses for the other irreversible
// admin action. The dialog itself is rendered through a portal, OUTSIDE
// `[data-surface="app"]` (see `delete-gallery-dialog.tsx`'s header for the
// full reasoning), so everything here is brand tokens, never `app-*`.
const destructiveButtonClass =
  "border-line-2 text-danger hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const SUCCESS =
  "Galería reabierta — cada cliente puede volver a elegir, y les avisamos por correo.";

/** The approved confirmation facts, one paragraph each. The first three are
 * identical for both delivery modes; only the fourth — what "no downloadable
 * finals" means right now — depends on `rollingDelivery`
 * (`src/lib/final-access.ts` opens the rolling gate before a new delivery). */
const FACTS = {
  cancelled:
    "Se cancela la selección que ya estaba enviada: cada persona vuelve a tener sus fotos " +
    "como carrito y tiene que elegir y enviar de nuevo.",
  finals:
    "También se borran los finales que ya subiste de esta galería y sus versiones de vista " +
    "previa, incluidos los regalos: tenés que volver a subirlos todos para entregar otra vez.",
  money:
    "Los extras y el recargo se recalculan con este nuevo envío, así que lo que se facturó " +
    "antes queda en cero (lo ya cobrado lo arreglás por fuera, como siempre). No hay forma de " +
    "deshacer esto desde la app.",
  availability: {
    // Ordinary delivery: nothing is downloadable until the next delivery.
    normal:
      "Mientras tanto nadie puede descargar los finales de esta galería. Los archivos que el " +
      "cliente ya se descargó no se pueden recuperar.",
    // Rolling delivery: finals become downloadable as they are re-uploaded,
    // BEFORE the new delivery — the same conditional warning the plan
    // requires instead of the false "all rolling downloads stay open".
    rolling:
      "Mientras no haya finales nuevos no hay nada para descargar; a medida que los vuelvas a " +
      "subir, el cliente los va a poder bajar sin esperar a la nueva entrega.",
  },
} as const;

/**
 * What to show for `reopened_cleanup_failed`. The action fills in a `message`
 * for the two outcomes it can name (the drainer threw, or the manifest no
 * longer matched this reopen); the plain pending outcome carries only the
 * durable count. Both branches are approved copy — nothing is built here.
 */
function cleanupFailureText(state: ReopenDeliveredGalleryState): string {
  if (state.message !== undefined) return state.message;
  if (state.remainingCleanupKeys !== undefined) {
    return (
      "La galería quedó reabierta, pero no pudimos borrar todos los finales viejos " +
      `(${state.remainingCleanupKeys} archivo(s) pendiente(s)). Reintentá la limpieza; ` +
      "mientras tanto no reabras ni elimines esta galería."
    );
  }
  // Unreachable: the action reports the count for `pending` and a message for
  // the other two outcomes. Kept because hiding a committed, still-owed
  // cleanup would be worse than a sentence that admits it cannot count it.
  return (
    "La galería quedó reabierta, pero no pudimos terminar de borrar los finales viejos. " +
    "Reintentá la limpieza desde el detalle de la galería."
  );
}

/**
 * The stable focus target for a COMMITTED outcome (task #287 UI review,
 * accessibility observation). A committed result replaces the dialog AND its
 * trigger, so Radix's FocusScope otherwise restores focus to an element that no
 * longer exists and the keyboard position falls to BODY. This wrapper takes
 * focus instead, with `tabIndex={-1}` so it is programmatically focusable but
 * never a tab stop of its own.
 *
 * WHY A TIMER: `@radix-ui/react-focus-scope`'s unmount effect schedules its own
 * `setTimeout(..., 0)` that focuses the previously focused element (the
 * unmounted trigger) or `document.body` — it runs AFTER a mount `useEffect`, so
 * focusing synchronously would be immediately overwritten. A 0ms timer
 * registered here runs after Radix's, because both are FIFO and Radix's is
 * registered during the commit's cleanup phase, before this effect.
 */
function CommittedOutcome({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);

  return (
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-2 outline-none">
      {children}
    </div>
  );
}

export function ReopenDeliveredGalleryPanel({
  galleryId,
  rollingDelivery,
}: {
  galleryId: string;
  rollingDelivery: boolean;
}) {
  const [state, formAction, pending] = useActionState(reopenDeliveredGallery, initialState);

  // Committed outcomes: the destructive panel is replaced by its result (see
  // this file's header, point 2).
  if (state.status === "reopened") {
    return (
      <CommittedOutcome>
        <p role="status" className="text-accent-2 text-sm">
          {SUCCESS}
        </p>
      </CommittedOutcome>
    );
  }

  // The reopen committed but at least one client could not be told. The
  // action's message lists the addresses, so it is rendered as-is.
  if (state.status === "reopened_email_failed") {
    return (
      <CommittedOutcome>
        <p role="alert" className="text-danger text-sm">
          {state.emailMessage ?? state.message}
        </p>
      </CommittedOutcome>
    );
  }

  // Committed reopen, unfinished storage cleanup: never folded into the quiet
  // success above, and never retried from here — the durable obligation is
  // retried by <PendingFinalCleanupNotice>. When the email ALSO failed, the
  // second approved alert is rendered next to this one: a cleanup retry does
  // not send any email, so losing it here would lose it for good.
  if (state.status === "reopened_cleanup_failed") {
    return (
      <CommittedOutcome>
        <p role="alert" className="text-danger text-sm">
          {cleanupFailureText(state)}
        </p>
        {state.emailMessage !== undefined && (
          <p role="alert" className="text-danger text-sm">
            {state.emailMessage}
          </p>
        )}
      </CommittedOutcome>
    );
  }

  return (
    <div className="flex w-full flex-col items-start gap-3">
      <Dialog>
        <DialogTrigger disabled={pending} className={plainButtonClass}>
          {pending ? "Reabriendo…" : "Reabrir entrega"}
        </DialogTrigger>

        <DialogContent
          className="border-line-2 gap-5 border sm:max-w-md"
          // The default close button is an inherited ENGLISH accessible name
          // (`<span class="sr-only">Close</span>` in ui/dialog.tsx) that no
          // owner-approved list contains, and this panel already has an
          // approved way out (`Cancelar`). Suppressing it here rather than
          // relabelling the shared dialog keeps this slice to its own copy.
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-fg text-lg font-medium">
              ¿Reabrir esta galería entregada?
            </DialogTitle>
            <DialogDescription className="text-fg-dim">{FACTS.cancelled}</DialogDescription>
          </DialogHeader>

          {/* The rest of the approved facts. `DialogDescription` renders a
              single <p> (it is the dialog's aria-describedby), so the
              remaining paragraphs are its siblings rather than nested. */}
          <div className="text-fg-dim flex flex-col gap-3 text-sm">
            <p>{FACTS.finals}</p>
            <p>{FACTS.money}</p>
            <p>{rollingDelivery ? FACTS.availability.rolling : FACTS.availability.normal}</p>
          </div>

          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="galleryId" value={galleryId} />
            <label htmlFor="reopen-reason" className="text-fg-dim text-xs">
              Nota (opcional)
            </label>
            <textarea
              id="reopen-reason"
              name="reason"
              rows={2}
              className="border-line-2 w-full rounded-sm border bg-transparent px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={pending} className={destructiveButtonClass}>
                {pending ? "Reabriendo…" : "Reabrir y borrar finales"}
              </button>
              {/* `type="button"` + DialogClose: closing must never be able to
                  submit the destructive form, and the test proves it. */}
              <DialogClose asChild>
                <button type="button" className={plainButtonClass}>
                  Cancelar
                </button>
              </DialogClose>
            </div>
            {state.status === "error" && (
              <p role="alert" className="text-danger text-sm">
                {state.message}
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
