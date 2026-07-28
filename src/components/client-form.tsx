"use client";

import { useActionState } from "react";
import { createClient, type CreateClientState } from "@/app/dashboard/clients/actions";

const initialState: CreateClientState = { status: "idle" };

const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-sm border bg-transparent px-4 py-3 text-[15px] transition-colors outline-none";

export function ClientForm() {
  const [state, formAction, pending] = useActionState(createClient, initialState);

  // No manual reset needed here: for a <form action={fn}> with uncontrolled
  // inputs, React 19 itself calls `requestFormReset` synchronously at submit
  // time (see react-dom's `startHostTransition`) — before `createClient` even
  // runs, not after it resolves. So every submission blanks the fields,
  // success or error alike; there is no built-in way to keep, say, a
  // duplicate email visible for the photographer to correct without lifting
  // the fields into controlled state, which this simple admin form doesn't
  // need.
  return (
    <form action={formAction} className="border-line-2 flex flex-col gap-5 rounded-sm border p-6">
      <span className="label text-fg-mute">Nuevo cliente</span>

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
