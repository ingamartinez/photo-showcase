// Composes and sends the "your edited photos are ready to download" magic-
// link email — the `sendVerificationRequest` half of the "gallery-delivery"
// Resend provider wired up in src/auth.ts (task #85). Split into its own
// module for the same reason as its sibling src/lib/gallery-access-email.ts
// (task #21): unit-testable in isolation, without booting the whole
// NextAuth() config factory.
//
// Task #27 shipped `deliverGallery` reusing `signIn("gallery-access", ...)` —
// the SAME provider and copy `publishGallery` uses ("Tus fotos ya están
// listas") — specifically because a bare `/galleries/{slug}` URL would risk a
// login wall this many weeks after publish (see #27's own review, and
// src/app/dashboard/galleries/actions.ts's `deliverGallery` header comment
// for the full reasoning, which this module does not change). #85's whole
// point is the SIDE EFFECT of that reuse: a client whose selection is done
// gets an email that reads identically to "come and choose your photos",
// which is the wrong message the one time it matters most — the finished
// photos they paid for. This module gives delivery its own copy while
// keeping the exact same magic-link mechanism (same token behaviour, same
// session-establishing click) `deliverGallery` already relied on.
//
// Kept deliberately generic, same reasoning as `galleryAccessEmailHtml`'s own
// header comment: `sendVerificationRequest` only ever receives the
// recipient's email and the magic-link URL, never which gallery was
// delivered — this copy cannot name a title without a second lookup keyed off
// the URL's own callbackUrl param. Not worth the indirection for this slice.
//
// Task #153 moved the HTML/text rendering onto the shared CLIENT-facing
// skeleton in src/lib/email-template.ts and the Resend call onto the shared
// transport in src/lib/email-transport.ts. See email-template.ts's header
// comment for the deliverability constraints that shaped the design.
import { AuthError } from "next-auth";
import { sendResendEmail } from "./email-transport";
import { renderEditorialEmailHtml, renderEditorialEmailText } from "./email-template";

export function galleryDeliveryEmailHtml(url: string): string {
  return renderEditorialEmailHtml({
    messageHtml: [
      '<p style="margin:0 0 12px 0;">Hola,</p>',
      '<p style="margin:0;">Ya terminamos de editar tus fotos y están listas para descargar. Hacé clic en el ' +
        "siguiente enlace para entrar a tu galería:</p>",
    ].join("\n"),
    ctaUrl: url,
    ctaLabel: "Descargar mis fotos",
    footnoteHtml: "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  });
}

export function galleryDeliveryEmailText(url: string): string {
  return renderEditorialEmailText({
    messageText: "Ya terminamos de editar tus fotos y están listas para descargar.",
    ctaUrl: url,
    footnoteText: "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  });
}

/**
 * Sends the gallery-delivery magic-link email via Resend. Throws an
 * `AuthError` — never a plain `Error` — on any failure.
 *
 * Same load-bearing reasoning as `sendGalleryAccessEmail`
 * (src/lib/gallery-access-email.ts): this runs inside an Auth.js provider's
 * `sendVerificationRequest`, and `@auth/core`'s `Auth()` only re-throws an
 * `AuthError` back to `signIn()`'s caller, swallowing anything else into a
 * redirect `Response` that `signIn(..., { redirect: false })` then returns as
 * an ordinary URL STRING, not a rejection. A plain `Error` here would make
 * `deliverGallery` (src/app/dashboard/galleries/actions.ts) believe the send
 * succeeded when it did not.
 */
export async function sendGalleryDeliveryEmail(params: {
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
      subject: "Tus fotos editadas ya están listas para descargar",
      html: galleryDeliveryEmailHtml(url),
      text: galleryDeliveryEmailText(url),
    },
    (message, cause) => new AuthError(message, { cause }),
  );
}
