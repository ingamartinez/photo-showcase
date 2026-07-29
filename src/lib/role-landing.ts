// The single rule for "which area does an authenticated user belong to",
// keyed by `role` alone — never by anything a request can influence besides
// the session Auth.js already verified.
//
// Two call sites need exactly this decision, and until #91 each hardcoded
// its own copy:
//   - `(marketing)/login/redirect/page.tsx` (#87) — the post-magic-link
//     dispatcher, evaluated once right after Auth.js creates a session.
//   - `(marketing)/layout.tsx` (#91) — the public site chrome, evaluated on
//     every page render to decide which link the header/footer offer a
//     signed-in visitor.
//
// Before #91, the layout re-derived this by checking only "does a session
// exist", never `session.user.role` — so a signed-in ADMIN fell into the
// same bucket as a signed-in CLIENT and was offered `/galleries`, the
// client area ownership-scoped by #22 to galleries where THEY are the
// client, i.e. normally none. Nothing errored; the photographer just landed
// on their own empty client area. Two independent copies of one rule is
// exactly the shape that produced #86 and #88 in this same session: a
// decision that was correct when written, duplicated once, and never
// revisited when it needed to change. This function exists so there is
// only one copy left to revisit.
//
// Rejected alternative: point the chrome at `/login/redirect` and let the
// existing dispatcher decide, instead of extracting this function. That
// would also leave exactly one place that knows the rule, but it is worse
// on cost, not correctness — `/login/redirect` does nothing but read the
// session and issue a 307 elsewhere, so every click on the chrome's area
// link would pay a full extra request/response round trip to a page whose
// only job is to redirect again. Both call sites already run on the server
// and already hold the `Session` (or, for the chrome's signed-out case, know
// there isn't one) before this is ever consulted, so a shared pure function
// gives the same single source of truth for free.
export function landingPathForRole(role: "admin" | "client"): string {
  return role === "admin" ? "/dashboard" : "/galleries";
}
