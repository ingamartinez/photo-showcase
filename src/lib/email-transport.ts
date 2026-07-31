// Single place that actually calls `https://api.resend.com/emails`.
//
// Before task #153, six sibling modules under src/lib/ (gallery-access-email,
// gallery-delivery-email, gallery-unlock-email, login-email,
// admin-notification-email, missing-final-notification-email) each carried an
// IDENTICAL copy of this fetch call — verified 6/6 while reading this task's
// kanban card. That is the exact class of duplication `gallery-access.ts`
// exists to avoid on the authorization side; this module is the equivalent
// fix for the sending side.
//
// Scope note: this task's territory is restricted to the three CLIENT-facing
// (editorial) modules — gallery-access-email.ts, gallery-delivery-email.ts,
// gallery-unlock-email.ts. Those three now call `sendResendEmail` below.
// login-email.ts, admin-notification-email.ts and
// missing-final-notification-email.ts are owned by sibling lanes running
// concurrently and are UNTOUCHED by this change; they still have their own
// copy of the fetch call. Migrating them to this shared transport is a
// natural follow-up but is out of scope here — do not do it by stealth.
//
// Plain fetch against the Resend REST API — same approach as Auth.js's own
// built-in "resend" provider (node_modules/@auth/core/providers/resend.js)
// and scripts/check-resend.ts. The `resend` npm package is a listed
// dependency but is used nowhere in `src/`; introducing its SDK client here
// would be a second, inconsistent way of doing the exact same HTTP call.
const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendEmailParams {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends one email via Resend's REST API.
 *
 * On any failure (network error or non-2xx response) this throws whatever
 * `wrapError(message, cause)` returns, instead of a hardcoded error type.
 *
 * That indirection exists because every current caller runs inside an
 * Auth.js provider's `sendVerificationRequest` and needs the failure to
 * surface as an `AuthError` specifically — `@auth/core`'s `Auth()` handler
 * only RE-THROWS an error caught from a provider action back to `signIn()`'s
 * caller when that error is an `AuthError` instance (see
 * `node_modules/@auth/core/src/index.ts`'s catch block). A plain `Error`
 * gets swallowed into a redirect `Response`, which `signIn(...,
 * { redirect: false })` then returns as an ordinary URL STRING, not a
 * rejection — the caller would believe the send succeeded when it did not.
 * This module has no reason to import "next-auth" itself just to satisfy
 * that constructor shape for every future caller, some of which may not run
 * inside an Auth.js flow at all (e.g. a future non-magic-link notification),
 * so the wrapping is left to each call site, which already knows which error
 * type its own caller expects.
 */
export async function sendResendEmail(
  params: ResendEmailParams,
  wrapError: (message: string, cause: unknown) => Error,
): Promise<void> {
  const { apiKey, from, to, subject, html, text } = params;

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw wrapError(`Failed to reach Resend: ${message}`, error);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw wrapError(`Resend error (${response.status}): ${body}`, undefined);
  }
}
