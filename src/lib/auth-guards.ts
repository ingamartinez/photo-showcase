// Server-side authorization primitives — the ONE reusable, server-side way
// every protected page, layout, route handler, and server action answers
// "who is this, and are they allowed here".
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
import "server-only";

import { forbidden, redirect } from "next/navigation";
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
