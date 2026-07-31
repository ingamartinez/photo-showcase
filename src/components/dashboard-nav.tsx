"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Images, LayoutDashboard, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPendingSelectionCount } from "@/lib/format";

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

// How often the pending-review badge below re-asks the server, while this
// tab is visible — task #174. Not a fallback for a push transport (there
// isn't one here; see this file's own header comment further down for why),
// this IS the mechanism. Chosen, not copied from `SELECTION_POLL_INTERVAL_MS`
// (`@/components/use-shared-selection`, 30s): that number paces a FALLBACK
// behind an SSE stream that carries the normal case in under a second, so its
// size barely matters. This number paces the ONLY transport this badge has,
// so it trades directly against staleness — a photographer who submits from
// a client's tab and then checks their own open dashboard tab is judging this
// slice by how many seconds that takes. 20s keeps that wait short without
// meaningfully adding to a route that costs one indexed `COUNT` query, for a
// product with exactly one admin (PLAN.md §4) who realistically has a
// handful of tabs open at once.
//
// Exported ONLY so dashboard-nav.test.tsx can drive its polling tests
// against the REAL cadence instead of a hand-copied literal that could
// silently drift from it — same reason `SELECTION_POLL_INTERVAL_MS`
// (`@/components/use-shared-selection`) is exported.
export const PENDING_COUNT_POLL_INTERVAL_MS = 20_000;

/**
 * Polls `GET /api/galleries/pending-count` for as long as this hook stays
 * mounted, which — because `<DashboardNav>` is rendered exactly once by
 * `dashboard/layout.tsx` and that layout does not re-run between sibling
 * routes — is the entire time an admin has ANY `/dashboard/**` tab open. See
 * this file's own header comment for why a poll, not a push transport, is
 * the whole mechanism here.
 *
 * Returns `null` until the first response lands (an honest "don't know yet",
 * never a guessed 0 that could read as "nothing pending" for a moment it
 * isn't true), then the server's own last-reported count. A failed tick
 * — network hiccup, a 401 because the session just expired, anything —
 * leaves the previous count in place rather than resetting to 0 or null:
 * stale-but-honest beats confidently wrong, the same VALUE
 * `use-shared-selection.ts`'s own poll loop keeps on a failed tick. That
 * module's `poll()` (the non-ok branch at :361-368, the throw branch at
 * :402-404) takes a strictly LARGER stance than this hook does, though, and
 * this is not claimed to match it: it counts consecutive failures and
 * escalates to a visible `isStale` flag the tray surfaces
 * (`STALE_AFTER_CONSECUTIVE_FAILURES`, 2 in a row). This hook never
 * escalates — it keeps the last value and says nothing, indefinitely.
 * Deliberately not adopted here: sessions default to a 30-day database
 * session (`src/auth.ts`, `strategy: "database"`, no `maxAge` override), so a
 * 401 mid-tab is rare, and this badge is dashboard chrome nobody makes a
 * quota or delivery decision against — unlike the tray, where a silently
 * stale submit lock is the exact bug #95 exists to prevent. If that
 * assumption changes, the fix is copying the escalation, not assuming it is
 * already here.
 */
function usePendingSelectionCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  // Guards against two ticks overlapping (the interval firing again while a
  // slow request from the previous tick is still in flight) — same shape as
  // `pollInFlightRef` in use-shared-selection.ts, for the same reason: a
  // second concurrent request here buys nothing but out-of-order responses.
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const response = await fetch("/api/galleries/pending-count");
        // A RESOLVED response that is not ok — most likely a 401 because the
        // session expired mid-tab — is a different path than the `catch`
        // below (a rejected fetch, e.g. offline). Same outcome deliberately:
        // leave `count` exactly as it was and let the next tick retry, per
        // this function's own doc comment.
        // A RESOLVED response that is not ok — most likely a 401 because the
        // session expired mid-tab — is a different path than the `catch`
        // below (a rejected fetch, e.g. offline). Same outcome deliberately:
        // leave `count` exactly as it was and let the next tick retry, per
        // this function's own doc comment.
        if (!response.ok) return;
        const body = (await response.json()) as { count: number };
        if (!cancelled) setCount(body.count);
      } catch {
        // Swallowed on purpose — see this function's own doc comment on why
        // a failed tick leaves the last known count alone. The next tick, or
        // the next tab-visibility wake-up below, retries.
      } finally {
        inFlightRef.current = false;
      }
    }

    // Unlike `use-shared-selection.ts`'s poll loop (which deliberately skips
    // the FIRST tick because the server-rendered page it lives on already
    // handed it a fresh value), this hook has no such seed: `DashboardNav` is
    // a Client Component mounted with no server-read count to start from —
    // see this file's own header comment on why `dashboard/layout.tsx`
    // cannot supply one. So the very first thing this hook does is fetch.
    void poll();

    const interval = setInterval(() => {
      // Same reasoning as the shared-selection poll loop: a backgrounded tab
      // is not worth a request, and the visibility listener below catches it
      // back up the moment it returns.
      if (typeof document !== "undefined" && document.hidden) return;
      void poll();
    }, PENDING_COUNT_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return count;
}

export function DashboardNav() {
  // `usePathname()` is typed non-null inside an app-router tree; the `?? ""`
  // is only for the render-outside-a-router case (unit tests that forget to
  // mock it), where marking nothing current beats throwing.
  const pathname = usePathname() ?? "";
  const pendingSelectionCount = usePendingSelectionCount();

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
            {/*
              Task #174 — the pending-review count the epic (#125) names
              explicitly, given a MECHANISM this time, not a pixel: see this
              file's own header comment above (`usePendingSelectionCount`)
              for what keeps it true, and the API route's own header comment
              (`src/app/api/galleries/pending-count/route.ts`) for why a
              poll, not the per-gallery SSE channel this codebase already
              has, is the transport. Hung on the Galerías item specifically
              — matching `dashboard.html:624-625`'s own `.tabbar__dot` —
              because that is the ONE destination this number is actually
              about; a studio-wide badge on the wordmark or on every item
              would say less, not more.

              `pendingSelectionCount` is checked narrowly (`!== null &&
              > 0`), not through a derived `string | null` copy computed
              outside this block: the copy and the raw digit both need the
              SAME guard, and computing them from one already-narrowed value
              here is what lets TypeScript prove that, rather than trusting
              two separately-computed values never to disagree.
            */}
            {href === "/dashboard/galleries" &&
              pendingSelectionCount !== null &&
              pendingSelectionCount > 0 && (
                <>
                  <span
                    aria-hidden="true"
                    // Phone: absolute, top-right of the icon
                    // (dashboard.html:193-200's own `.tabbar__dot`, same
                    // offsets). Desktop: `position: static`, pushed to the
                    // end of the row by `ml-auto` (dashboard.html:548) — the
                    // Link this sits inside is already `relative` on phone
                    // and a `flex-row` on `lg:`, so no extra positioning
                    // context is needed here.
                    className="bg-accent absolute top-[8px] left-1/2 ml-[7px] grid h-4 min-w-[16px] place-items-center rounded-full px-1 text-[10px] font-bold text-[#14100A] tabular-nums lg:static lg:top-auto lg:left-auto lg:mt-0 lg:ml-auto"
                  >
                    {pendingSelectionCount}
                  </span>
                  {/* The full Spanish sentence, for anyone not reading the
                      dot visually — same split the mock itself uses
                      (`.tabbar__dot` + `.vh`, dashboard.html:642-643):
                      the digit alone is not a sentence a screen reader
                      should announce as-is. */}
                  <span className="sr-only">
                    {formatPendingSelectionCount(pendingSelectionCount)}
                  </span>
                </>
              )}
          </Link>
        );
      })}
    </nav>
  );
}
