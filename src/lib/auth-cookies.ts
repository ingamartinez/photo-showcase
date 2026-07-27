// Response-cookie normalization for the magic-link request.
//
// The anti-enumeration guarantee of `/login` is not only about what the page
// says or how long it takes — it is about the whole HTTP response. Auth.js
// leaks the answer through `Set-Cookie`:
//
//   `@auth/core`'s `init()` assembles a cookie list for every request, which on
//   a fresh session contains a new `authjs.callback-url` cookie. The signin
//   action returns `{ ...response, cookies }` — but for the email provider that
//   `response` comes from `sendToken()`, which THROWS `AccessDenied` when the
//   `signIn` callback refuses an unknown address. The throw happens before the
//   return, so the cookie list is discarded and `next-auth`'s `signIn()` wrapper
//   never reaches its `cookieJar.set(...)` loop.
//
// Net effect on the wire, with a fresh client that carries no cookies (exactly
// what a scripted enumeration loop looks like):
//
//   known address   -> 200 + Set-Cookie: authjs.callback-url=...
//   unknown address -> 200, no Set-Cookie at all
//
// `httpOnly` is no defence: the attacker reads raw headers with curl, not
// `document.cookie`. Neither is pre-seeding the cookie on `GET /login` — the
// cookie only stops being emitted when it is already present in the REQUEST,
// and the attacker never loads the page.
//
// So the request outcome must not be allowed to decide the cookie set. Every
// outcome clears that cookie, unconditionally and identically, which makes the
// emitted `Set-Cookie` a pure function of the deployment origin instead of a
// function of whether the address exists.
//
// Clearing (rather than setting a value) is deliberate: it costs nothing here.
// The cookie only exists to remember a callback URL across the signin/callback
// hop, and our magic link already carries `callbackUrl` as a query parameter,
// which `createCallbackUrl()` prefers over the cookie anyway — and the link is
// routinely opened on a different device, where no cookie would survive.

import { cookies } from "next/headers";
import { authEnv } from "@/lib/env";

/**
 * The name Auth.js gives its callback-url cookie for a given deployment origin.
 *
 * `@auth/core` derives it as `defaultCookies(url.protocol === "https:")`, where
 * `url` is built by `createActionURL()` — which prefers `AUTH_URL` over the
 * request headers. `AUTH_URL` is mandatory in this app (see `authEnv()`), so the
 * name is fully determined by that one variable: the `__Secure-` prefix appears
 * in production and is absent over plain http in local dev.
 */
export function callbackUrlCookieName(authUrl: string): string {
  const prefix = new URL(authUrl).protocol === "https:" ? "__Secure-" : "";
  return `${prefix}authjs.callback-url`;
}

/**
 * Clears Auth.js's callback-url cookie on the response being built.
 *
 * Must run on EVERY outcome of a magic-link request — accepted, refused, or
 * failed — because its whole purpose is to make the `Set-Cookie` header
 * identical in all three cases. The attributes mirror the ones Auth.js sets the
 * cookie with, so the clear is actually honoured by the browser (a `__Secure-`
 * prefixed cookie is rejected outright unless the deletion is marked `Secure`).
 */
export async function clearAuthCallbackUrlCookie(): Promise<void> {
  const { AUTH_URL } = authEnv();
  const secure = new URL(AUTH_URL).protocol === "https:";
  const jar = await cookies();

  jar.delete({
    name: callbackUrlCookieName(AUTH_URL),
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
  });
}
