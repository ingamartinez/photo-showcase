// The one lookup that answers "is this email address a known identity?".
//
// Identity IS the email (PLAN.md §4), and this repo has exactly one place
// where that identity is minted (`createClient` in
// src/app/dashboard/clients/actions.ts, which inserts a `users` row) and
// exactly one place where it is checked (`src/auth.ts`'s `signIn` callback,
// which refuses to send or accept a magic link for an address that does not
// already exist). Those two are a SEAM: if the form an address is stored in
// and the form it is looked up by ever drift apart, a client the photographer
// just created simply cannot sign in, and nothing anywhere is red.
//
// Task #51: the seam test in src/app/dashboard/clients/actions.test.ts used to
// prove that by hand-copying auth.ts's query. That test killed real
// regressions, but it was pinned to a COPY — rewriting the query in auth.ts
// would have left it green. Both sides now call this function, so there is a
// single lookup to change and changing it turns the seam test red.
//
// Deliberately NOT `import "server-only"`, unlike src/lib/clients.ts: this
// module is imported by src/auth.ts, which is in turn imported by route
// handlers, layouts and server actions across the app. Adding the guard here
// would inject "server-only" into that whole import graph — a change in blast
// radius well beyond what sharing one query is worth. The module reaches `db`
// directly, so it is server-side by construction anyway.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * The id of the user registered under `email`, or `undefined` if there is
 * none.
 *
 * The address is used verbatim — normalization is the CALLER's job on both
 * sides of the seam, and both sides already do it in the same way: Auth.js
 * normalizes with `.normalize("NFKC").toLowerCase().trim()` before `signIn`'s
 * callback ever runs (see next-auth's Resend/email provider), and
 * `createClient`'s zod schema applies the same three steps before inserting
 * (see its comment, and the task #48 cases pinning it). Re-normalizing here
 * would hide a future divergence between those two rather than expose it.
 *
 * No `role` filter, on purpose: admins sign in through the same magic-link
 * flow as clients, so this asks about identity, not authorization. What a
 * session may DO is decided by src/lib/auth-guards.ts.
 */
export async function findUserIdByEmail(email: string): Promise<string | undefined> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return existing?.id;
}
