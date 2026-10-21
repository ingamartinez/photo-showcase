"use client";

// TASK #279 — editing an existing client's name, email and WhatsApp.
//
// Follows dashboard-client-create-dialog.tsx + client-form.tsx: a dialog shell
// whose <DialogContent> carries its own <DialogHeader>, and an inner form that
// owns `useActionState`. Same entity, same page, so the two dialogs read as
// one pattern rather than two inventions.
//
// Like every dialog on this surface, <DialogContent> renders through a portal
// into `document.body`, OUTSIDE `[data-surface="app"]` — so nothing below uses
// an `app-*` utility (they would compute to nothing and paint blank). See
// dashboard-client-create-dialog.tsx's header comment for the long version.
// The `dashboard-` prefix is deliberately absent from this filename too: ESLint
// then applies the repo's own `app-*` ban to the whole file, which is the guard
// that trap needs.
import { useActionState, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updateClient, type UpdateClientState } from "@/app/dashboard/clients/actions";

const initialState: UpdateClientState = { status: "idle" };

// Same literal stand-ins as client-form.tsx / edit-gallery-terms-dialog.tsx:
// these forms all render through the same portal, so they all read brand
// tokens and Tailwind's own scales rather than the `app-*` token layer.
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-[5px] border bg-transparent px-4 py-3 text-sm transition-colors outline-none";

/** The four fields the row already has — no extra query, and no `createdAt`
 * or `role` for this dialog to mistakenly offer. */
export type EditableClient = {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
};

export function EditClientDialog({
  client,
  open,
  onOpenChange,
  onUpdated,
  onCloseAutoFocus,
}: {
  client: EditableClient;
  /** Controlled: the opener is a menu item, not a <DialogTrigger>, so this
   * dialog renders no trigger of its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
  /** Forwarded to <DialogContent>: the element focused when the dialog opened
   * was a menu item that no longer exists, so the row hands focus back to its
   * own trigger instead of letting it fall to `<body>`. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="text-fg text-lg font-medium">Editar cliente</DialogTitle>
          <DialogDescription className="text-fg-dim">
            Corrige el nombre, el correo o el WhatsApp. El correo es la identidad del cliente: con
            ese mismo correo inicia sesión.
          </DialogDescription>
        </DialogHeader>

        {/*
          The form is INSIDE <DialogContent>, and its `useActionState` lives
          here rather than in the shell for a reason: Radix unmounts the
          content on close, so every open starts a fresh action state — current
          values, and no error left over from the previous attempt. Lifting the
          hook into <EditClientDialog> would keep a stale error across opens.
        */}
        <EditClientForm client={client} onUpdated={onUpdated} />
      </DialogContent>
    </Dialog>
  );
}

function EditClientForm({ client, onUpdated }: { client: EditableClient; onUpdated: () => void }) {
  const [state, formAction, pending] = useActionState(updateClient, initialState);

  // Narrowed to a boolean, not the state object: `state` is a fresh object on
  // every action result, so "error -> error" must never re-fire this (same
  // reasoning as client-form.tsx).
  const updated = state.status === "updated";
  useEffect(() => {
    if (updated) onUpdated();
  }, [updated, onUpdated]);

  // Task #50's mechanism, reused verbatim: React 19 resets a
  // `<form action={fn}>`'s uncontrolled inputs at submit time, so on error
  // `defaultValue` is fed the RAW submitted values and the reset restores
  // them; on anything else it falls back to the client's stored values.
  // client-form.tsx's own comment explains why `defaultValue` and not
  // controlled state is what this hangs on.
  const values = state.status === "error" ? state.values : undefined;

  const defaultName = values?.name ?? client.name ?? "";
  const defaultEmail = values?.email ?? client.email;
  const defaultPhone = values?.phone ?? client.phone ?? "";

  // Email-change notice (epic #278, decision 3; task #279 item 4). This is a
  // UX preview only — the server normalizes whatever it receives, so a user
  // who types the stored address with different case or spacing gets no
  // notice and no surprise either.
  //
  // The input stays UNCONTROLLED (`defaultValue` + `onChange`, no `value`), so
  // the form reset above still works; this state only mirrors what is typed,
  // seeded from the same expression so a rejected submit keeps the notice
  // consistent with the values on screen.
  const [draftEmail, setDraftEmail] = useState(defaultEmail);
  const emailChanged = draftEmail.trim().toLowerCase() !== client.email;

  const describedBy =
    [
      emailChanged ? "edit-client-email-notice" : null,
      state.status === "error" ? "edit-client-error" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="userId" value={client.id} />

      <div className="flex flex-col gap-2">
        <label htmlFor="edit-client-name" className="text-fg-mute text-xs tracking-wide uppercase">
          Nombre
        </label>
        <input
          id="edit-client-name"
          name="name"
          type="text"
          required
          autoComplete="name"
          placeholder="Nombre y apellido"
          defaultValue={defaultName}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="edit-client-email" className="text-fg-mute text-xs tracking-wide uppercase">
          Correo electrónico
        </label>
        <input
          id="edit-client-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="cliente@ejemplo.com"
          defaultValue={defaultEmail}
          onChange={(event) => setDraftEmail(event.target.value)}
          aria-invalid={state.status === "error"}
          aria-describedby={describedBy}
          className={inputClass}
        />
        {emailChanged && (
          // Not a live region on purpose: it would re-announce on every
          // keystroke that flips it. It reaches assistive tech through the
          // email input's `aria-describedby` above.
          <p id="edit-client-email-notice" className="text-fg-dim text-xs">
            Este correo es su identidad para entrar: el próximo enlace de acceso le va a llegar al
            nuevo. La app no le avisa del cambio — avísale tú.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="edit-client-phone" className="text-fg-mute text-xs tracking-wide uppercase">
          WhatsApp (opcional)
        </label>
        <input
          id="edit-client-phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          placeholder="+57 300 000 0000"
          defaultValue={defaultPhone}
          className={inputClass}
        />
      </div>

      {state.status === "error" && (
        <p id="edit-client-error" role="alert" className="text-danger text-sm">
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Guardar cambios"}
      </button>
    </form>
  );
}
