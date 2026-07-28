"use server";

// Sign-out server action. Deliberately thin: it does nothing but call
// Auth.js's own `signOut()`, and must stay that way.
//
// For the database session strategy (`src/auth.ts`), `signOut()` deletes the
// session row via the Drizzle adapter before it ever touches a cookie — see
// `signOut()` in `next-auth/lib/actions.js`, which calls into `@auth/core`'s
// "signout" action, whose handler removes the row through
// `adapter.deleteSession()`. That is what makes sign-out immediate: the
// session id the browser is still carrying stops resolving to anything the
// moment this action returns, because the row it pointed at is gone — not
// because a cookie was cleared (cookie clearing is a courtesy for this
// browser; the row deletion is what actually revokes access everywhere).
// Re-implementing any part of that here (clearing cookies ourselves,
// tracking sessions in a second place) would only create a second source of
// truth that could drift from the database, so this action does not.
import { signOut } from "@/auth";

export async function signOutAction(): Promise<void> {
  // Explicit destination — the same class of implicit-redirect trap flagged
  // for `signIn()` in `src/app/(marketing)/login/actions.ts` (task #11's
  // note): leaving `redirectTo` unset falls back to the `Referer` header.
  // Task #17 has since added the protected area this action is called from
  // (`src/app/dashboard/`) — home is still the right destination: it is a
  // public page, which is exactly what "signing out returns to a public
  // page" requires, and there is no other signed-out landing page to prefer.
  await signOut({ redirectTo: "/" });
}
