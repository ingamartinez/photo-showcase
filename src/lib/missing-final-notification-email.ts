// Task #93 — "a missing R2 object turns a client download into a bare 500":
// the notification half of the fix. The DESIGN DECISION itself (what status
// code a missing final produces) lives next to the two routes that make it —
// src/app/api/assets/[assetId]/final/route.ts and
// src/app/api/galleries/[galleryId]/download-all/route.ts — this module
// exists only to make sure a photographer actually finds out when it fires,
// same "the photographer finds out" split src/lib/admin-notification-email.ts
// already established for task #25.
//
// Composes and sends the "a delivered final is missing from storage" alert,
// PLUS the shared lookup-admin-and-send flow both routes call — unlike
// admin-notification-email.ts (which leaves the admin lookup and env reads to
// its one caller), this module owns that flow itself: the two conditions
// this fires on are not "a route's own small validation helper" (the kind of
// thing this codebase deliberately duplicates per-route, see e.g.
// download-all/route.ts's own stripExtension/slugifyForFilename comments) —
// they are the SAME side-effecting DB-plus-email flow, byte for byte, called
// from two different routes. Keeping one copy is what stops them drifting
// (one route notifying, the other silently not) the same way
// src/lib/final-access.ts's header argues for the read-side gate.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, type Gallery } from "@/lib/db/schema";
import { authEnv, resendEnv } from "@/lib/env";

const RESEND_API_URL = "https://api.resend.com/emails";

export type MissingFinalNotificationParams = {
  galleryTitle: string;
  /** Absolute URL into the admin dashboard's gallery detail page — same
   * "click straight into the work" reasoning as
   * admin-notification-email.ts's own `galleryUrl`. */
  galleryUrl: string;
  /** The asset(s) whose `final_key` the database says exists, but whose R2
   * object does not — original filenames, not raw keys or asset ids, so the
   * photographer reads something they recognize from their own export
   * rather than an opaque UUID. */
  missingFilenames: string[];
};

export function missingFinalNotificationEmailHtml(params: MissingFinalNotificationParams): string {
  const items = params.missingFilenames.map((name) => `<li>${name}</li>`).join("\n");
  return [
    "<p>Hola,</p>",
    `<p>Un cliente intentó descargar una foto entregada en <strong>${params.galleryTitle}</strong>, ` +
      "pero el archivo original ya no está en el almacenamiento. El cliente vio un error, no la foto.</p>",
    "<p>Archivos afectados:</p>",
    `<ul>${items}</ul>`,
    "<p>Volvé a subir el final de esas fotos para restablecer la descarga.</p>",
    `<p><a href="${params.galleryUrl}">Ver la galería en el panel</a></p>`,
  ].join("\n");
}

export function missingFinalNotificationEmailText(params: MissingFinalNotificationParams): string {
  return [
    `Un cliente intentó descargar una foto entregada en ${params.galleryTitle}, pero el archivo ` +
      "original ya no está en el almacenamiento. El cliente vio un error, no la foto.",
    "",
    "Archivos afectados:",
    ...params.missingFilenames.map((name) => `- ${name}`),
    "",
    "Volvé a subir el final de esas fotos para restablecer la descarga.",
    "",
    `Ver la galería en el panel: ${params.galleryUrl}`,
  ].join("\n");
}

/**
 * Sends the missing-final alert via Resend. Throws a plain `Error` on
 * failure — same reasoning as `sendSubmissionNotificationEmail`'s own
 * comment (src/lib/admin-notification-email.ts): this is called directly,
 * with a plain `await`, from inside a Route Handler's own try/catch, never
 * from behind an Auth.js provider boundary, so there is no reason to dress
 * this up as an `AuthError`.
 */
export async function sendMissingFinalNotificationEmail(
  params: MissingFinalNotificationParams & { apiKey: string; from: string; to: string },
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
        subject: `Falta un archivo entregado: ${params.galleryTitle}`,
        html: missingFinalNotificationEmailHtml(params),
        text: missingFinalNotificationEmailText(params),
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

/**
 * The full "photographer finds out" flow, shared by both routes that can hit
 * this gap: looks up the (single — PLAN.md §4) admin, reads the Resend/Auth
 * env lazily (never at module scope — see src/lib/env.ts's own header), and
 * sends the alert above. Best-effort BY DESIGN: this always runs on a
 * request that is ALREADY about to answer the client with an error (see the
 * two call sites) — a Resend outage here must never turn an already-failing
 * request into something worse, or mask the response the client is about to
 * get with an unrelated one. Swallows its own failure and returns, exactly
 * as `submit-selection`'s own notification try/catch does
 * (src/app/api/galleries/[galleryId]/submit-selection/route.ts) and for the
 * same reason.
 */
export async function notifyAdminOfMissingFinal(params: {
  gallery: Pick<Gallery, "id" | "title">;
  missingFilenames: string[];
}): Promise<void> {
  try {
    const [admin] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    if (!admin) return;

    const { RESEND_API_KEY, EMAIL_FROM } = resendEnv();
    const { AUTH_URL } = authEnv();

    await sendMissingFinalNotificationEmail({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: admin.email,
      galleryTitle: params.gallery.title,
      galleryUrl: new URL(`/dashboard/galleries/${params.gallery.id}`, AUTH_URL).toString(),
      missingFilenames: params.missingFilenames,
    });
  } catch {
    // Swallowed on purpose — see this function's own comment above.
  }
}
