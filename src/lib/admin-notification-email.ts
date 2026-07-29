// Composes and sends the "a client submitted their selection" notification —
// task #25's "the photographer finds out" half. Unlike
// src/lib/gallery-access-email.ts and src/lib/login-email.ts, this is a
// plain, direct Resend call made from a Route Handler
// (src/app/api/galleries/[galleryId]/submit-selection/route.ts), never from
// inside an Auth.js provider callback — there is no `signIn()`/`Auth()`
// boundary anywhere in this call path. That distinction matters for the
// error type this module throws; see `sendSubmissionNotificationEmail`'s own
// comment below for why it deliberately does NOT reuse those two siblings'
// `AuthError` convention.
//
// Split into its own module for the same reason as its two siblings: the
// Resend POST and the copy are unit-testable without booting anything else.
import { formatCop } from "@/lib/format";
import type { QuotaResult } from "@/lib/quota";

const RESEND_API_URL = "https://api.resend.com/emails";

export type SubmissionNotificationParams = {
  clientName: string | null;
  clientEmail: string;
  galleryTitle: string;
  /** Absolute URL into the admin dashboard's gallery detail page — the
   * photographer clicks straight into the work, no searching by client
   * name. Built by the route from `authEnv().AUTH_URL`, never guessed. */
  galleryUrl: string;
  /** The SAME `QuotaResult` (src/lib/quota.ts) the client's own live
   * counter renders — never re-derived here. What the photographer reads is
   * guaranteed to be exactly what the client saw before submitting. */
  quota: QuotaResult;
};

function clientLabel(params: SubmissionNotificationParams): string {
  return params.clientName?.trim() || params.clientEmail;
}

export function submissionNotificationEmailHtml(params: SubmissionNotificationParams): string {
  const { quota } = params;
  return [
    "<p>Hola,</p>",
    `<p><strong>${clientLabel(params)}</strong> (${params.clientEmail}) envió su selección para ` +
      `<strong>${params.galleryTitle}</strong>.</p>`,
    "<ul>",
    `<li>Incluidas: ${quota.includedPhotosSnapshot}</li>`,
    `<li>Seleccionadas: ${quota.selected}</li>`,
    `<li>Extras: ${quota.extras} × ${formatCop(quota.extraPhotoPriceCopSnapshot)} = ${formatCop(quota.surchargeCop)}</li>`,
    "</ul>",
    // The app never charges money (PLAN.md §3) — this line exists so the
    // photographer never mistakes "the client submitted" for "the client
    // paid". Nothing in this email is a payment action or a payment link.
    "<p>El cobro de los extras se coordina por fuera de la app (WhatsApp / transferencia).</p>",
    `<p><a href="${params.galleryUrl}">Ver la galería en el panel</a></p>`,
  ].join("\n");
}

export function submissionNotificationEmailText(params: SubmissionNotificationParams): string {
  const { quota } = params;
  return [
    `${clientLabel(params)} (${params.clientEmail}) envió su selección para ${params.galleryTitle}.`,
    "",
    `Incluidas: ${quota.includedPhotosSnapshot}`,
    `Seleccionadas: ${quota.selected}`,
    `Extras: ${quota.extras} × ${formatCop(quota.extraPhotoPriceCopSnapshot)} = ${formatCop(quota.surchargeCop)}`,
    "",
    "El cobro de los extras se coordina por fuera de la app (WhatsApp / transferencia).",
    "",
    `Ver la galería en el panel: ${params.galleryUrl}`,
  ].join("\n");
}

/**
 * Sends the submission notification via Resend. Throws a plain `Error` on
 * failure — deliberately NOT an `AuthError`, unlike
 * `sendGalleryAccessEmail`/`sendLoginEmail`.
 *
 * Those two throw `AuthError` because they are called from INSIDE an
 * Auth.js provider's `sendVerificationRequest`, itself invoked by
 * `@auth/core`'s `Auth()` during `signIn()` — and `Auth()` only re-throws an
 * `AuthError` back to `signIn()`'s caller, swallowing anything else into a
 * redirect `Response` (see those two files' own header comments for the
 * exact `@auth/core` trace). This function has no such boundary anywhere in
 * its call path: it is called directly, with a plain `await`, from
 * `src/app/api/galleries/[galleryId]/submit-selection/route.ts`'s own
 * try/catch — a normal JS rejection propagates out of that `await`
 * correctly regardless of its class. Throwing `AuthError` here would not be
 * wrong at the type level (it still extends `Error`), but it would be a
 * false signal to the next reader that this failure is somehow
 * authentication-related, when it's a Resend delivery failure with nothing
 * to do with `next-auth`.
 */
export async function sendSubmissionNotificationEmail(
  params: SubmissionNotificationParams & { apiKey: string; from: string; to: string },
): Promise<void> {
  const { apiKey, from, to } = params;

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
        subject: `Selección enviada: ${params.galleryTitle}`,
        html: submissionNotificationEmailHtml(params),
        text: submissionNotificationEmailText(params),
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to reach Resend: ${message}`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend error (${response.status}): ${body}`);
  }
}
