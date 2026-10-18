"use client";

// The client's "these ones" button (task #25) — rendered by <ProofGrid>
// next to <SelectionCounter>, sharing the exact same `quota` state, for the
// same reason those two live together in the same render already
// (proof-grid.tsx's own header comment).
//
// Confirmation step, deliberately a native `window.confirm()`: this mirrors
// the ONE other irreversible, confirmation-gated action already in this
// codebase (`<AssetTile>`'s delete, src/components/asset-tile.tsx) rather
// than introducing a bespoke modal component for a single button. Task #147
// re-examined this decision against the mock's own bottom-sheet confirmation
// (design/system/client.html:840-872, `screen-enviar`) and kept it: the
// sheet's CONTENT is what this task owns, and every fact it states —
// irreversible, closes for everyone, extras settle outside the app — is
// all carried by the C10 confirmation below; building a bespoke sheet
// component to re-skin a dialog this codebase already has a working,
// reviewed pattern for was judged not worth the risk this pass, given how
// much of this same slice already touches the tray, the counter and the
// grid's layout. Revisit if the owner wants a bottom-sheet's PIXELS
// specifically, not just its words.
//
// The dialog's own text is the task's explicit acceptance criterion —
// "states what happens next, including that extras are settled outside the
// app" — spelled out plainly rather than assumed obvious. Task #147 widened
// it to the per-send framing C10 below carries: this
// button closes the selection for every client attached to the gallery
// (task #94), not only the one tapping it, matching the mock's own warning
// (client.html:858-863) without inventing presence data this app does not
// have (no viewer list — selection-tray.tsx's own "NO PRESENCE" stance).
//
// This confirmation is UX, not the gate: `POST
// /api/galleries/[galleryId]/submit-selection` re-checks everything itself
// (empty selection, gallery status, ownership) regardless of what this
// button ever shows — see that route's own header comment.
//
// The locked message deliberately says "tu fotógrafo ya tiene acceso a esta
// selección", not "ya fue notificado" — the submit route's own notification
// step is best-effort (see its header comment) and this component has no
// way to know whether that email actually sent. "Has access" is true the
// instant the route responds (the gallery is durably `selected`, visible in
// the admin dashboard regardless of the email); "was notified" would be a
// claim this component cannot back up.
import { useState } from "react";
import type { QuotaResult } from "@/lib/quota";

export type SubmitSelectionOutcome = {
  quota: QuotaResult;
  /** The CALLER's own submission time (epic #239). */
  submittedAt: string | null;
  /** Whether this submission left every active client locked, i.e. the
   * gallery itself moved to `selected`. `false` while others are still
   * choosing. */
  gallerySelected: boolean;
  /** Task #244 — rolling delivery: how many photos this call actually
   * stamped as ordered. Absent on the idempotent `already_submitted` 200. */
  requestedCount?: number;
};

