// Composes and sends the "your gallery is ready" magic-link email — the
// `sendVerificationRequest` half of the "gallery-access" Resend provider
// wired up in src/auth.ts (task #21). Split into its own module so it is
// unit-testable in isolation, without booting the whole NextAuth() config
// factory (which reads env lazily, per src/auth.ts's own header comment).
//
// Task #153 moved the HTML/text rendering onto the shared CLIENT-facing
// skeleton in src/lib/email-template.ts and the Resend call onto the shared
// transport in src/lib/email-transport.ts. Both are now unified across the
// three client emails this task owns (this file, gallery-delivery-email.ts,
// gallery-unlock-email.ts). See email-template.ts's header comment for the
// deliverability constraints (no images, single link, inline styles, light
// background) that shaped the design.
import { AuthError } from "next-auth";
import { sendResendEmail } from "./email-transport";
import { renderEditorialEmailHtml, renderEditorialEmailText } from "./email-template";

// Kept deliberately generic: `sendVerificationRequest` only ever receives
// the recipient's email and the magic-link URL (see the provider callback
// signature in @auth/core) — never which gallery triggered the publish, so
// this copy cannot name a title or session date without a second lookup
// keyed off the URL's own callbackUrl param. Not worth the indirection for
// this slice; the acceptance criterion is "a real email arrives", not
// "the email names the gallery".
export function galleryAccessEmailHtml(url: string): string {
  return renderEditorialEmailHtml({
    messageHtml: [
      '<p style="margin:0 0 12px 0;">Hola,</p>',
      '<p style="margin:0;">Tus fotos ya están listas para ver. Hacé clic en el siguiente enlace para entrar a tu galería:</p>',
    ].join("\n"),
    ctaUrl: url,
    ctaLabel: "Ver mis fotos",
    footnoteHtml: "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  });
}

export function galleryAccessEmailText(url: string): string {
  return renderEditorialEmailText({
    messageText: "Tus fotos ya están listas para ver.",
    ctaUrl: url,
    footnoteText: "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  });
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

  await sendResendEmail(
    {
      apiKey,
      from,
      to,
      subject: "Tus fotos ya están listas",
      html: galleryAccessEmailHtml(url),
      text: galleryAccessEmailText(url),
    },
    // Same `AuthError` public-type caveat noted in the original version of
    // this function: the constructor's declared type only accepts
    // `(message?, options?)`, so the original failure goes in as `cause`,
    // not as the first argument.
    (message, cause) => new AuthError(message, { cause }),
  );
}
