// Server-side authorization primitives — the ONE reusable, server-side way
// every protected page, layout, and server action answers "who is this, and
// are they allowed here".
//
// Route Handlers are a deliberate exception to that claim: see "Route
// Handlers need a different unauthenticated response" below, and use
// `withApiSession()` there instead of `requireSession()`.
//
// Route Handlers must use `withApiSession()`, not `requireApiSession()`
// directly (task #54):
//
//   `requireApiSession()` returns `Session | NextResponse` rather than
//   throwing (see below for why), and that union is a footgun a caller can
//   get wrong in three different ways that TypeScript's `strict: true` does
//   NOT catch, because none of them is a type error under this codebase's
//   real usage — every real route handler that reads a session only checks
//   `session.user.role`, and does so AFTER already narrowing away
//   `NextResponse`, so TypeScript never even sees a property access on the
//   un-narrowed union to complain about:
//
//     // Shape A — bare discard. Compiles. Protects nothing.
//     await requireApiSession();
//
//     // Shape B — captured, never checked. `tsconfig.json` does not set
//     // `noUnusedLocals`, so this is silent at typecheck time; ESLint's
//     // `@typescript-eslint/no-unused-vars` only "warn"s (see
//     // eslint.config.mjs), so `bun run lint` exits 0. Ships.
//     const sessionOrResponse = await requireApiSession();
//     return NextResponse.json({ ok: true });
//
//     // Shape C — captured, narrowed, but the branch forgets to `return`.
//     // No error, no warning, nothing. Completely invisible in review.
//     const sessionOrResponse = await requireApiSession();
//     if (sessionOrResponse instanceof NextResponse) { /* forgot: return */ }
//     return NextResponse.json({ ok: true });
//
//   `withApiSession(handler)` makes all three shapes unrepresentable rather
//   than relying on every future route handler remembering the correct
//   early-return incantation: the check runs unconditionally before the
//   wrapped handler is ever invoked, and the handler receives a plain
//   `Session` — there is no union, no branch, and no return statement for a
//   caller to omit. `requireApiSession()` itself is still exported below,
//   used internally by `withApiSession()` and directly by this module's own
//   tests, but a Route Handler reaching for it directly is exactly the
//   mistake `eslint.config.mjs`'s `no-restricted-imports` override for
//   `src/app/api/**/route.ts` exists to block.
//
// Why guards here, and not middleware:
//
//   `src/lib/db/index.ts` connects to Postgres over a UNIX socket with peer
//   auth — there is no `DATABASE_URL`. Next.js middleware runs on the Edge
//   runtime, which can reach neither that socket nor the `postgres-js`
//   driver. `src/auth.ts` also deliberately chose `session: { strategy:
//   "database" }`, precisely so that revoking a session (sign-out, or an
//   admin deleting a client) takes effect on the very next request instead
//   of whenever a self-contained token happens to expire. Verifying a
//   session is therefore a database read, full stop. Middleware could only
//   ever check whether a *cookie is present* — which is not the claim "this
//   session is still valid", and would quietly defeat the entire reason
//   database sessions were chosen. So there is no `middleware.ts` in this
//   app, and there must not be one that tries to gate access by cookie
//   presence alone.
//
// Why not a layout alone, either:
//
//   A Next.js layout does not re-run on every navigation between sibling
//   routes inside it, and it never runs at all for Route Handlers or Server
//   Actions. A layout-only guard would silently stop protecting the moment
//   someone adds a `route.ts` or a form action underneath it — nothing would
//   fail loudly, it would just be unguarded. So these functions are called
//   directly by every protected page, route handler, and server action, not
//   assumed to be covered transitively by an ancestor layout. A layout guard
//   MAY be added later for defense in depth once a protected route group
//   exists (`src/app/(dashboard)/layout.tsx` or similar), but it must never
//   be the ONLY check anything relies on. Do not "simplify" this into a
//   single middleware.ts or single layout check — that has already been
//   decided against once, for the reasons above.
//
// `forbidden()` requires `experimental.authInterrupts` in next.config.ts —
// enabled there for exactly this: it is the one Next.js primitive that
// turns a failed check into a real 403 response in a Server Component, a
// Server Action, AND a Route Handler, with no per-context branching here.
// That is why `requireAdmin()`'s wrong-role path (`forbidden()`) needs no
// route-handler-specific variant below — only the unauthenticated path does.
//
// Route Handlers need a different unauthenticated response:
//
//   `requireSession()` calls `redirect("/login")`, which is correct for a
//   page navigation (the browser follows the 307 to an HTML form) and wrong
//   for a Route Handler backing a `fetch()` call: the caller gets a 307 to
//   an HTML document it never asked for and cannot parse as JSON, instead
//   of a clear "you are not signed in". Next.js has no interrupt equivalent
//   to `forbidden()` for this case that actually helps here either —
//   `unauthorized()` from `next/navigation` throws the same kind of digest
//   `forbidden()` does, but a Route Handler catching that digest gets back
//   an empty-bodied `Response` (see `next/dist/server/route-modules/app-route
//   /module.js`), not the JSON body a `fetch()` caller needs to distinguish
//   "not signed in" from any other failure.
//
//   So `requireApiSession()` below does not throw at all: it returns the
//   `Session` on success and a ready-to-return `NextResponse` (401, JSON
//   body, no `Location` header) on failure, and the Route Handler is
//   responsible for returning that response as-is. This is a second,
//   explicitly-named export rather than an option on `requireSession()` on
//   purpose — a flag that changes 307-vs-401 based on how the caller says it
//   is being invoked is a guess about the call site, and a guess about the
//   call site is wrong exactly once, silently. Route Handlers state which
//   surface they are by calling the function that matches, not by passing a
//   parameter `requireSession()` would otherwise have to trust.
import "server-only";

