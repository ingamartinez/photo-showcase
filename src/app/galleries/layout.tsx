import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { signOutAction } from "@/lib/auth-actions";

// Client-area chrome for everything under `/galleries` — this task's own
// `/galleries/[publicSlug]` page today, and task #22's `/galleries` list next
// to it. Deliberately minimal and generic (no gallery-specific state, no nav
// items beyond sign-out): #22 owns building that list page, this only
// avoids each route re-implementing its own header/sign-out affordance.
// `requireSession()` here is DEFENSE IN DEPTH ONLY, same caveat as
// `src/app/dashboard/layout.tsx` — every page under this segment calls it
// again itself; see `src/lib/auth-guards.ts`'s header comment for why a
// layout must never be the only check anything relies on. Any signed-in
// user — client or admin — passes this; per-gallery OWNERSHIP is decided by
// each page from the gallery row's own `clientId`, never here.
export default async function GalleriesLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireSession();

  return (
    <>
      <header className="border-line border-b">
        <div className="wrap flex flex-wrap items-center justify-between gap-6 py-5">
          <Link href="/galleries" className="font-serif text-[20px] tracking-tight">
            <span className="font-normal">Alejo</span> <span className="text-accent">Frames</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-x-8 gap-y-3">
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
