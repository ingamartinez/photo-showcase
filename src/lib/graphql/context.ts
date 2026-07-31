// The ONE thing every GraphQL resolver gets for free: the caller's NextAuth
// session, or `null` when signed out (task #30, PLAN.md §7).
//
// Deliberately mirrors `requireApiSession()`'s freshness guarantee
// (src/lib/auth-guards.ts) — `auth()` is called fresh on every request, never
// cached across requests, so a session row deleted by sign-out (or by an
// admin removing a client) stops granting access on the very next GraphQL
// request, not whenever a client-held cookie happens to expire on its own.
//
// UNLIKE `requireApiSession()`, this never short-circuits to a 401: GraphQL
// Yoga's `context` hook runs before the schema knows which fields the caller
// asked for, and a schema can mix public and private fields in one document.
// So this hands back `session: null` rather than throwing, and it is every
// resolver's OWN job to check it and refuse — exactly the shape
// `src/lib/gallery-access.ts`'s `isGalleryOwner` already expects a `Session`
// argument for. There is no "the context already checked this" shortcut here
// on purpose: the epic's stated risk (task #6) is a second, WEAKER set of
// authorization rules growing up alongside the REST ones, and the fix is
// every resolver calling the SAME ownership helpers those routes call, not a
// blanket gate that would tempt a future resolver into skipping its own
// check because "the context already handled auth".
import "server-only";

import type { Session } from "next-auth";
import { auth } from "@/auth";

export type GraphQLContext = {
  session: Session | null;
};

/** Yoga's `context` option — see this file's header for why it returns
 * `session: null` instead of throwing on an unauthenticated request. */
export async function createGraphQLContext(): Promise<GraphQLContext> {
  const session = await auth();
  return { session };
}
