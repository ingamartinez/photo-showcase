// The "we sent you something, maybe" confirmation. Deliberately shared between
// the inline state of <LoginForm /> and the standalone /login/check-email page
// (where Auth.js's own `pages.verifyRequest` redirect lands), so the wording
// cannot drift apart. It must stay neutral: "si el correo está registrado" is
// what keeps an unknown address indistinguishable from a known one.
export function CheckEmailNotice() {
  return (
    <div className="border-line rounded-sm border p-6" role="status" data-reveal>
      <span className="label text-accent">Revisá tu correo</span>
      <p className="text-fg-dim mt-3 text-sm leading-relaxed">
        Si el correo está registrado, te enviamos un enlace de acceso. Es válido por 15 minutos y se
        abre en este mismo dispositivo — revisá también la carpeta de spam.
      </p>
    </div>
  );
}