export function SubmitSelectionPanel({
  galleryId,
  isLocked,
  submittedAt,
  onSubmitted,
  isGalleryLocked = isLocked,
  lockedByAdmin = false,
  isAdminPreview = false,
  unsentCount = 0,
}: {
  galleryId: string;
  /** Still carried for the outcomes' type and for callers that shared the
   * server's quota; the C10 confirmation no longer quotes money. */
  quota: QuotaResult;
  // Whether THIS viewer can no longer change anything: the gallery is past
  // `proofing`, OR (epic #239) this person submitted / was locked while the
  // gallery is still `proofing` for the others. <ProofGrid> derives it from
  // the server's snapshot and flips it locally the moment a submission here
  // succeeds, with no page reload. The SERVER independently refuses a submit
  // attempt on a locked gallery or client regardless of what this prop says
  // (this component's own header comment).
  isLocked: boolean;
  submittedAt: string | null;
  onSubmitted: (outcome: SubmitSelectionOutcome) => void;
  /** Task #214 — kept on the wire so every caller keeps compiling; the C10
   * confirmation is about the SEND, not the tariffs. */
  allowsOriginalSelection: boolean;
  /** Epic #239 — the gallery itself is past `proofing` (everybody is done).
   * Defaults to `isLocked`, the pre-#239 meaning. When `isLocked` but this is
   * `false`, only THIS person is locked and the others are still choosing, so
   * the copy must not claim the photographer has the group's selection. */
  isGalleryLocked?: boolean;
  /** Epic #239 — the photographer locked this person (never submitted). */
  lockedByAdmin?: boolean;
  /** Epic #239 — kept for callers; the button counts `unsentCount` now. */
  ownPickCount?: number;
  /** Epic #239 — the photographer previewing the client page. The submit
   * route refuses admins (`admin_cannot_submit`), so no button is offered. */
  isAdminPreview?: boolean;
  /** Epic #250 S7 — the submit sends the viewer's own "por enviar"; the
   * button counts exactly those photos (decision 19). */
  unsentCount?: number;
  /** Task #244 — kept on the wire; the tray owns "Último envío". */
  rollingDelivery?: boolean;
  lastSubmittedAt?: string | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLocked) {
    if (isGalleryLocked) {
      return (
        <p className="text-fg-mute text-sm" role="status">
          Selección enviada
          {submittedAt ? ` el ${new Date(submittedAt).toLocaleDateString("es-CO")}` : ""} — tu
          fotógrafo ya tiene acceso a esta selección.
        </p>
      );
    }
    if (lockedByAdmin) {
      return (
        <p className="text-fg-mute text-sm" role="status">
          Tu fotógrafo cerró tu selección, así que ya no se puede cambiar desde aquí.
        </p>
      );
    }
    return (
      <p className="text-fg-mute text-sm" role="status">
        Enviaste tu selección
        {submittedAt ? ` el ${new Date(submittedAt).toLocaleDateString("es-CO")}` : ""} — tu
        fotógrafo ya tiene tus fotos. Los demás todavía están eligiendo.
      </p>
    );
  }

  if (isAdminPreview) {
    return (
      <p className="text-fg-mute text-sm" role="status">
        Vista previa: el envío de la selección es solo para clientes.
      </p>
    );
  }

  async function handleSubmit() {
    if (pending) return;
    // C10 — the owner-approved confirmation. It warns about the SEND: what is
    // sent cannot be taken back by the client, sending again is allowed, and
    // whoever sends a shared photo first gets the unit. Money is not quoted
    // here any more (Q6 is S9's projection sheet); the fixed bar's counter is
    // still on screen behind the native dialog.
    const head = unsentCount === 1 ? "¿Envías esta foto?" : `¿Envías estas ${unsentCount}?`;
    const confirmation = [
      head,
      "Lo que envíes ya no lo puedes sacar tú. Si te arrepientes, escríbele a tu fotógrafo.",
      "Puedes seguir eligiendo y enviar más después. Si alguien envía la misma antes que tú, queda a su nombre. Cuando todos hayan enviado y no quede nada por enviar, la selección se cierra sola.",
    ].join("\n\n");
    if (!window.confirm(confirmation)) return;

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/galleries/${galleryId}/submit-selection`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "empty_selection") {
          setError("Elige al menos una foto antes de enviar.");
        } else if (body?.error === "gallery_not_submittable") {
          setError("Esta galería no está lista para recibir una selección todavía.");
        } else if (body?.error === "admin_cannot_submit") {
          setError("El envío de la selección es solo para clientes.");
        } else {
          setError("No se pudo enviar la selección. Prueba de nuevo en un momento.");
        }
        return;
      }
      const body = (await response.json()) as {
        status: "submitted" | "already_submitted";
        quota: QuotaResult;
        submittedAt: string | null;
        gallerySelected?: boolean;
        requestedCount?: number;
      };
      onSubmitted({
        quota: body.quota,
        submittedAt: body.submittedAt,
        // A response from before epic #239 has no such field: that gallery-wide
        // lock is what "submitted" meant then.
        gallerySelected: body.gallerySelected ?? true,
        requestedCount: body.requestedCount,
      });
    } catch {
      setError("No se pudo conectar.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Task #149's own sweep: this used to be the marketing CTA's own
          shape — `uppercase tracking-[0.1em] text-[13px]` bordered — the
          exact device `src/app/galleries/layout.tsx`'s header comment
          already named as removed from "Cerrar sesión" and found surviving
          elsewhere. `design/system/client.html`'s own "Enviar" action is
          `.btn.btn--primary` (:828, :867: `<button class="btn btn--primary">
          Enviar las 15</button>`), NOT uppercase, tracked at 0.02em — filled
          with `--accent`, 48px tall (`--tap`), 3px radius. Same translation
          `proof-lightbox.tsx`'s own picked-state pick button already uses
          for this exact mock shape (that file's own comment on
          `.btn.btn--primary.btn--wide`), reused here rather than invented a
          second time. */}
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={pending || unsentCount === 0}
        className="border-accent bg-accent hover:border-accent-2 hover:bg-accent-2 text-ink inline-flex min-h-11 items-center justify-center rounded-[3px] border px-3 text-sm font-semibold tracking-[0.02em] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-12 lg:px-5"
      >
        {pending ? "Enviando…" : unsentCount === 1 ? "Enviar la foto" : `Enviar las ${unsentCount}`}
      </button>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
