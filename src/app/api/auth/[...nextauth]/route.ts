// Auth.js's default GET/POST catch-all, minus its own signin endpoints.
//
// `handlers.GET`/`handlers.POST` from `@/auth` implement the whole Auth.js API
// surface: `/signin`, `/signin/:provider`, `/callback/:provider`, `/session`,
// `/csrf`, `/providers`, `/signout`, `/verify-request`, `/error`. Everything
// works except `/signin*`, which duplicates — and undermines — the
// anti-enumeration work in `src/app/login/actions.ts`.
//
// Measured on the live dev server, with a valid CSRF token:
//
//   unknown -> 302 location: /login?error=AccessDenied      no Set-Cookie   16 ms
//   known   -> 302 location: /api/auth/verify-request?...   Set-Cookie: ...  609 ms
//
// Three simultaneous channels (status/Location, Set-Cookie, timing) leak
// whether an address exists, in a single curl with no cookie jar. The root
// cause: `sendToken()` (the resend provider's signin handler) throws
// `AccessDenied` before assembling cookies when the `signIn` callback in
// `src/auth.ts` refuses an unknown address, so the accepted and refused paths
// produce structurally different responses — a known address does a real
// Resend round trip and a database write, an unknown one does neither.
//
// Normalizing that response (status, Location, Set-Cookie, timing) would mean
// re-deriving, on this second entrance, the same equalization
// `src/app/login/actions.ts` + `src/lib/auth-cookies.ts` already do — and
// getting it wrong once reopens the leak silently, which is exactly what
// happened in round 1 of #9. Removing the endpoint instead removes the oracle
// at the source: a request to `/api/auth/signin*` never reaches the provider,
// the database, or cookie assembly, so there is nothing left to equalize.
//
// The server action in `src/app/login/actions.ts` is the only entrance to
// requesting a magic link — it calls `signIn()` from `@/auth` in process, not
// over HTTP, so it never touches this route at all. Nothing else in the app
// (no client-side `signIn()`, no middleware) depends on the built-in signin
// endpoints, so dropping them is safe.
//
// Scoped to `signin` only: `POST /api/auth/signout` (task #11) and every GET
// endpoint above must keep working unmodified.

import { NextResponse, type NextRequest } from "next/server";
import { handlers } from "@/auth";
import { AUTH_BASE_PATH } from "@/lib/auth-base-path";

// Task #44: this used to match against the raw pathname, which meant its
// correctness rested on an undocumented coincidence — Auth.js's own action
// parser (`@auth/core/lib/utils/actions.js`) splits on a literal `/` and does
// an exact-string match against a fixed lowercase action list, so a case
// mismatch (`/api/auth/SignIn`) or a `%2F`-encoded slash
// (`/api/auth/signin%2Fresend`) also failed to resolve on Auth.js's side and
// threw `UnknownAction` — but nothing here made that true independently. If
// `@auth/core` ever changed how it parses actions, this guard would have kept
// waving those variants straight through to the real signin handler with no
// warning. Normalizing case and percent-encoding below closes that gap: this
// guard now decides on its own, without relying on how any other parser
// treats the same string.
function normalizePathname(pathname: string): string {
  try {
    // Resolve percent-encoding first (so `%2F` reads as the `/` it encodes),
    // then lowercase — order matters for `%2F` but not for case escapes.
    return decodeURIComponent(pathname).toLowerCase();
  } catch {
    // Malformed percent-encoding (a lone `%`, a truncated escape) is not
    // itself the leak this guard closes — fall back to matching the raw
    // pathname's case instead of 500ing the whole auth route on garbage
    // input.
    return pathname.toLowerCase();
  }
}

/**
 * True for Auth.js's own signin endpoints: `/api/auth/signin` (the built-in
 * form) and `/api/auth/signin/:provider` (the POST that starts a signin).
 *
 * What this guarantees on its own, without appeal to Auth.js internals: any
 * pathname whose case- and percent-decoding-normalized form is exactly
 * `{AUTH_BASE_PATH}/signin` or begins with `{AUTH_BASE_PATH}/signin/` is
 * blocked. `AUTH_BASE_PATH` is imported from `@/lib/auth-base-path`, the same
 * constant `src/auth.ts` passes to `NextAuth()` as `basePath` — not a second
 * hardcoded copy — so the two cannot drift apart (see `route.test.ts`'s
 * drift test).
 *
 * Exported for the regression test — see `route.test.ts`.
 */
export function isBuiltinSignin(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  const afterBasePath = normalized.startsWith(AUTH_BASE_PATH)
    ? normalized.slice(AUTH_BASE_PATH.length)
    : normalized;
  return afterBasePath === "/signin" || afterBasePath.startsWith("/signin/");
}

function signinNotFound(): Response {
  // A plain 404 with no body: same response no matter what the request
  // contains, so there is nothing for an enumeration attempt to read.
  return new NextResponse(null, { status: 404 });
}

export async function GET(request: NextRequest): Promise<Response> {
  if (isBuiltinSignin(request.nextUrl.pathname)) return signinNotFound();
  return handlers.GET(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (isBuiltinSignin(request.nextUrl.pathname)) return signinNotFound();
  return handlers.POST(request);
}
