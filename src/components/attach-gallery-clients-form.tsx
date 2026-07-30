"use client";

// Attach action (task #97) — the product's first gallery-editing surface.
// Rendered by the gallery detail page, fed the clients NOT currently active
// on this gallery (never attached, or previously removed — both are
// eligible options here; `attachGalleryClients` itself decides which of the
// two applies per id and reacts accordingly, see that action's own header
// comment). Same "hiding is UX, not authority" stance as every other guard
// in this app: `attachGalleryClients` re-validates every id server-side
// regardless of what this picker ever lists.
import { useActionState } from "react";
import {
  attachGalleryClients,
  type AttachGalleryClientsState,
} from "@/app/dashboard/galleries/actions";
import type { ClientForPicker } from "@/lib/clients";

const initialState: AttachGalleryClientsState = { status: "idle" };

const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-sm border bg-transparent px-4 py-3 text-[15px] transition-colors outline-none";

export function AttachGalleryClientsForm({
  galleryId,
  eligibleClients,
}: {
  galleryId: string;
  eligibleClients: ClientForPicker[];
}) {
  const [state, formAction, pending] = useActionState(attachGalleryClients, initialState);

  if (eligibleClients.length === 0) {
    return (
      <p className="text-fg-mute text-xs">
        Ya agregaste a todos los clientes disponibles a esta galería.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="galleryId" value={galleryId} />
      <label htmlFor="attach-client-ids" className="label text-fg-mute">
        Agregar clientes
      </label>
      {/* Same `multiple` picker as gallery-form.tsx's own client select —
          see that component's comment on why `getAll`, not `get`, is what
          the action reads on the other end. */}
      <select
        id="attach-client-ids"
        name="clientIds"
        multiple
        size={Math.min(6, Math.max(3, eligibleClients.length))}
        aria-invalid={state.status === "error"}
        aria-describedby={state.status === "error" ? "attach-clients-error" : undefined}
        className={inputClass}
      >
        {eligibleClients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.name ?? client.email}
          </option>
        ))}
      </select>

      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:border-accent hover:text-accent-2 self-start rounded-sm border px-[16px] py-[10px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Agregando…" : "Agregar"}
      </button>

      {state.status === "error" && (
        <p id="attach-clients-error" role="alert" className="text-xs text-[#e0796b]">
          {state.message}
        </p>
      )}
      {state.status === "attached_email_failed" && (
        <p role="alert" className="text-xs text-[#e0796b]">
          {state.message}
        </p>
      )}
      {state.status === "attached" && (
        <p role="status" className="text-accent-2 text-xs">
          {state.message ?? "Cliente agregado."}
        </p>
      )}
    </form>
  );
}
