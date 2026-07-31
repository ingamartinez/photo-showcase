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

// Task #135 sweep: `text-[15px]` was an ad-hoc one-off (the "each screen
// invents its own scale" defect globals.css's app-surface comment names
// directly). `text-sm` (14px) instead, matching `--app-text-base`'s own
// value rather than the token itself: this file is not named `dashboard-*`
// and does not live under `src/app/dashboard/**`, so task #175's ESLint
// rule correctly refuses `app-*` utilities here even though the component
// only ever renders inside that scope.
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute text-sm rounded-[5px] border bg-transparent px-4 py-3 transition-colors outline-none";

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
      {/* Task #133: no `.label` (globals.css's mono, uppercase,
          0.22em-tracked eyebrow style) survives under /dashboard — epic
          #125's own done-when. Plain text instead. */}
      <label htmlFor="attach-client-ids" className="text-fg-mute text-xs tracking-wide uppercase">
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

      {/* Task #135 sweep: this used to be the marketing CTA — uppercase,
          0.1em-tracked, 13px. The mock's own plain `.btn`
          (design/system/dashboard.html:220-227) never uppercases or tracks a
          button label; its only states are a border and an `--app-raised`
          hover wash, never brass (epic #125's rule that brass is a fill,
          never a hover/focus wash). Brand tokens (`bg-bg-2`), not `app-*` —
          see `inputClass`'s own comment above for why this file cannot name
          the token, and `bg-bg-2` is `--app-raised`'s own value anyway. */}
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center self-start rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
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
