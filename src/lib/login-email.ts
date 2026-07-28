// Composes and sends the login magic-link email — the `sendVerificationRequest`
// half of the plain "resend" provider wired up in src/auth.ts (task #59).
// Split into its own module for the same reason as src/lib/gallery-access-email.ts
// (task #21): unit-testable in isolation, without booting the whole NextAuth()
// config factory.
//
// This replaces `@auth/core/providers/resend.js`'s own built-in
// `sendVerificationRequest`, which throws a PLAIN `Error` on failure (verified
// by reading node_modules/@auth/core/providers/resend.js directly) — see this
// file's `sendLoginEmail` header comment for why that plain-`Error` shape is
// the exact bug task #59 closes. The built-in template also lives in
// `@auth/core/lib/utils/email.js`, a path `@auth/core`'s own package.json
// "exports" map does NOT expose to consumers — reusing it here would be an
// unsupported deep import that can break on any patch upgrade — so the
// content below is a fresh Spanish template instead, matching the copy
// already on /login and /login/check-email rather than the library's
// English default. PLAN.md's deferred list includes "email templates" as its
// own future feature (branding, richer content); writing SOME copy here is
// unavoidable, not scope creep into that item, since the fetch call itself
// had to move into this module to control the thrown error's type.
import { AuthError } from "next-auth";

const RESEND_API_URL = "https://api.resend.com/emails";

export function loginEmailHtml(url: string): string {
  return [
    "<p>Hola,</p>",
    "<p>Hacé clic en el siguiente enlace para ingresar a tu galería:</p>",
    `<p><a href="${url}">Ingresar</a></p>`,
    "<p>Este enlace es personal — no lo compartas — y deja de funcionar en 15 minutos.</p>",
    "<p>Si no pediste este enlace, podés ignorar este correo.</p>",
  ].join("\n");
}

export function loginEmailText(url: string): string {
  return [
    "Hacé clic en el siguiente enlace para ingresar a tu galería:",
    "",
    url,
    "",
    "Este enlace es personal — no lo compartas — y deja de funcionar en 15 minutos.",
    "",
    "Si no pediste este enlace, podés ignorar este correo.",
  ].join("\n");
}

/**
 * Sends the login magic-link email via Resend. Throws an `AuthError` — never
 * a plain `Error` — on any failure.
 *
 * That distinction is load-bearing, not stylistic — same reasoning as
 * `sendGalleryAccessEmail` in src/lib/gallery-access-email.ts (task #21),
 * applied to the pre-existing login path per task #59: `@auth/core`'s
 * top-level `Auth()` handler only RE-THROWS an error caught from a provider
 * action (this function, called from inside `sendToken()`) back to
 * `signIn()`'s caller when that error is an `AuthError` instance — see
 * `node_modules/@auth/core/src/index.ts`'s catch block:
 * `if (isAuthError && isRaw && !isRedirect) throw error`. Anything else (a
 * plain `Error`, which is exactly what `@auth/core/providers/resend.js`'s
 * own built-in `sendVerificationRequest` throws on a non-2xx response) is
 * swallowed into a redirect `Response` toward the configured error page,
 * which `signIn(..., { redirect: false })` then returns as an ordinary URL
 * STRING, not a rejection. Without this wrapper, a Resend outage during a
 * magic-link request would make `src/app/(marketing)/login/actions.ts`
 * believe the send succeeded — `signIn()` would resolve, not reject — and
 * report "sent" to a user who will never receive the email.
 */
export async function sendLoginEmail(params: {
  apiKey: string;
  from: string;
  to: string;
  url: string;
}): Promise<void> {
  const { apiKey, from, to, url } = params;

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: "Ingresá a tu galería",
        html: loginEmailHtml(url),
        text: loginEmailText(url),
      }),
    });
  } catch (error) {
    // Same `AuthError` public-type caveat as `sendGalleryAccessEmail`: the
    // constructor's declared type only accepts `(message?, options?)`, so the
    // original failure goes in as `cause`, not as the first argument.
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthError(`Failed to reach Resend: ${message}`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AuthError(`Resend error (${response.status}): ${body}`);
  }
}
