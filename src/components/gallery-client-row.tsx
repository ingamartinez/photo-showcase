"use client";

// One row per ACTIVE client on the gallery detail page (task #97) — renders
// the same "name · email" line #94 already established, plus a two-step
// "Quitar" affordance for the removal action and, since task #101, a
// "Reenviar acceso" affordance for the resend action.
//
// Task #133 (epic #125's mobile-first note): the row used to expose "Quitar"
// and "Reenviar acceso" as two adjacent, ~11px text buttons — "intocables con
// el pulgar" and, worse, sitting a thumb's-width away from a DESTRUCTIVE
// action. Both now live inside ONE 44px "Acciones" trigger (a shadcn/Radix
// <DropdownMenu>, the epic's own choice for a primitive that carries
// accessibility for free) instead of being individually reachable at a glance
// — the trigger itself is the only thing that has to hit the touch floor,
// because a menu's own rows are naturally full-width/tall, not two icons
// glued together.
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
//
// THE RESEND FORM HAS NO VISIBLE SUBMIT BUTTON. Its only trigger is the
// dropdown menu item's `onSelect`, which calls the form's own
// `requestSubmit()` through a ref — a `<DropdownMenu.Item>` renders a
// `role="menuitem"` element, never a `<button type="submit">`, so it cannot
// sit inside a `<form>` and rely on native submission the way the OLD
// standalone button did.
import { useActionState, useRef, useState } from "react";
import {
  removeGalleryClient,
  resendGalleryAccessEmail,
  type RemoveGalleryClientState,
  type ResendGalleryAccessEmailState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const resendFormRef = useRef<HTMLFormElement>(null);

  if (removeState.status === "removed") {
    return (
      <p className="text-fg-mute text-sm line-through decoration-1">
        {client.name ?? client.email} · {client.email} — quitado.
      </p>
    );
  }

  const displayName = client.name ?? client.email;
  const hasActions = resendable || removable;

  return (
    <div className="border-line-2 flex flex-col gap-2 rounded-[6px] border py-1.5 pr-1.5 pl-3">
      <div className="flex min-h-11 items-center justify-between gap-3 lg:min-h-8">
        <p className="min-w-0 truncate text-sm">
          {displayName} · <span className="text-fg-mute">{client.email}</span>
        </p>

        {/* `.client-item__more`, design/system/dashboard.html:388-393 — the
            ONE 44px control this row exposes; everything it opens is a full-
            width menu row, not a second small target. */}
        {hasActions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Acciones para ${displayName}`}
                className="text-fg-dim hover:bg-bg-2 hover:text-fg flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[6px] text-[17px] transition-colors lg:min-h-6 lg:min-w-6 lg:text-sm"
              >
                <span aria-hidden="true">⋯</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {resendable && (
                <DropdownMenuItem
                  disabled={resendPending}
                  onSelect={() => resendFormRef.current?.requestSubmit()}
                >
                  {resendPending ? "Reenviando…" : "Reenviar acceso"}
                </DropdownMenuItem>
              )}
              {removable && (
                // `variant="destructive"` is shadcn's OWN semantic
                // (`--destructive`, the oklch red #127 wired up for
                // `aria-invalid` and this exact prop) — a deliberate choice,
                // not an accident that happens to pair it with this screen's
                // `#e0796b`/`--app-danger` warning family (epic #125's rule
                // 2: the two reds must never sit side by side without being
                // chosen on purpose). They don't here: this menu item is
                // reachable only via the trigger's OWN popover, never
                // rendered next to the below-image `#e0796b` confirm warning
                // at the same time — the destructive-red menu item closes
                // before that warning ever appears. Using the primitive's
                // own destructive styling on a shadcn primitive is the
                // simplest correct choice; inventing a third red to match
                // `#e0796b` here would be the accident this rule warns
                // against, not the fix for it.
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                  Quitar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* No visible submit control — see this file's header comment on why
          the menu item above triggers this via a ref instead of a native
          submit button. */}
      {resendable && (
        <form ref={resendFormRef} action={resendFormAction}>
          <input type="hidden" name="galleryId" value={galleryId} />
          <input type="hidden" name="clientId" value={client.id} />
        </form>
      )}

      {removable && confirming && (
        <form action={removeFormAction} className="flex flex-col items-start gap-2 pb-1">
          <input type="hidden" name="galleryId" value={galleryId} />
          <input type="hidden" name="clientId" value={client.id} />
          <p className="text-xs text-[#e0796b]">{REMOVE_WARNING_BY_STATUS[status]}</p>
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={removePending}
              className="min-h-11 text-sm font-medium text-[#e0796b] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
            >
              {removePending ? "Quitando…" : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-fg-dim hover:text-accent-2 min-h-11 text-sm transition-colors lg:min-h-6"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {removeState.status === "error" && (
        <p role="alert" className="pb-1 text-xs text-[#e0796b]">
          {removeState.message}
        </p>
      )}

      {(resendState.status === "resend_email_failed" || resendState.status === "throttled") && (
        <p role="alert" className="pb-1 text-xs text-[#e0796b]">
          {resendState.message}
        </p>
      )}
      {resendState.status === "resent" && (
        <p role="status" className="text-accent-2 pb-1 text-xs">
          {resendState.message}
        </p>
      )}
    </div>
  );
}
