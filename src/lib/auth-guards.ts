// Server-side authorization primitives — the ONE reusable, server-side way
// every protected page, layout, and server action answers "who is this, and
// are they allowed here".
//
// Route Handlers are a deliberate exception to that claim: see "Route
// Handlers need a different unauthenticated response" below, and use
// `requireApiSession()` there instead of `requireSession()`.
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
import { NextResponse } from "next/server";
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
 * Route-handler variant of `requireSession()`. Use this, never
 * `requireSession()`, inside `route.ts` — a JSON API has no HTML form to
 * follow a `redirect("/login")` to.
 *
 * Returns the `Session` when signed in. When signed out, does NOT redirect
 * and does NOT throw: it returns a `NextResponse` (401, `{ "error":
 * "unauthorized" }`, no `Location` header) that the caller must return
 * immediately —
 *
 * ```ts
 * const sessionOrResponse = await requireApiSession();
 * if (sessionOrResponse instanceof NextResponse) return sessionOrResponse;
 * const session = sessionOrResponse;
 * ```
 *
 * Same freshness guarantee as `requireSession()`: `auth()` is called fresh
 * every time, never cached, so a session row deleted by sign-out stops
 * granting access on the very next call.
 *
 * Wrong-role (signed in, not admin) is a separate concern from this
 * function: call `requireAdmin()` — or check `session.user.role` and call
 * `forbidden()` directly — after getting a `Session` back from here.
 * `forbidden()` already produces a real 403 in a Route Handler with no
 * variant needed, unlike the unauthenticated case this function exists for.
 */
export async function requireApiSession(): Promise<Session | NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return session;
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
