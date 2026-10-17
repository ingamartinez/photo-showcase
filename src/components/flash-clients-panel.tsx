"use client";

// Client assignment for a flash gallery (task #233): the active clients with a
// remove button each, and the shared `ClientPicker` (task #247) for the clients
// still available — the same control as `AttachGalleryClientsForm`, pointed at
// the flash actions. Hiding is UX; both actions re-validate server-side.
import { useActionState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  attachFlashClients,
  removeFlashClient,
  type AttachFlashClientsState,
} from "@/app/dashboard/flash/actions";
import type { ClientForPicker } from "@/lib/clients";
import { ClientPicker } from "@/components/client-picker";

const initialState: AttachFlashClientsState = { status: "idle" };

export function FlashClientsPanel({
  flashGalleryId,
  assignedClients,
  eligibleClients,
}: {
  flashGalleryId: string;
  assignedClients: ClientForPicker[];
  eligibleClients: ClientForPicker[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(attachFlashClients, initialState);
  const [removing, startRemove] = useTransition();

  function remove(userId: string) {
    startRemove(async () => {
      await removeFlashClient(flashGalleryId, userId);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {assignedClients.length === 0 ? (
        <p className="text-fg-mute text-sm italic">Todavía sin clientes asignados.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {assignedClients.map((client) => (
            <li key={client.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-fg-dim truncate">{client.name ?? client.email}</span>
              <button
                type="button"
                disabled={removing}
                onClick={() => remove(client.id)}
                aria-label={`Quitar a ${client.name ?? client.email}`}
                className="text-fg-dim min-h-11 text-xs underline disabled:opacity-50 lg:min-h-6"
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {eligibleClients.length === 0 ? (
        <p className="text-fg-mute text-xs">No quedan clientes por agregar.</p>
      ) : (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="flashGalleryId" value={flashGalleryId} />
          <ClientPicker
            id="flash-attach-client-ids"
            name="clientIds"
            label="Agregar clientes"
            clients={eligibleClients}
            aria-invalid={state.status === "error"}
            aria-describedby={state.status === "error" ? "flash-attach-error" : undefined}
          />
          <button
            type="submit"
            disabled={pending}
            className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center self-start rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
          >
            {pending ? "Agregando…" : "Agregar"}
          </button>
          {state.status === "error" && (
            <p id="flash-attach-error" role="alert" className="text-danger text-xs">
              {state.message}
            </p>
          )}
          {state.status === "attached" && (
            <p role="status" className="text-accent-2 text-xs">
              {state.message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
