import { auth } from "@/auth";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

// Marketing chrome, scoped to this route group only — see the comment in
// `src/app/layout.tsx` for why this is a parenthesized group (no URL
// segment) rather than the dashboard's plain segment layout. Everything
// nested under `(marketing)/` — `/`, `/about`, `/contact`, `/work*`,
// `/login*` — gets the public header and footer; `/dashboard*` does not,
// because it is not nested here.
//
// Client entry point (kanban #33): every page in this group needs a way for
// a client to find `/login` (or, once signed in, their own area at
// `/galleries`) without ever being sent a link. That decision is made once,
// here, and passed down as plain props — `auth()` is called directly rather
// than through `requireSession()`/`requireAdmin()` from `src/lib/auth-guards.ts`
// because this is NOT a guard: an anonymous visitor is allowed on every page
// in this group, we are only choosing which link the chrome shows them.
export default async function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const clientAreaHref = session ? "/galleries" : "/login";
  const clientAreaLabel = session ? "Mis galerías" : "Acceso a clientes";

  return (
    <>
      <SiteHeader clientAreaHref={clientAreaHref} clientAreaLabel={clientAreaLabel} />
      <main className="flex-1">{children}</main>
      <SiteFooter clientAreaHref={clientAreaHref} clientAreaLabel={clientAreaLabel} />
    </>
  );
}
