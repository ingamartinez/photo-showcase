"use client";

// One row per ACTIVE client on the gallery detail page (task #97) — renders
// the same "name · email" line #94 already established, plus a two-step
// "Quitar" affordance for the removal action and, since task #101, a
// "Reenviar acceso" affordance for the resend action.
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
//
// Task #101's `resendable` follows the same "UX only, never the authority"
// stance — it is server-computed (`isGalleryVisibleToClient(gallery.status)`
// in page.tsx) and passed in as a plain boolean, rather than imported here,
// because this is a Client Component ("use client" below) and
// `isGalleryVisibleToClient` lives in a `server-only`-guarded module
// (src/lib/galleries.ts) that a Client Component cannot import at all.
// `resendGalleryAccessEmail` re-derives the same answer from the DB row
// regardless of what this component was told to render.
//
// TWO INDEPENDENT `useActionState` HOOKS, ONE PER FORM, EACH WITH ITS OWN
// `pending` — the trap a naive version of this row would fall into (and did,
// on this task's first, lost implementation attempt): sharing ONE `pending`
// flag between "Quitar" and "Reenviar" would disable "Confirmar" (the
// removal action's own submit button) while an unrelated resend is still in
// flight, and vice versa. The two actions do not touch the same data
// (`removeGalleryClient` writes `removedAt`; `resendGalleryAccessEmail`
// writes nothing at all) and have no reason to block each other in the UI.
import { useActionState, useState } from "react";
import {
  removeGalleryClient,
  resendGalleryAccessEmail,
  type RemoveGalleryClientState,
  type ResendGalleryAccessEmailState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";

const initialRemoveState: RemoveGalleryClientState = { status: "idle" };
const initialResendState: ResendGalleryAccessEmailState = { status: "idle" };

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
  resendable,
}: {
  galleryId: string;
  client: { id: string; name: string | null; email: string };
  status: Gallery["status"];
  removable: boolean;
  resendable: boolean;
}) {
  const [removeState, removeFormAction, removePending] = useActionState(
    removeGalleryClient,
    initialRemoveState,
  );
  const [resendState, resendFormAction, resendPending] = useActionState(
    resendGalleryAccessEmail,
    initialResendState,
  );
  const [confirming, setConfirming] = useState(false);

  if (removeState.status === "removed") {
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
        {resendable && (
          <form action={resendFormAction}>
            <input type="hidden" name="galleryId" value={galleryId} />
            <input type="hidden" name="clientId" value={client.id} />
            <button
              type="submit"
              disabled={resendPending}
              className="label text-fg-dim hover:text-accent-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resendPending ? "Reenviando…" : "Reenviar acceso"}
            </button>
          </form>
        )}
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
        <form action={removeFormAction} className="flex flex-col items-start gap-2">
          <input type="hidden" name="galleryId" value={galleryId} />
          <input type="hidden" name="clientId" value={client.id} />
          <p className="text-xs text-[#e0796b]">{REMOVE_WARNING_BY_STATUS[status]}</p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={removePending}
              className="label text-[#e0796b] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {removePending ? "Quitando…" : "Confirmar"}
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

      {removeState.status === "error" && (
        <p role="alert" className="text-xs text-[#e0796b]">
          {removeState.message}
        </p>
      )}

      {(resendState.status === "resend_email_failed" || resendState.status === "throttled") && (
        <p role="alert" className="text-xs text-[#e0796b]">
          {resendState.message}
        </p>
      )}
      {resendState.status === "resent" && (
        <p role="status" className="text-accent-2 text-xs">
          {resendState.message}
        </p>
      )}
    </div>
  );
}
