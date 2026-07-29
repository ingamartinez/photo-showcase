// Rate limiters for the magic-link request (task #12).
//
// Pulled out of src/app/(marketing)/login/actions.ts and into their own
// module — not because they are generic (they aren't; the limits below are
// specific to the login form), but because actions.ts has a `"use server"`
// directive, and Next.js only allows a `"use server"` file to export async
// functions. A module-scope `RateLimiter` object doesn't qualify, so tests
// that need to reset it between runs (see actions.test.ts's top-level
// `beforeEach`) couldn't import it from there at all. Living here, as a
// plain module imported by actions.ts, sidesteps that constraint instead of
// working around it with test-only tricks (e.g. giving every test its own
// never-reused address, which is what round 1 of this slice did — see the
// git history/review notes on actions.test.ts for why that was rejected).
//
// See src/lib/rate-limit.ts's own header comment for the store itself: why
// an in-memory Map is sufficient for a single Next.js process today, and
// what breaks it (a second process sharing traffic for the same limiter).

import { createRateLimiter } from "@/lib/rate-limit";

// Suggested starting point per task #12: 3 requests per address per 15
// minutes, and a looser per-IP cap.
//
//   - per ADDRESS stops a loop hammering one known inbox.
//   - per IP, looser, stops one client rotating through many addresses —
//     which the per-address bucket alone would never catch, since each
//     individual address only sees a handful of hits.
//
// Neither bucket protects the OTHER axis: a per-address limiter, by
// definition, cannot stop an attacker from exhausting one specific known
// address's own budget (3 submissions per 15 min, from anywhere) and
// holding its owner out of her own login — she would see the same neutral
// "sent" response as everyone else, with no email actually sent. That is
// inherent to having a per-address limit at all, not a defect introduced by
// combining it with the per-IP cap; the task asked for exactly this shape.
export const EMAIL_LIMIT = 3;
export const EMAIL_WINDOW_MS = 15 * 60 * 1000;
export const emailLimiter = createRateLimiter({ limit: EMAIL_LIMIT, windowMs: EMAIL_WINDOW_MS });

export const IP_LIMIT = 10;
export const IP_WINDOW_MS = 15 * 60 * 1000;
export const ipLimiter = createRateLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS });
