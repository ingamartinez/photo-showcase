// Composes and sends the "your gallery is ready" magic-link email — the
// `sendVerificationRequest` half of the "gallery-access" Resend provider
// wired up in src/auth.ts (task #21). Split into its own module so it is
// unit-testable in isolation, without booting the whole NextAuth() config
// factory (which reads env lazily, per src/auth.ts's own header comment).
//
// Plain fetch against the Resend REST API — same approach as Auth.js's own
// built-in "resend" provider (node_modules/@auth/core/providers/resend.js)
// and scripts/check-resend.ts. The `resend` npm package is a listed
// dependency but is used nowhere in `src/`; introducing its SDK client here
// would be a second, inconsistent way of doing the exact same HTTP call.
import { AuthError } from "next-auth";

const RESEND_API_URL = "https://api.resend.com/emails";

// Kept deliberately generic: `sendVerificationRequest` only ever receives
// the recipient's email and the magic-link URL (see the provider callback
// signature in @auth/core) — never which gallery triggered the publish, so
// this copy cannot name a title or session date without a second lookup
// keyed off the URL's own callbackUrl param. Not worth the indirection for
// this slice; the acceptance criterion is "a real email arrives", not
// "the email names the gallery".
export function galleryAccessEmailHtml(url: string): string {
  return [
    "<p>Hola,</p>",
    "<p>Tus fotos ya están listas para ver. Hacé clic en el siguiente enlace para entrar a tu galería:</p>",
    `<p><a href="${url}">Ver mis fotos</a></p>`,
    "<p>Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.</p>",
  ].join("\n");
}

export function galleryAccessEmailText(url: string): string {
  return [
    "Tus fotos ya están listas para ver.",
    "",
    `Entrá a tu galería: ${url}`,
    "",
    "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  ].join("\n");
}

/**
 * Sends the gallery-access magic-link email via Resend. Throws an
 * `AuthError` — never a plain `Error` — on any failure.
 *
 * That distinction is load-bearing, not stylistic. `@auth/core`'s top-level
 * `Auth()` handler only RE-THROWS an error caught from a provider action
 * (e.g. this function, called from inside `sendToken()`) back to
 * `signIn()`'s caller when that error is an `AuthError` instance — see
 * `node_modules/@auth/core/src/index.ts`'s catch block:
 * `if (isAuthError && isRaw && !isRedirect) throw error`. Anything else
 * (a plain `Error`) is swallowed into a redirect `Response` toward the
 * configured error page, which `signIn(..., { redirect: false })` then
 * returns as an ordinary URL STRING, not a rejection. A plain
 * `throw new Error(...)` here would make the publish action
 * (src/app/dashboard/galleries/actions.ts) believe the send succeeded —
 * `signIn()` would resolve, not reject — and flip the gallery to
 * "proofing" with no email ever delivered: exactly the half-published
 * state task #21 forbids. Verified by reading the exact `@auth/core`
 * version installed in this repo's `node_modules`, not assumed from public
 * docs (see the src/app/dashboard/galleries/actions.ts header comment and
 * this task's engram note for the full trace).
 */
export async function sendGalleryAccessEmail(params: {
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
        subject: "Tus fotos ya están listas",
        html: galleryAccessEmailHtml(url),
        text: galleryAccessEmailText(url),
      }),
    });
  } catch (error) {
    // `AuthError`'s public type (re-exported from "next-auth") only declares
    // `Error`'s own `(message?: string, options?: ErrorOptions)`
    // constructor — @auth/core's runtime accepts an `Error` as the first
    // argument too, but the public .d.ts does not say so. Passing a string
    // message plus the original error as `cause` is both type-correct and
    // preserves the original failure for logging.
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthError(`Failed to reach Resend: ${message}`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AuthError(`Resend error (${response.status}): ${body}`);
  }
}