import { forbidden, redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";

/**
 * Resolves the current session, or redirects to `/login` if there isn't one.
 *
 * Always calls `auth()` fresh — never caches a session across calls. Because
 * `src/auth.ts` uses the database session strategy, `auth()` performs a real
 * lookup against the `sessions` table every time it runs, so a session row
 * deleted by sign-out (or by an admin revoking a client) stops granting
 * access on the very next call to this function, not whenever a client-held
 * cookie happens to expire on its own.
 */
export async function requireSession(): Promise<Session> {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }
  return session;
}

/**
 * Route-handler variant of `requireSession()`. Prefer `withApiSession()`
 * below for an actual `route.ts` — see the file header (task #54) for why a
 * Route Handler calling this directly, and handling the union itself, is a
 * footgun `eslint.config.mjs` now blocks by file path. This function stays
 * exported for `withApiSession()`'s own implementation and for this module's
 * unit tests, which assert the 401 response's exact shape.
 *
 * Returns the `Session` when signed in. When signed out, does NOT redirect
 * and does NOT throw: it returns a `NextResponse` (401, `{ "error":
 * "unauthorized" }`, no `Location` header).
 *
 * Same freshness guarantee as `requireSession()`: `auth()` is called fresh
 * every time, never cached, so a session row deleted by sign-out stops
 * granting access on the very next call.
 *
 * Wrong-role (signed in, not admin) is a separate concern from this
 * function: check `session.user.role` and call `forbidden()` directly —
 * inside the handler passed to `withApiSession()` — after getting a
 * `Session`. `forbidden()` already produces a real 403 in a Route Handler
 * with no variant needed, unlike the unauthenticated case this function
 * exists for.
 */
export async function requireApiSession(): Promise<Session | NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return session;
}

/**
 * The required way for a Route Handler to gate on a signed-in session
 * (task #54). Wraps a handler that receives a plain `Session` as its third
 * argument — never a `Session | NextResponse` union — and guarantees the
 * handler is not invoked at all unless `requireApiSession()` resolved a real
 * session on this exact request.
 *
 * ```ts
 * export const GET = withApiSession(async (request, { params }, session) => {
 *   // `session` is a plain Session here. No branch, no early return, no
 *   // union to mishandle — the 401 path already happened, above, before
 *   // this function body could ever run.
 *   ...
 * });
 * ```
 *
 * This is what makes the guard "unskippable" rather than merely
 * conventionally correct: the previous shape (call `requireApiSession()`,
 * early-return on `instanceof NextResponse`) put the correctness of every
 * Route Handler on every future author remembering three separate things —
 * capture the result, check it, and return the checked branch — and gave
 * TypeScript nothing to say if any one of those was skipped (see the file
 * header for the three concrete ways that went silently wrong). Here there
 * is nothing to skip: `Context` is whatever the wrapped handler's own second
 * parameter needs (typically `{ params: Promise<{ assetId: string }> }`),
 * inferred from the handler passed in, so the returned function has the
 * exact `(request, context) => Promise<NextResponse>` shape Next.js expects
 * to find exported as `GET`/`POST`/`PATCH`/`DELETE`.
 */
export function withApiSession<Context>(
  handler: (request: NextRequest, context: Context, session: Session) => Promise<NextResponse>,
): (request: NextRequest, context: Context) => Promise<NextResponse> {
  return async (request, context) => {
    const sessionOrResponse = await requireApiSession();
    if (sessionOrResponse instanceof NextResponse) {
      return sessionOrResponse;
    }
    return handler(request, context, sessionOrResponse);
  };
}

/**
 * Resolves the current session and asserts the caller is an admin; redirects
 * to `/login` if signed out, refuses with a 403 if signed in as a client.
 *
 * `session.user.role` is populated by the `session` callback in
 * `src/auth.ts` from the database `users` row via the Drizzle adapter — it
 * is never derived from anything the client sent (no client-supplied header,
 * cookie value, or request body field is ever consulted here), so there is
 * nothing for a client to spoof to get past this check.
 */
export async function requireAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.user.role !== "admin") {
    forbidden();
  }
  return session;
}
