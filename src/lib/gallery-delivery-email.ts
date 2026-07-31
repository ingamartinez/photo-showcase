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
// Same plain-fetch-against-Resend approach as gallery-access-email.ts, for
// the same reasons documented there.
import { AuthError } from "next-auth";

const RESEND_API_URL = "https://api.resend.com/emails";

export function galleryDeliveryEmailHtml(url: string): string {
  return [
    "<p>Hola,</p>",
    "<p>Ya terminamos de editar tus fotos y están listas para descargar. Hacé clic en el " +
      "siguiente enlace para entrar a tu galería:</p>",
    `<p><a href="${url}">Descargar mis fotos</a></p>`,
    "<p>Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.</p>",
  ].join("\n");
}

export function galleryDeliveryEmailText(url: string): string {
  return [
    "Ya terminamos de editar tus fotos y están listas para descargar.",
    "",
    `Entrá a tu galería: ${url}`,
    "",
    "Este enlace es personal — no lo compartas — y deja de funcionar en 48 horas.",
  ].join("\n");
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
        subject: "Tus fotos editadas ya están listas para descargar",
        html: galleryDeliveryEmailHtml(url),
        text: galleryDeliveryEmailText(url),
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthError(`Failed to reach Resend: ${message}`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AuthError(`Resend error (${response.status}): ${body}`);
  }
}
