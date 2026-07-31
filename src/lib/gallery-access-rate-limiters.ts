// Rate limiter for the gallery-access resend button (task #101).
//
// Pulled into its own module for the exact reason src/lib/login-rate-limiters.ts
// is its own module rather than living inline in the action that uses it: the
// consumer here is src/app/dashboard/galleries/actions.ts, which carries a
// top-of-file `"use server"` directive, and Next.js only allows a `"use
// server"` file to export async functions. A module-scope `RateLimiter`
// object doesn't qualify — and a test suite that needs to reset it between
// runs (see actions.resend.test.ts's top-level `beforeEach`) couldn't import
// it from there at all. Living here, as a plain module `actions.ts` imports,
// sidesteps the constraint instead of working around it with test-only
// tricks. See login-rate-limiters.ts's own header for the fuller version of
// this reasoning and src/lib/rate-limit.ts's header for the store itself
// (why an in-memory Map is sufficient today, and what breaks it).

import { createRateLimiter } from "@/lib/rate-limit";

// DECIDED (owner, 2026-07-30, on kanban #101) — do not re-litigate these
// against the login form's own numbers or shape without a new decision:
//
//   - Limit and window: 3 per 15 minutes, the SAME numbers as the login
//     form's per-address bucket (EMAIL_LIMIT / EMAIL_WINDOW_MS in
//     login-rate-limiters.ts). Same threat (a control that can mint an
//     unlimited number of working magic links to one inbox), same mailbox,
//     already reasoned about — picking a different number here would need
//     its own justification this task never had reason to produce.
//
//   - Bucket key is `(galleryId, clientId)`, i.e. one budget PER CLIENT PER
//     GALLERY — never a single per-gallery or per-admin bucket. A gallery
//     can have several attached clients (task #94); if the key omitted
//     `clientId`, resending to client A after client B already used up the
//     gallery's shared budget this hour would be refused, even though B's
//     three sends have nothing to do with A ever receiving mail. The correct
//     axis to protect is "how many times has THIS inbox been mailed for THIS
//     gallery", which is exactly what `gallery_clients`' own composite
//     primary key (galleryId, userId) already expresses for membership — see
//     schema.ts's comment on that table. `clientId` here is the CLIENT's own
//     user id (the row's `userId`), never the acting admin's — an
//     admin-keyed bucket would pool every client on a gallery into one
//     shared budget instead of the correct one, and would also make the
//     bucket meaningless the moment a second admin exists (PLAN.md §4 notes
//     there is exactly one today, but nothing in this key's shape should
//     assume that stays true).
//
//   - NO per-IP bucket, unlike the login form's `ipLimiter`. The login
//     form's per-IP cap exists to catch an anonymous attacker rotating
//     through many known addresses, which the per-address bucket alone
//     cannot see (each individual address only takes a handful of hits).
//     This surface sits behind `requireAdmin()`, and PLAN.md §4 states there
//     is exactly one admin account. There is no anonymous principal for a
//     per-IP cap to catch here — it would only ever throttle the one
//     legitimate admin's own browser, for no security benefit.
export const GALLERY_ACCESS_RESEND_LIMIT = 3;
export const GALLERY_ACCESS_RESEND_WINDOW_MS = 15 * 60 * 1000;

export const galleryAccessResendLimiter = createRateLimiter({
  limit: GALLERY_ACCESS_RESEND_LIMIT,
  windowMs: GALLERY_ACCESS_RESEND_WINDOW_MS,
});

/** Builds this limiter's bucket key. Centralized here — rather than letting
 * the action string-template `${galleryId}:${clientId}` itself — so the
 * action and this module's own tests can never drift on the separator or
 * argument order. */
export function galleryAccessResendKey(galleryId: string, clientId: string): string {
  return `${galleryId}:${clientId}`;
}
