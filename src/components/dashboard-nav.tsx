"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Images, LayoutDashboard, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The dashboard shell's ONE navigation (task #129), rendered exactly once by
// `src/app/dashboard/layout.tsx`. Phone: a fixed bottom tab bar in the thumb
// zone. >=1024px: the SAME element becomes the sidebar's nav column — same
// markup, same three destinations, relocated by CSS
// (design/system/dashboard.html:172-195 and :516-530).
//
// One nav, not two, is a hard requirement of epic #125's mobile-first note:
// a second breakpoint-specific copy would have to be duplicated in the chrome
// tests too, and one of the two copies would rot in silence. That is what
// `renders exactly one navigation landmark` in the test file next to this one
// guards, and why every layout rule below is a `lg:` variant on the same
// element rather than a `hidden`/`lg:block` pair.
//
// A client component only because the active route is a client concern:
// `usePathname()` is the only way a shared layout can know which of its
// destinations is current (a Server Component layout is never handed the
// pathname). Everything else in the shell — the guard, the sign-out server
// action — stays on the server, in the layout.

export interface DashboardNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const DASHBOARD_NAV_ITEMS: readonly DashboardNavItem[] = [
  { href: "/dashboard", label: "Panel", icon: LayoutDashboard },
  { href: "/dashboard/clients", label: "Clientes", icon: Users },
  { href: "/dashboard/galleries", label: "Galerías", icon: Images },
];

/**
 * Whether `href` is the destination the current `pathname` belongs to.
 *
 * Two rules, and both of them exist because the obvious one-liner
 * (`pathname.startsWith(href)`) is wrong twice over:
 *
 * - `/dashboard` is a prefix of EVERY route in this segment, so a plain
 *   `startsWith` would light up "Panel" on `/dashboard/clients` — i.e. two
 *   items marked `aria-current="page"` at once, which is both a lie to a
 *   screen reader and the exact "the current route is not indicated" defect
 *   this slice exists to fix. It matches exactly, and only exactly.
 * - Every other destination owns its subtree (`/dashboard/galleries/:id` must
 *   keep "Galerías" current), but the boundary is the `/` — `startsWith` alone
 *   would also claim a hypothetical sibling like `/dashboard/galleries-archivo`.
 */
export function isNavItemCurrent(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardNav() {
  // `usePathname()` is typed non-null inside an app-router tree; the `?? ""`
  // is only for the render-outside-a-router case (unit tests that forget to
  // mock it), where marking nothing current beats throwing.
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Principal"
      // Phone: fixed to the bottom edge, three equal columns, safe-area aware
      // (dashboard.html:178-186). Desktop: static and stacked inside the
      // sidebar column, in SOURCE ORDER — wordmark, then nav, then account.
      // This carried `lg:order-first` until the owner confirmed (2026-07-31)
      // that the mock's `order: -1` was a slip; it has been removed from
      // dashboard.html too, with the reasoning kept there. Nothing here
      // should reorder the sidebar: the DOM order is the reading order and
      // the tab order, and they now agree.
      className="border-line-2 bg-app-surface fixed inset-x-0 bottom-0 z-40 grid h-[var(--app-tabbar-h)] grid-cols-3 border-t pb-[env(safe-area-inset-bottom,0px)] lg:static lg:flex lg:h-auto lg:flex-col lg:gap-[2px] lg:border-t-0 lg:bg-transparent lg:p-0"
    >
      {DASHBOARD_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const isCurrent = isNavItemCurrent(pathname, href);

        return (
          <Link
            key={href}
            href={href}
            aria-current={isCurrent ? "page" : undefined}
            // The current item is NOT a brass wash: `--app-raised` carries the
            // state and only the icon goes brass (dashboard.html:185-186,
            // :527-528). The status palette is deliberately not the brand
            // accent (dashboard.html:82-91), and hover is the same raised
            // surface, never the accent.
            // The font sizes here are named `text-app-*` aliases rather than
            // the `length:`-hinted arbitrary values they were before #175.
            // That is only safe because src/lib/utils.ts teaches tailwind-merge
            // that they ARE sizes: unconfigured, twMerge reads it as a text
            // colour and the `text-fg-mute` on the next line deletes it from
            // the output — the item would silently render at inherited size.
            className={cn(
              "lg:hover:text-fg text-app-micro lg:text-app-base lg:hover:bg-app-raised relative flex flex-col items-center justify-center gap-[3px] transition-colors lg:min-h-[38px] lg:flex-row lg:justify-start lg:gap-2.5 lg:rounded-[var(--app-radius-sm)] lg:px-2.5",
              isCurrent ? "text-fg lg:bg-app-raised" : "text-fg-mute lg:text-fg-dim",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-[17px] shrink-0 lg:size-[15px]",
                isCurrent ? "text-accent" : "text-fg-mute",
              )}
            />
            {label}
          </Link>
        );
      })}
      {/*
        The mock also hangs a pending-review count on the Galerías icon
        (dashboard.html:624-625, `.tabbar__dot` + the `.vh` text beside it).
        It is deliberately NOT here yet: the number would have to be read in
        `dashboard/layout.tsx`, and a layout does not re-run on navigation
        between sibling routes (see that file's header comment and
        src/lib/auth-guards.ts's) — no server action under /dashboard
        revalidates this layout's path either, so the badge would keep
        claiming "2 esperando" after the photographer delivered both. A
        counter that lies is worse than a counter that is missing. It belongs
        to whichever slice can hang it off live data.
      */}
    </nav>
  );
}
