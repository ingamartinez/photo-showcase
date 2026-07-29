"use client";

// The client's "these ones" button (task #25) — rendered by <ProofGrid>
// next to <SelectionCounter>, sharing the exact same `quota` state, for the
// same reason those two live together in the same render already
// (proof-grid.tsx's own header comment).
//
// Confirmation step, deliberately a native `window.confirm()`: this mirrors
// the ONE other irreversible, confirmation-gated action already in this
// codebase (`<AssetTile>`'s delete, src/components/asset-tile.tsx) rather
// than introducing a bespoke modal component for a single button. The
// dialog's own text is the task's explicit acceptance criterion — "states
// what happens next, including that extras are settled outside the app" —
// spelled out plainly rather than assumed obvious.
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
  submittedAt: string | null;
};

function confirmationMessage(quota: QuotaResult): string {
  const lines = [
    `¿Enviar tu selección de ${quota.selected} foto${quota.selected === 1 ? "" : "s"}?`,
    "Una vez enviada, no vas a poder modificarla vos mismo — si necesitás cambiarla, escribile a tu fotógrafo.",
  ];
  // Always states the extras/surcharge situation, even at zero — matching
  // <SelectionCounter>'s own "always show all three parts" stance
  // (src/components/selection-counter.tsx's header comment): the sentence
  // shape stays constant, only the number changes.
  lines.push(
    quota.extras > 0
      ? `Extras: ${quota.extras} × ${formatCop(quota.extraPhotoPriceCopSnapshot)} = ${formatCop(quota.surchargeCop)}.`
      : "No tenés extras con esta selección.",
  );
  lines.push("El cobro de los extras (si los hay) se coordina por fuera de la app, no acá.");
  return lines.join("\n\n");
}

export function SubmitSelectionPanel({
  galleryId,
  quota,
  isLocked,
  submittedAt,
  onSubmitted,
}: {
  galleryId: string;
  quota: QuotaResult;
  // Whether the gallery is already past `proofing` (submitted once already,
  // or further along) — <ProofGrid> derives this from the gallery's own
  // status and flips it locally the moment a submission here succeeds, with
  // no page reload. The SERVER independently refuses a submit attempt on a
  // locked gallery regardless of what this prop says (this component's own
  // header comment).
  isLocked: boolean;
  submittedAt: string | null;
  onSubmitted: (outcome: SubmitSelectionOutcome) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLocked) {
    return (
      <p className="text-fg-mute text-sm" role="status">
        Selección enviada
        {submittedAt ? ` el ${new Date(submittedAt).toLocaleDateString("es-CO")}` : ""} — tu
        fotógrafo ya tiene acceso a esta selección.
      </p>
    );
  }

  async function handleSubmit() {
    if (pending) return;
    if (!window.confirm(confirmationMessage(quota))) return;

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/galleries/${galleryId}/submit-selection`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "empty_selection") {
          setError("Elegí al menos una foto antes de enviar.");
        } else if (body?.error === "gallery_not_submittable") {
          setError("Esta galería no está lista para recibir una selección todavía.");
        } else {
          setError("No se pudo enviar la selección. Probá de nuevo en un momento.");
        }
        return;
      }
      const body = (await response.json()) as {
        status: "submitted" | "already_submitted";
        quota: QuotaResult;
        submittedAt: string | null;
      };
      onSubmitted({ quota: body.quota, submittedAt: body.submittedAt });
    } catch {
      setError("No se pudo conectar.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={pending || quota.selected === 0}
        className="border-line-2 hover:border-accent hover:text-accent-2 rounded-sm border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Enviando…" : "Enviar selección"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-[#e0796b]">
          {error}
        </p>
      )}
    </div>
  );
}
