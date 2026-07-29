// Composes and sends the "your selection is editable again" email — the
// half of task #73 that satisfies its own acceptance criterion: "the client
// must LEARN their selection is editable again — silently reopening it
// means they never touch it and the photographer waits forever." Sent by
// `unlockSelection` (src/app/dashboard/galleries/actions.ts) the moment a
// `selected` gallery is moved back to `proofing`.
//
// Same shape as its sibling src/lib/admin-notification-email.ts: a plain,
// direct Resend REST call, not a `resend` SDK client, not routed through an
// Auth.js provider — there is no `signIn()`/`Auth()` boundary anywhere in
// this call path (unlike src/lib/gallery-access-email.ts /
// src/lib/login-email.ts), so this throws a plain `Error` on failure, not
// an `AuthError` — see `sendSubmissionNotificationEmail`'s own comment in
// that sibling file for the exact reasoning, which applies unchanged here.
//
// Split into its own module for the same reason as both siblings: the
// Resend POST and the copy are unit-testable without booting anything else.
import { formatCop } from "@/lib/format";
import type { QuotaResult } from "@/lib/quota";

const RESEND_API_URL = "https://api.resend.com/emails";

export type UnlockNotificationParams = {
  clientName: string | null;
  clientEmail: string;
  galleryTitle: string;
  /** Absolute URL into the CLIENT's own gallery page
   * (`/galleries/[publicSlug]`) — never the admin dashboard URL
   * (`sendSubmissionNotificationEmail`'s `galleryUrl` points there instead,
   * for the admin). Built by `unlockSelection` from the gallery's own
   * `publicSlug`, per schema.ts's comment on why that column, not the
   * internal id, is the only identifier allowed in a client-facing URL. */
  galleryUrl: string;
  /** The admin's optional note (task #73's "consider a reason field" scope
   * note) — `null` when the admin left it blank. Surfaced to the CLIENT
   * deliberately: a reason like "hablamos por WhatsApp, agregá 2 fotos más"
   * is context the client themselves needs, not an internal-only note. */
  reason: string | null;
  /** The quota as it stood at the moment of unlock — since a `selected`
   * gallery's assets cannot be toggled (`SELECTION_LOCKED_STATUSES` on the
   * sibling PATCH route), this is exactly what the client had submitted.
   * Same "the SAME QuotaResult the client's own live counter renders, never
   * re-derived" stance as `sendSubmissionNotificationEmail`'s own `quota`
   * param — never recomputed from the live `packages` row here. */
  quota: QuotaResult;
};

function clientLabel(params: UnlockNotificationParams): string {
  return params.clientName?.trim() || params.clientEmail;
}

export function unlockNotificationEmailHtml(params: UnlockNotificationParams): string {
  const { quota } = params;
  return [
    `<p>Hola ${clientLabel(params)},</p>`,
    `<p>Tu selección de fotos para <strong>${params.galleryTitle}</strong> volvió a estar ` +
      "disponible para editar — tu fotógrafo la desbloqueó.</p>",
    params.reason ? `<p>Nota de tu fotógrafo: ${params.reason}</p>` : "",
    "<p>Así estaba tu selección cuando la enviaste:</p>",
    "<ul>",
    `<li>Incluidas: ${quota.includedPhotosSnapshot}</li>`,
    `<li>Seleccionadas: ${quota.selected}</li>`,
    `<li>Extras: ${quota.extras} × ${formatCop(quota.extraPhotoPriceCopSnapshot)} = ${formatCop(quota.surchargeCop)}</li>`,
    "</ul>",
    `<p><a href="${params.galleryUrl}">Ver mi galería</a></p>`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function unlockNotificationEmailText(params: UnlockNotificationParams): string {
  const { quota } = params;
  return [
    `Hola ${clientLabel(params)},`,
    "",
    `Tu selección de fotos para ${params.galleryTitle} volvió a estar disponible para editar — ` +
      "tu fotógrafo la desbloqueó.",
    params.reason ? `\nNota de tu fotógrafo: ${params.reason}` : "",
    "\nAsí estaba tu selección cuando la enviaste:",
    `Incluidas: ${quota.includedPhotosSnapshot}`,
    `Seleccionadas: ${quota.selected}`,
    `Extras: ${quota.extras} × ${formatCop(quota.extraPhotoPriceCopSnapshot)} = ${formatCop(quota.surchargeCop)}`,
    `\nVer mi galería: ${params.galleryUrl}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Sends the unlock notification via Resend. Throws a plain `Error` on
 * failure — deliberately NOT an `AuthError`, for the identical reason
 * `sendSubmissionNotificationEmail` (src/lib/admin-notification-email.ts)
 * documents on itself: this function is called directly, with a plain
 * `await`, from `unlockSelection`'s own try/catch — there is no `Auth()`
 * boundary anywhere in this call path to swallow anything but an
 * `AuthError` into a silent redirect.
 */
export async function sendUnlockNotificationEmail(
  params: UnlockNotificationParams & { apiKey: string; from: string; to: string },
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
        subject: `Podés volver a editar tu selección: ${params.galleryTitle}`,
        html: unlockNotificationEmailHtml(params),
        text: unlockNotificationEmailText(params),
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
