import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-guards";
import { landingPathForRole } from "@/lib/role-landing";

export const metadata: Metadata = {
  title: "Ingresando…",
  // A transient dispatcher, never a real destination — same stance as
  // /login itself. Nobody should ever land here from a search result or a
  // bookmark; anyone who does is bounced onward immediately below.
  robots: { index: false, follow: false },
};

// Task #87: the "resend" (login) magic link used to hardcode
// `redirectTo: "/dashboard"` in the request action
// (src/app/(marketing)/login/actions.ts), regardless of who was signing in
// — every CLIENT landed on the admin panel and was refused by
// `requireAdmin()`. The obvious fix — look up the address's role when the
// link is REQUESTED, and set a role-specific `redirectTo` there — was
// rejected: it would make the redirect target differ by address BEFORE any
// session exists, reopening the exact enumeration oracle #43 closed on
// `/api/auth/signin/*` (see actions.ts's own header comment and #71, which
// exists to shrink that surface further). A role is only safe to read AFTER
// Auth.js has created a session, so the request action now sends every
// magic link to this ONE neutral URL — same string for every address, admin
// or client or unknown, so it leaks nothing about who is signing in — and
// the dispatch by role happens here, on the far side of authentication.
//
// `requireSession()`, not `requireAdmin()`: an unauthenticated visitor (this
// route hit directly, or a stale/consumed link) is sent to `/login` exactly
// like every other guarded page, never refused with a 403 — there is no
// role to be wrong about yet.
//
// The role-to-destination mapping itself lives in `landingPathForRole()`
// (`src/lib/role-landing.ts`), not inline here — see that file's header
// comment for why this is a shared function rather than two copies (task
// #91, which found the site chrome had silently drifted from this page).
export default async function LoginRedirectPage() {
  const session = await requireSession();
  redirect(landingPathForRole(session.user.role));
}
