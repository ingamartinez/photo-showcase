"use server";

// Magic-link request. The anti-enumeration guarantee lives here: whether the
// address exists or not, this action must produce the exact same HTTP response
// — same body, same timing, same headers — in the same amount of visible work.
// See src/auth.ts's signIn callback for the half that refuses unknown
// addresses.

import { z } from "zod";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { clearAuthCallbackUrlCookie } from "@/lib/auth-cookies";

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
    await signIn("resend", { email: parsed.data.email, redirect: false });
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
