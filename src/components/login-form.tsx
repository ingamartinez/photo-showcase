"use client";

import { useActionState } from "react";
import { requestMagicLink, type LoginActionState } from "@/app/(marketing)/login/actions";
import { CHECK_EMAIL_HEADER, CheckEmailNotice } from "@/components/check-email-notice";
import { PageHeader } from "@/components/page-header";

const initialState: LoginActionState = { status: "idle" };

// Owns the <PageHeader /> too, not just the form: the "sent" state used to
// swap only the form below while the header kept reading "Escribí el correo
// con el que reservaste la sesión…", contradicting the notice underneath it
// that said the link was already on its way. Flagged in #9's review — see
// src/components/check-email-notice.tsx's CHECK_EMAIL_HEADER for the fix,
// shared with the standalone /login/check-email page so the two can't drift
// apart again.
export function LoginForm({
  authErrorMessage,
}: {
  // Rendering error, if any, of Auth.js's own `pages.error` redirect
  // (`/login?error=...`, see src/auth.ts). Resolved server-side by
  // src/app/(marketing)/login/page.tsx via getLoginErrorMessage — this
  // component only displays it, alongside the request form, never in place
  // of it: whatever went wrong on a previous link, the client can still
  // request a new one right here.
  authErrorMessage?: string | null;
}) {
  const [state, formAction, pending] = useActionState(requestMagicLink, initialState);

  if (state.status === "sent") {
    // Rendered identically whether the address exists or not — the whole
    // point of the enumeration guard in src/auth.ts is worthless if this
    // screen (or its wording) ever differs.
    return (
      <>
        <PageHeader {...CHECK_EMAIL_HEADER} />
        <section className="wrap max-w-[440px] pb-[clamp(64px,10vh,120px)]">
          <CheckEmailNotice />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Acceso privado"
        title="Ingresá a tu galería."
        lead="Escribí el correo con el que reservaste la sesión. Te enviamos un enlace de acceso — sin contraseñas."
      />
      <section className="wrap max-w-[440px] pb-[clamp(64px,10vh,120px)]">
        <form action={formAction} className="flex flex-col gap-5" data-reveal>
          {authErrorMessage && (
            <p role="alert" className="text-sm text-[#e0796b]">
              {authErrorMessage}
            </p>
          )}
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
      </section>
    </>
  );
}
