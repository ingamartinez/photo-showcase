import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

// Marketing chrome, scoped to this route group only — see the comment in
// `src/app/layout.tsx` for why this is a parenthesized group (no URL
// segment) rather than the dashboard's plain segment layout. Everything
// nested under `(marketing)/` — `/`, `/about`, `/contact`, `/work*`,
// `/login*` — gets the public header and footer; `/dashboard*` does not,
// because it is not nested here.
export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </>
  );
}
