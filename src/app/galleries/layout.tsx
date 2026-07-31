import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { signOutAction } from "@/lib/auth-actions";
import { landingPathForRole } from "@/lib/role-landing";

// Client-area chrome for everything under `/galleries` — the `/galleries`
// list (#22) and `/galleries/[publicSlug]`.
//
// #142: this used to reuse the marketing chrome verbatim (the `.wrap`
// column, a 20px serif wordmark, the account email hidden under `sm:`, an
// `uppercase tracking-[0.1em]` bordered "Cerrar sesión" button) and its own
// comment called that "deliberately minimal and generic". That was the right
// call when #23 only needed a roof over the page; it is not the right call
// for the only product a paying client ever touches. It is now the chrome of
// `design/system/client.html` (`.siteheader`/`.wordmark`/`.signout`, lines
// 100-111, markup at 590-593): the client does not navigate — they arrive by
// magic link at ONE gallery — so the chrome says whose studio this is and
// how to leave, and nothing else. Where they are is the page's own display
// heading, not a nav item.
//
// The account email is deliberately GONE from here rather than restyled. It
// was `hidden sm:inline`, i.e. invisible on the phone — which epic #140
// declares the primary case for this surface, not the degraded one — and the
// approved mock's header has exactly two elements. Identity on a gallery is
// shared anyway (#94: several clients per gallery, one joint selection), so
// the mock answers "which of us picked this" per-photo on the board
// (`.who span.is-you`, `.crew__av.is-you`), which is where the question is
// actually asked. Do not re-add it to the header without moving the mock.
//
// Mobile-first, per the epic's hard rule: the base classes below ARE the
// phone layout and every breakpoint only ADDS. The two `min-width` steps
// mirror the mock's own (`min-[620px]`, `lg` = 1024px) and the gutter values
// they carry are the mock's `--gutter` at each step (16px -> 28px -> 48px,
// lines 50, 531, 554). No `max-width` media query, here or in anything this
// chrome owns.
//
// This surface stays on the EDITORIAL system and must never set
// `data-surface="app"` (globals.css:107) — that token layer is the
// dashboard's (#128/#129). Serif display type, banned on the panel, is
// correct here. See epic #140 for why the split is a product decision.
//
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
      {/* `.siteheader`, client.html:100-104 — flex row, 16px gap, 14px block
          padding, the gutter inline, hairline `--line` underneath. Not a
          `<nav>` any more: with the email gone there is exactly one control
          left, and a one-item navigation landmark is noise a screen-reader
          user has to step through. */}
      <header className="border-line flex items-center justify-between gap-4 border-b px-4 py-[14px] min-[620px]:px-7 lg:px-12">
        {/* `.wordmark`, client.html:105-106 and 591: 19px serif, -0.01em, the
            second word in `--accent`. Accessible name stays exactly "Alejo
            Frames" — layout.chrome.test.tsx looks the logo up by it. */}
        <Link href={logoHref} className="font-serif text-[19px] font-normal tracking-[-0.01em]">
          Alejo <span className="text-accent">Frames</span>
        </Link>
        {/* Still a real form submit against the server action — never an
            onClick — so sign-out works with JS disabled and the session row
            is deleted server-side (see src/lib/auth-actions.ts). */}
        <form action={signOutAction}>
          {/* `.signout`, client.html:107-111: quiet text control in
              `--fg-mute`, 12px, no border, brightening to `--fg` on hover.
              `min-h-12` is the mock's `--tap: 48px` (line 49) — the whole
              48px is the touch target even though the ink is 12px. */}
          <button
            type="submit"
            className="text-fg-mute hover:text-fg min-h-12 cursor-pointer px-[2px] text-xs transition-colors"
          >
            Cerrar sesión
          </button>
        </form>
      </header>
      {/* The content column. `.wrap` is gone (its `--gutter` is
          `clamp(20px,5vw,72px)`, a different scale from the mock's) in favour
          of the mock's own stepped gutter and `.pad`'s 1280px measure
          (client.html:115, 560). Vertical rhythm: 26px above, matching
          `.proof-head` (line 178); 64px below, matching `.page` at the desk
          breakpoint (line 555) rather than the phone's
          `calc(var(--bar-h) + 24px)`, because the fixed quota bar that value
          reserves room for does not exist on this surface yet (#147) and
          100px of empty floor under a short page is just a hole.

          Deliberately still a padded column, NOT the mock's full-bleed page:
          in the mock the gutter lives on `.pad`/`.proof-head` per section so
          `.grid` and `.gal-list` can run edge to edge. Moving it there means
          editing both pages' own layout, which is #143 and the index slice,
          not this one — doing it here would leave the current grids
          unpadded against the viewport edge in the meantime. */}
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-[26px] pb-16 min-[620px]:px-7 lg:px-12">
        {children}
      </main>
    </>
  );
}
