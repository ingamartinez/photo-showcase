// Maps the `error` query-string code Auth.js appends to its `pages.error`
// redirect (`/login?error=...`, configured in src/auth.ts) into a Spanish
// message for the login page.
//
// `Verification` is the one code worth naming: it is what Auth.js emits when
// a magic-link token is expired, already consumed, or otherwise not found —
// exactly the case a client hits by clicking a stale or reused email link.
// Every other code (`AccessDenied`, `Configuration`, `Default`, anything
// Auth.js adds later) collapses into a single generic message. This is not
// laziness: distinguishing them would mean telling a visitor things like "the
// signIn callback refused this address", which is precisely the kind of
// signal the anti-enumeration guarantee elsewhere on this page (see
// actions.ts) exists to withhold.
export function getLoginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;

  if (code === "Verification") {
    return "Este enlace ya venció o ya se usó. Pedí uno nuevo abajo.";
  }

  return "No pudimos verificar el enlace. Pedí uno nuevo abajo.";
}
