import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { signOutAction } from "@/lib/auth-actions";
import { landingPathForRole } from "@/lib/role-landing";

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
// each page via src/lib/gallery-access.ts's `isGalleryOwner` (task #94 — a
// gallery's clients live in the `gallery_clients` join table, not a single
// `clientId` column on the gallery row), never here.
//
// #96: the logo used to be a hardcoded `Link href="/galleries"`. That is
// correct for a CLIENT (this whole chrome is theirs) but wrong for an ADMIN
// previewing a client's gallery at `/galleries/[publicSlug]` — clicking it
// sent the admin to the ownership-scoped client index, which
// `getGalleriesForClient()` (`src/lib/galleries.ts`) deliberately never
// bypasses for admins, so it renders empty for them. Same assumption as
// #91's marketing-chrome bug, different surface: this one baked "the viewer
// is a client" into a literal string instead of duplicating a role ternary.
// Fixed by routing the logo through `landingPathForRole()`
// (`src/lib/role-landing.ts`), the single place that rule lives — not a
// second inline copy of it.
//
// Destination for a previewing admin: `/dashboard`, not the gallery's own
// `/dashboard/galleries/[galleryId]` detail page, even though the latter is
// arguably more useful (an admin clicking the logo while previewing a
// gallery most likely wants to get back to managing THAT gallery). Rejected
// because of what it costs: this layout only has the route's `publicSlug`
// (see `/galleries/[publicSlug]/page.tsx`), not the gallery's id. Resolving
// the slug to an id here would mean either a second, ad-hoc query bypassing
// the established data-access layer, or an extra DB round trip on every
// render of a layout that today does none — paid by every client on every
// page, to improve one destination for the single admin. `/dashboard` costs
// nothing extra and reuses the exact rule #91 already established.
export default async function GalleriesLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireSession();
  const logoHref = landingPathForRole(session.user.role);

  return (
    <>
      <header className="border-line border-b">
        <div className="wrap flex flex-wrap items-center justify-between gap-6 py-5">
          <Link href={logoHref} className="font-serif text-[20px] tracking-tight">
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
