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
// already carried by `confirmationMessage` below; building a bespoke sheet
// component to re-skin a dialog this codebase already has a working,
// reviewed pattern for was judged not worth the risk this pass, given how
// much of this same slice already touches the tray, the counter and the
// grid's layout. Revisit if the owner wants a bottom-sheet's PIXELS
// specifically, not just its words.
//
// The dialog's own text is the task's explicit acceptance criterion —
// "states what happens next, including that extras are settled outside the
// app" — spelled out plainly rather than assumed obvious. Task #147 widened
// it to the SHARED-BOARD framing `confirmationMessage` below carries: this
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
import { formatCop } from "@/lib/format";
import type { QuotaResult } from "@/lib/quota";

export type SubmitSelectionOutcome = {
  quota: QuotaResult;
  /** The CALLER's own submission time (epic #239). */
  submittedAt: string | null;
  /** Whether this submission left every active client locked, i.e. the
   * gallery itself moved to `selected`. `false` while others are still
   * choosing. */
  gallerySelected: boolean;
};

function confirmationMessage(
  quota: QuotaResult,
  ownPickCount: number,
  allowsOriginalSelection: boolean,
): string {
  const lines = [
    // Epic #239: submitting closes only THIS person's selection. The earlier
    // (task #147) wording warned that the whole shared board closed for
    // everyone; that stopped being true when the lock became per person.
    `¿Cerrar tu selección (${ownPickCount} foto${ownPickCount === 1 ? "" : "s"} tuya${ownPickCount === 1 ? "" : "s"})?`,
    "Solo se cierra tu selección: las demás personas de la galería pueden seguir eligiendo las suyas.",
    "Una vez enviada, no se puede modificar sola — si hace falta cambiarla, hay que escribirle a tu fotógrafo para que la reabra.",
    // The quota and the extras are NOT per person: they are computed over the
    // whole gallery's picks, and the lines below say so.
    "Ojo: la cuota incluida y los extras se cuentan sobre las fotos de toda la galería, no solo las tuyas.",
  ];

  // Task #206 — one line per tariff that actually applies, built off
  // `computeQuota`'s own pre-multiplied halves (`extrasSurchargeCop`/
  // `originalsSurchargeCop`, src/lib/quota.ts) rather than this component
  // multiplying anything itself. Same "always states the situation, even at
  // zero" stance <SelectionCounter> follows, extended to two independent
  // terms: whether EACH one shows a line depends on ITS OWN count, not on
  // the other — a gallery with originals but no edited extras must not lose
  // the originals line just because `quota.extras` happens to be 0.
  const chargeLines: string[] = [];
  if (quota.extras > 0) {
    chargeLines.push(
      `Extras: ${quota.extras} × ${formatCop(quota.extraUnitPriceCop)} = ${formatCop(quota.extrasSurchargeCop)}.`,
    );
  }
  // Task #214 — ANDed with the gallery's own switch, same "absent, not
  // zeroed" stance <SelectionCounter> applies to this same line: a gallery
  // with the switch off must never show this sentence, even in the narrow,
  // should-never-happen case of `quota.originals` being non-zero anyway.
  if (allowsOriginalSelection && quota.originals > 0) {
    chargeLines.push(
      `Originales: ${quota.originals} × ${formatCop(quota.originalPhotoPriceCopSnapshot)} = ${formatCop(quota.originalsSurchargeCop)}. Un original nunca cuenta para la cuota incluida — siempre se cobra aparte.`,
    );
  }
  if (chargeLines.length === 0) {
    // Neither term applies — the ORIGINAL pre-#206 sentence, unchanged, for
    // the gallery this task must not visibly change (the owner's own
    // governing constraint).
    lines.push("No tienes extras con esta selección.");
  } else {
    lines.push(...chargeLines);
    // A TOTAL line only when there are TWO tariffs to add — with just one,
    // that line's own number already IS the total, and repeating it would
    // read as redundant rather than clarifying.
    if (chargeLines.length > 1) {
      lines.push(`Total: ${formatCop(quota.surchargeCop)}.`);
    }
  }
  lines.push("El cobro de los extras (si los hay) se coordina por fuera de la app, no acá.");
  return lines.join("\n\n");
}

export function SubmitSelectionPanel({
  galleryId,
  quota,
  isLocked,
  submittedAt,
  onSubmitted,
  allowsOriginalSelection,
  isGalleryLocked = isLocked,
  lockedByAdmin = false,
  ownPickCount = quota.selected,
  isAdminPreview = false,
}: {
  galleryId: string;
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
  /** Task #214 — threaded through to `confirmationMessage` below, same gate
   * <SelectionCounter> applies. */
  allowsOriginalSelection: boolean;
  /** Epic #239 — the gallery itself is past `proofing` (everybody is done).
   * Defaults to `isLocked`, the pre-#239 meaning. When `isLocked` but this is
   * `false`, only THIS person is locked and the others are still choosing, so
   * the copy must not claim the photographer has the group's selection. */
  isGalleryLocked?: boolean;
  /** Epic #239 — the photographer locked this person (never submitted). */
  lockedByAdmin?: boolean;
  /** Epic #239 — how many photos THIS person picked (the submit route refuses
   * an empty selection per person, so this gates the button and fills the
   * confirmation). Defaults to the gallery-wide count. */
  ownPickCount?: number;
  /** Epic #239 — the photographer previewing the client page. The submit
   * route refuses admins (`admin_cannot_submit`), so no button is offered. */
  isAdminPreview?: boolean;
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
    if (!window.confirm(confirmationMessage(quota, ownPickCount, allowsOriginalSelection))) return;

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
      };
      onSubmitted({
        quota: body.quota,
        submittedAt: body.submittedAt,
        // A response from before epic #239 has no such field: that gallery-wide
        // lock is what "submitted" meant then.
        gallerySelected: body.gallerySelected ?? true,
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
        disabled={pending || ownPickCount === 0}
        className="border-accent bg-accent hover:border-accent-2 hover:bg-accent-2 text-ink inline-flex min-h-11 items-center justify-center rounded-[3px] border px-3 text-sm font-semibold tracking-[0.02em] whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-12 lg:px-5"
      >
        {pending ? "Enviando…" : "Enviar selección"}
      </button>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
