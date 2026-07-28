"use client";

import { useActionState } from "react";
import { requestMagicLink, type LoginActionState } from "@/app/(marketing)/login/actions";
import { CheckEmailNotice } from "@/components/check-email-notice";

const initialState: LoginActionState = { status: "idle" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(requestMagicLink, initialState);

  if (state.status === "sent") {
    // Rendered identically whether the address exists or not — the whole
    // point of the enumeration guard in src/auth.ts is worthless if this
    // screen (or its wording) ever differs.
    return <CheckEmailNotice />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" data-reveal>
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
          placeholder="vos@ejemplo.com"
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "email-error" : undefined}
          className="border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-sm border bg-transparent px-4 py-3 text-[15px] transition-colors outline-none"
        />
        {state.status === "error" && (
          <p id="email-error" role="alert" className="text-sm text-[#e0796b]">
            {state.message}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="border-line-2 hover:border-accent hover:text-accent-2 rounded-sm border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Enviando…" : "Enviar enlace de acceso"}
      </button>
    </form>
  );
}
