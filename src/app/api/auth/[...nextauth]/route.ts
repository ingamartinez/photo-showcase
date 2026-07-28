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

/**
 * True for Auth.js's own signin endpoints: `/api/auth/signin` (the built-in
 * form) and `/api/auth/signin/:provider` (the POST that starts a signin).
 * Exported for the regression test — see `route.test.ts`.
 */
export function isBuiltinSignin(pathname: string): boolean {
  const afterBasePath = pathname.replace(/^\/api\/auth/, "");
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
