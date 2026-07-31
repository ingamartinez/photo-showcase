"use client";

import { useActionState, useEffect } from "react";
import { createClient, type CreateClientState } from "@/app/dashboard/clients/actions";

const initialState: CreateClientState = { status: "idle" };

const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-sm border bg-transparent px-4 py-3 text-[15px] transition-colors outline-none";

export function ClientForm({
  onCreated,
}: {
  // Task #132 moved this form into a "Nuevo cliente" dialog
  // (src/components/dashboard-client-create-dialog.tsx), the same shape
  // task #131 used for <GalleryForm>. This is the ONLY thing the form learns
  // about that move, and it is optional: rendered on its own — every test in
  // client-form.test.tsx except the two at its bottom does exactly that — the
  // component behaves exactly as it did before, success message included.
  onCreated?: () => void;
} = {}) {
  const [state, formAction, pending] = useActionState(createClient, initialState);

  // Narrowed to a boolean, not the state object, same reasoning as
  // gallery-form.tsx: `state` is a fresh object on every action result, so a
  // rejected submit (error -> error) must never re-fire this.
  const created = state.status === "created";
  useEffect(() => {
    if (created) onCreated?.();
  }, [created, onCreated]);

  // No manual reset needed here: for a <form action={fn}> with uncontrolled
  // inputs, React 19 itself calls `requestFormReset` synchronously at submit
  // time (see react-dom's `startHostTransition`) — before `createClient` even
  // runs, not after it resolves. So every submission blanks the fields,
  // success or error alike.
  //
  // Task #50: that reset is the reason this form needs `defaultValue` at all,
  // and it is also what makes `defaultValue` work. A form reset clears each
  // input's dirty-value flag, after which the input's displayed value follows
  // its `value` ATTRIBUTE again — which is what React writes when the
  // `defaultValue` prop changes. So the sequence on a rejected duplicate is:
  // submit blanks the fields, `createClient` resolves with `status: "error"`
  // and the submitted `values`, the re-render puts those values into
  // `defaultValue`, and the (no longer dirty) inputs show them again. This is
  // React 19's own documented way to keep a rejected submission on screen; it
  // does NOT require lifting the fields into controlled state, and an earlier
  // version of this comment was wrong to claim otherwise.
  //
  // Only the error branch feeds values back. On success `values` is absent, so
  // `defaultValue` returns to "" and the form is empty for the next client —
  // the reset's own behavior, kept deliberately rather than worked around.
  const values = state.status === "error" ? state.values : undefined;

  return (
    // Task #132: the card chrome (`border p-6`) and the "Nuevo cliente"
    // eyebrow both moved OUT of here — same move task #131 made on
    // <GalleryForm> — because the dialog that now wraps this form supplies
    // its own padding and its own <DialogTitle> with that exact wording.
    <form action={formAction} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor="name" className="label text-fg-mute">
          Nombre
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoComplete="name"
          placeholder="Nombre y apellido"
          defaultValue={values?.name ?? ""}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="label text-fg-mute">
          Correo electrónico
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="cliente@ejemplo.com"
          defaultValue={values?.email ?? ""}
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "client-form-error" : undefined}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="phone" className="label text-fg-mute">
          WhatsApp (opcional)
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          placeholder="+57 300 000 0000"
          defaultValue={values?.phone ?? ""}
          className={inputClass}
        />
      </div>

      {state.status === "error" && (
        <p id="client-form-error" role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
      {state.status === "created" && (
        <p role="status" className="text-accent-2 text-sm">
          Cliente agregado.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:border-accent hover:text-accent-2 rounded-sm border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Agregar cliente"}
      </button>
    </form>
  );
}
