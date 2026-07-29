import { auth } from "@/auth";
import { landingPathForRole } from "@/lib/role-landing";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

// Marketing chrome, scoped to this route group only — see the comment in
// `src/app/layout.tsx` for why this is a parenthesized group (no URL
// segment) rather than the dashboard's plain segment layout. Everything
// nested under `(marketing)/` — `/`, `/about`, `/contact`, `/work*`,
// `/login*` — gets the public header and footer; `/dashboard*` does not,
// because it is not nested here.
//
// Area entry point (kanban #33, corrected by #91): every page in this
// group needs a way to reach `/login` while signed out, or ONE'S OWN area
// once signed in — `/galleries` for a client, `/dashboard` for an admin.
// That decision is made once, here, and passed down as plain props.
// `auth()` is called directly rather than through `requireSession()`/
// `requireAdmin()` from `src/lib/auth-guards.ts` because this is NOT a
// guard: an anonymous visitor is allowed on every page in this group, we
// are only choosing which link the chrome shows them.
//
// #91: this used to branch on "does a session exist" only, never on
// `session.user.role`, so a signed-in ADMIN was bucketed with every signed-
// in CLIENT and offered `/galleries` — quietly wrong, not broken, because
// `/galleries` still renders for an admin (just empty, per #22's ownership
// scoping). Reading `role` here is safe specifically because the session
// already exists by the time this runs; do not import `/login/redirect`'s
// enumeration caution (#87) into this branch, it does not apply once a
// session is established. The role-to-path mapping itself is NOT
// re-derived below — see `landingPathForRole()` in `src/lib/role-landing.ts`
// for why it is a shared function instead of a second inline copy.
export default async function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const areaHref = session ? landingPathForRole(session.user.role) : "/login";
  const areaLabel = session
    ? session.user.role === "admin"
      ? "Panel"
      : "Mis galerías"
    : "Acceso a clientes";

  return (
    <>
      <SiteHeader areaHref={areaHref} areaLabel={areaLabel} />
      <main className="flex-1">{children}</main>
      <SiteFooter areaHref={areaHref} areaLabel={areaLabel} />
    </>
  );
}
