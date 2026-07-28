import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { signOutAction } from "@/lib/auth-actions";

// Dashboard chrome: top bar with nav + sign-out, no marketing header/footer
// (see `src/app/layout.tsx` for why this is a plain segment, not a route
// group). `requireAdmin()` here is DEFENSE IN DEPTH ONLY — every page (and
// any route handler or server action) under this segment calls it again
// itself. A layout does not re-run on sibling navigation and never runs at
// all for Route Handlers or Server Actions, so relying on this call alone
// would silently stop protecting the moment someone added either underneath
// this tree. See `src/lib/auth-guards.ts`'s header comment for the full
// reasoning; do not "simplify" this into the only check.
export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireAdmin();

  return (
    <>
      <header className="border-line border-b">
        <div className="wrap flex flex-wrap items-center justify-between gap-6 py-5">
          <Link href="/dashboard" className="font-serif text-[20px] tracking-tight">
            <span className="font-normal">Alejo</span> <span className="text-accent">Frames</span>
            <span className="label text-fg-mute ml-3 align-middle">Panel</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Link
              href="/dashboard/clients"
              className="text-fg-dim hover:text-fg text-[13px] tracking-[0.08em] uppercase transition-colors"
            >
              Clientes
            </Link>
            <Link
              href="/dashboard/galleries"
              className="text-fg-dim hover:text-fg text-[13px] tracking-[0.08em] uppercase transition-colors"
            >
              Galerías
            </Link>
            <span className="text-fg-mute hidden text-[13px] sm:inline">{session.user.email}</span>
            <form action={signOutAction}>
              <button
                type="submit"
                className="border-line-2 hover:border-accent hover:text-accent-2 rounded-sm border px-[16px] py-[9px] text-[13px] tracking-[0.1em] uppercase transition-colors"
              >
                Cerrar sesión
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <div className="wrap py-[clamp(40px,6vh,72px)]">{children}</div>
      </main>
    </>
  );
}
