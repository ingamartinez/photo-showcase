"use client";

// Task #244 — the admin switch for "Entrega progresiva": with it on, a client
// sees each edited photo the moment the photographer uploads it (gallery still
// `proofing`/`selected`), and "Enviar" places an order instead of locking the
// client. Same shape as <SelectionTrayModeControl>: a form + server action,
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
      <span className="text-fg-mute text-xs tracking-wide uppercase">Entrega progresiva</span>
      <p className="text-fg-dim text-xs">
        {rollingDelivery
          ? "Prendida — cada foto editada que subas la ven todos los clientes de la galería al instante, y “Enviar” pide las fotos sin bloquear al cliente."
          : "Apagada — los clientes ven las fotos editadas recién cuando entregás toda la galería."}
      </p>
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 w-fit items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
      >
        {pending
          ? "Guardando…"
          : rollingDelivery
            ? "Apagar entrega progresiva"
            : "Prender entrega progresiva"}
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
