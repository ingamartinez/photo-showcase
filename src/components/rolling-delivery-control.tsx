"use client";

// Task #244 — the admin switch, RE-LABELLED by epic #250 (task #263).
//
// The flag used to do two jobs: (a) make "Enviar" place an ORDER instead of
// locking the client, and (b) show finals before delivery. Decision 11 split
// them: (a) is mandatory now and unconditional (a submit is always an order —
// decision 10), and only (b) is still opt-in per gallery. So the control is
// called what it actually decides — "Ver finales antes de entregar" — and its
// ON copy no longer claims anything about "Enviar", which would now be a
// second name for the default behaviour.
//
// Same shape as <SelectionTrayModeControl>: a form + server action,
// changeable at any status. Brand tokens (`border-line-2`, …), not `app-*`,
// because this lives under `src/components/` (see that component's comment).
import { useActionState } from "react";
import {
  updateRollingDelivery,
  type UpdateRollingDeliveryState,
} from "@/app/dashboard/galleries/actions";

const initialState: UpdateRollingDeliveryState = { status: "idle" };

export function RollingDeliveryControl({
  galleryId,
  rollingDelivery,
}: {
  galleryId: string;
  /** `GalleryDetail.rollingDelivery`, never derived. */
  rollingDelivery: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateRollingDelivery, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="galleryId" value={galleryId} />
      <input type="hidden" name="rollingDelivery" value={rollingDelivery ? "false" : "true"} />
      <span className="text-fg-mute text-xs tracking-wide uppercase">
        Ver finales antes de entregar
      </span>
      <p className="text-fg-dim text-xs">
        {rollingDelivery
          ? "Prendida — cada foto editada que subas la ven todos los clientes de la galería al instante."
          : "Apagada — los clientes ven las fotos editadas recién cuando entregas toda la galería."}
      </p>
      <button
        type="submit"
        disabled={pending}
        // The visible verb alone ("Prender") is not a name a screen reader can
        // act on, so the object of the switch is part of the accessible name.
        // It CONTAINS the visible text ("label in name"), which is what keeps
        // voice-control users able to say what they see.
        aria-label={
          rollingDelivery
            ? "Apagar ver finales antes de entregar"
            : "Prender ver finales antes de entregar"
        }
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 w-fit items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
      >
        {pending ? "Guardando…" : rollingDelivery ? "Apagar" : "Prender"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-danger text-sm">
          {state.message}
        </p>
      )}
      {state.status === "updated" && (
        <p role="status" className="text-accent-2 text-sm">
          Actualizado.
        </p>
      )}
    </form>
  );
}
