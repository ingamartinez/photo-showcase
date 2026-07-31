// Composes and sends the "your selection is editable again" magic-link
// email — the `sendVerificationRequest` half of the "gallery-unlock" Resend
// provider wired up in src/auth.ts (task #85). Split into its own module for
// the same reason as its sibling src/lib/gallery-access-email.ts (task #21):
// unit-testable in isolation, without booting the whole NextAuth() config
// factory.
//
// Task #85 replaces what task #73 originally shipped for this notification —
// a plain, direct Resend call from inside `unlockSelection` itself
// (src/lib/unlock-notification-email.ts, now removed) that built a BARE
// `/galleries/{publicSlug}` URL, not a magic link. That was a real gap: a
// `selected` gallery can sit unlocked days after the client's original
// publish-time session (`GALLERY_ACCESS_MAX_AGE_SECONDS`'s TOKEN lifetime is
// short; the SESSION it establishes on click lives far longer, but is not
// eternal) has expired, and a bare URL into an expired session is a login
// wall, not "a working link" — see src/app/dashboard/galleries/actions.ts's
// own `deliverGallery` header comment, which made exactly this argument for
// delivery and is now applied uniformly to unlock too. Reusing this whole
// provider pipeline (token generation, the `signIn` callback's
// account-enumeration guard, session creation on click) is what actually
// guarantees a working link regardless of how stale the client's last
// session is.
//
// The tradeoff this pays for that guarantee: `sendVerificationRequest` only
// ever receives the recipient's email and the magic-link URL (see the
// provider callback signature in @auth/core) — never which gallery was
// unlocked, nor the admin's optional reason, nor the quota the client had
// submitted. The previous bespoke email surfaced all three; this one cannot,
// for the identical reason `galleryAccessEmailHtml`'s own header comment
// already accepted for #21 ("not worth the indirection for this slice"). The
// admin's reason and the quota snapshot are still recorded on the gallery row
// itself (`unlockedByEmail`/`unlockReason`, schema.ts) — #73's audit
// acceptance criterion is unaffected — only the copy shown to the CLIENT lost
// that detail.
//
// Task #153 moved the HTML/text rendering onto the shared CLIENT-facing
// skeleton in src/lib/email-template.ts and the Resend call onto the shared
// transport in src/lib/email-transport.ts. See email-template.ts's header
// comment for the deliverability constraints that shaped the design.
import { AuthError } from "next-auth";
import { sendResendEmail } from "./email-transport";
import { renderEditorialEmailHtml, renderEditorialEmailText } from "./email-template";

export function galleryUnlockEmailHtml(url: string): string {
  return renderEditorialEmailHtml({
    messageHtml: [
      '<p style="margin:0 0 12px 0;">Hola,</p>',
      '<p style="margin:0;">Tu selección de fotos volvió a estar disponible para editar. Hacé clic en el siguiente ' +
        "enlace para entrar a tu galería:</p>",
    ].join("\n"),
    ctaUrl: url,
    ctaLabel: "Editar mi selección",
    footnoteHtml: "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  });
}

export function galleryUnlockEmailText(url: string): string {
  return renderEditorialEmailText({
    messageText: "Tu selección de fotos volvió a estar disponible para editar.",
    ctaUrl: url,
    footnoteText: "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  });
}

/**
 * Sends the gallery-unlock magic-link email via Resend. Throws an
 * `AuthError` — never a plain `Error` — on any failure.
 *
 * Same load-bearing reasoning as `sendGalleryAccessEmail`
 * (src/lib/gallery-access-email.ts): this runs inside an Auth.js provider's
 * `sendVerificationRequest`, and `@auth/core`'s `Auth()` only re-throws an
 * `AuthError` back to `signIn()`'s caller, swallowing anything else into a
 * redirect `Response` that `signIn(..., { redirect: false })` then returns as
 * an ordinary URL STRING, not a rejection. A plain `Error` here would make
 * `unlockSelection` (src/app/dashboard/galleries/actions.ts) believe the send
 * succeeded when it did not.
 */
export async function sendGalleryUnlockEmail(params: {
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
      subject: "Podés volver a editar tu selección",
      html: galleryUnlockEmailHtml(url),
      text: galleryUnlockEmailText(url),
    },
    (message, cause) => new AuthError(message, { cause }),
  );
}
