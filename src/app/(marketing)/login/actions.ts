"use server";

// Magic-link request. The anti-enumeration guarantee lives here: whether the
// address exists or not, this action must produce the exact same HTTP response
// — same body, same timing, same headers — in the same amount of visible work.
// See src/auth.ts's signIn callback for the half that refuses unknown
// addresses.

import { z } from "zod";
import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { signIn } from "@/auth";
import { clearAuthCallbackUrlCookie } from "@/lib/auth-cookies";
import { getClientIp } from "@/lib/rate-limit";
import { emailLimiter, ipLimiter } from "@/lib/login-rate-limiters";

const requestSchema = z.object({
  email: z.email("Ingresá un correo electrónico válido."),
});

export type LoginActionState = {
  status: "idle" | "error" | "sent";
  message?: string;
};

// Anti-enumeration floor. The UI text is identical either way, but without
// this the *latency* still isn't: an unknown address is refused by the
// signIn callback in a few milliseconds (no network call), while a known
// address waits on a real round trip to Resend (several hundred ms in
// practice, verified locally). That gap is as good as a different message.
// Both branches below always take at least this long before returning.
const MIN_RESPONSE_MS = 700;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestMagicLink(
  _prevState: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const parsed = requestSchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    // Rejected before Auth.js ever sees it — an invalid address never reaches
    // the enumeration guard, because it never reaches the provider at all.
    // No timing floor needed here: this branch never depends on whether the
    // address exists, so there's no signal to hide.
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Ingresá un correo electrónico válido.",
    };
  }

  const startedAt = Date.now();
  try {
    // Both checks always run — never short-circuited with `&&` — so each
    // bucket's count reflects every attempt regardless of the other
    // bucket's state. Only whether `signIn` gets called below depends on
    // the combined result; the response built after this block is
    // identical either way. Note this is not pure upside: the per-address
    // limiter, on its own, cannot distinguish an attacker from the
    // address's real owner, so it stops mail for a targeted known address
    // just as effectively as it stops mail for an attacker spamming it —
    // see src/lib/login-rate-limiters.ts's header comment for why that is
    // accepted here rather than fixed.
    const normalizedEmail = parsed.data.email.toLowerCase();
    const clientIp = getClientIp(await headers());
    const withinEmailLimit = emailLimiter.check(normalizedEmail).allowed;
    const withinIpLimit = ipLimiter.check(clientIp).allowed;

    if (withinEmailLimit && withinIpLimit) {
      // Explicit destination — without `redirectTo`, `signIn()`'s own
      // `redirect: false` short-circuit still falls back to the `Referer`
      // header (see `next-auth/lib/actions.js`), so the magic link's baked-in
      // `callbackUrl` would resolve to wherever this action happened to be
      // called from — `/login` in practice, bouncing a successful login right
      // back to the entrance. Flagged by #9's round-2 review, fixed here
      // because this is the slice that introduces the destination.
      //
      // `/login/redirect`, not `/dashboard`: task #87. This literal is the
      // SAME string for every address that reaches this branch — an admin
      // address, a client address, both indistinguishable from here — so it
      // cannot become a second enumeration oracle alongside the one this
      // action already closes below. Dispatching to `/dashboard` for an
      // admin and `/galleries` for a client requires reading `role`, and
      // `role` is only safe to read once a session exists (see
      // src/auth.ts's `signIn` callback); doing that lookup HERE, before the
      // session exists, would leak exactly what #43 closed, just through the
      // redirect target instead of the response body. So the role-specific
      // dispatch happens post-authentication, in
      // `src/app/(marketing)/login/redirect/page.tsx`, not here.
      await signIn("resend", {
        email: parsed.data.email,
        redirect: false,
        redirectTo: "/login/redirect",
      });
    }
    // else: throttled. Deliberately NOT an early `return` — falling through
    // to the same `finally` (timing floor + cookie clear) and the same
    // `return { status: "sent" }` below is what keeps a throttled response
    // indistinguishable from an accepted one. This limiter runs BEFORE the
    // Resend call, so a throttled request finishes in a few ms on its own;
    // an early return here would recreate exactly the timing oracle #9/#43
    // closed, just with a new trigger (submission count instead of address
    // existence).
  } catch (error) {
    // The signIn callback in src/auth.ts returns false for an address that
    // doesn't belong to an existing user; Auth.js turns that into an
    // AuthError and never sends mail. Swallowing it here — and returning the
    // exact same "sent" state as the success path below — is what makes the
    // form unusable for discovering accounts. Anything else (including the
    // special error `redirect()` throws to signal navigation) is a real
    // failure and must propagate.
    if (!(error instanceof AuthError)) {
      throw error;
    }
  } finally {
    // Third and last channel to close, after the body and the clock: the
    // headers. Auth.js emits a `Set-Cookie` for a known address and none for an
    // unknown one, which is a perfectly readable answer for anyone running curl
    // against this endpoint. Normalizing it here — on the success path, on the
    // swallowed AccessDenied, and on a rethrown failure alike — makes the
    // emitted cookie depend only on AUTH_URL. See src/lib/auth-cookies.ts.
    await clearAuthCallbackUrlCookie();

    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) {
      await wait(MIN_RESPONSE_MS - elapsed);
    }
  }

  return { status: "sent" };
}
