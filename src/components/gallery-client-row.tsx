"use client";

// One row per ACTIVE client on the gallery detail page (task #97) — renders
// the same "name · email" line #94 already established, plus a two-step
// "Quitar" affordance for the new removal action.
//
// The removal confirmation names WHAT is about to happen, not just "¿estás
// seguro?" — the kanban task's own explicit requirement: removing a client
// from a DELIVERED gallery takes away photos they may have already paid for,
// and that must be said plainly before the admin confirms. `removable` hides
// the affordance entirely when the SERVER would refuse it anyway (the last
// active client on a gallery past `draft` — `removeGalleryClient`'s own
// `activeClientRuleViolation()` guard, src/lib/galleries.ts) — "hiding is UX,
// not authority" stance as every other guard in this app: the action itself
// re-checks this regardless of what `removable` is computed as here.
import { useActionState, useState } from "react";
import {
  removeGalleryClient,
  type RemoveGalleryClientState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";

const initialState: RemoveGalleryClientState = { status: "idle" };

const REMOVE_WARNING_BY_STATUS: Record<Gallery["status"], string> = {
  draft:
    "Todavía no se publicó esta galería — el cliente no perdió acceso a nada porque nunca lo tuvo.",
  proofing: "Va a perder el acceso para ver y elegir sus fotos.",
  selected: "Va a perder el acceso a la galería, aunque ya haya enviado su selección.",
  delivered:
    "Va a perder el acceso para ver y descargar las fotos entregadas — incluso si ya las pagó.",
  archived: "Va a perder el acceso a esta galería.",
};

export function GalleryClientRow({
  galleryId,
  client,
  status,
  removable,
}: {
  galleryId: string;
  client: { id: string; name: string | null; email: string };
  status: Gallery["status"];
  removable: boolean;
}) {
  const [state, formAction, pending] = useActionState(removeGalleryClient, initialState);
  const [confirming, setConfirming] = useState(false);

  if (state.status === "removed") {
    return (
      <p className="text-fg-mute mt-2 text-sm line-through decoration-1">
        {client.name ?? client.email} · {client.email} — quitado.
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-fg-mute text-sm">
          {client.name ?? client.email} · {client.email}
        </p>
        {removable && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="label text-fg-dim transition-colors hover:text-[#e0796b]"
          >
            Quitar
          </button>
        )}
      </div>

      {removable && confirming && (
        <form action={formAction} className="flex flex-col items-start gap-2">
          <input type="hidden" name="galleryId" value={galleryId} />
          <input type="hidden" name="clientId" value={client.id} />
          <p className="text-xs text-[#e0796b]">{REMOVE_WARNING_BY_STATUS[status]}</p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={pending}
              className="label text-[#e0796b] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Quitando…" : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="label text-fg-dim hover:text-accent-2 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-xs text-[#e0796b]">
          {state.message}
        </p>
      )}
    </div>
  );
}
