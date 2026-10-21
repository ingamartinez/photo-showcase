"use client";

// Task #276 — the gallery list's filter + sort strip, at EVERY width (the
// desk's clickable headings are a second affordance, not a replacement: the
// sort select is the only way back to the default "Actividad reciente" order,
// and it states the current order in words).
//
// The URL is the state, exactly like `acting-client-select.tsx`. This is a
// controlled `<select>` fed by the server's normalized query, which creates
// one problem: between the click and the RSC payload landing, the prop still
// says the OLD value and React would snap the select back — visibly wrong,
// and re-keying the element to resync would drop keyboard focus.
//
// The fix is a PENDING OVERRIDE: remember the query the user chose and show
// it until the server's normalized query arrives, then drop it. It is not a
// second source of truth about the URL — it is the last click, and it lives
// exactly as long as the server is behind it. "Arrives" is detected by prop
// IDENTITY: every RSC render hands down a fresh object (`parseGalleryListQuery`
// builds one), while a client-only re-render keeps the same reference.
//
// Task #276 DEVIATION, with evidence: the approved plan called for
// `useOptimistic(query)` here, and it does not deliver this. React reverts
// optimistic state as soon as the transition that scheduled it completes, and
// `router.push` is synchronous — the RSC fetch lives in Next's OWN transition.
// Proven with a minimal `useOptimistic` + `useTransition` + sync click under
// jsdom: the optimistic value was already back to the prop when the click's
// `await` returned. So the select would still snap back for the whole
// navigation, which is the defect the plan set out to prevent.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  galleryListHref,
  sortOptionValue,
  withSortOption,
  withStatus,
  type GalleryListQuery,
  type GalleryStatus,
} from "@/lib/gallery-list-query";

/** The labels are resolved by the RSC and passed in, not imported here: the
 * status labels come from `formatGalleryStatus` in the `server-only`
 * `@/lib/galleries`, same pattern as `acting-client-select.tsx`'s resolved
 * labels. */
export type GalleryListStatusOption = { value: GalleryStatus; label: string };
export type GalleryListSortOption = { value: string; label: string };

export function DashboardGalleryListControls({
  query,
  statusOptions,
  sortOptions,
}: {
  query: GalleryListQuery;
  statusOptions: GalleryListStatusOption[];
  sortOptions: GalleryListSortOption[];
}) {
  const router = useRouter();
  const [pendingQuery, setPendingQuery] = useState<GalleryListQuery | null>(null);
  const shownQuery = pendingQuery ?? query;
  const lastQuery = useRef(query);

  // Any new prop object means a server render landed; from then on the URL is
  // the truth, whatever value the select is showing.
  useEffect(() => {
    if (lastQuery.current !== query) {
      lastQuery.current = query;
      setPendingQuery(null);
    }
  }, [query]);

  function navigate(next: GalleryListQuery) {
    setPendingQuery(next);
    // `push`, not `replace`: a filter is navigation (Back undoes it), unlike
    // "who am I acting as" in `acting-client-select.tsx`. Wrapped in a
    // transition so the list stays interactive while the RSC payload loads.
    router.push(galleryListHref(next));
  }

  // `.panel__head`, design/system/dashboard.html:276-280 — the mock's raised
  // strip. Phone: a two-column grid with full-width selects. From 600px: one
  // row of auto-width selects. Both are min-width rules only (epic #125).
  return (
    <div className="border-line bg-app-raised grid grid-cols-2 gap-2 border-b px-[var(--app-cell-x)] py-2.5 min-[600px]:flex min-[600px]:items-center min-[600px]:justify-between">
      <label className="flex min-w-0 flex-col gap-1 min-[600px]:flex-row min-[600px]:items-center min-[600px]:gap-2">
        <span className="text-fg-mute text-app-micro tracking-[0.06em] uppercase">Estado</span>
        <select
          value={shownQuery.status ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            navigate(withStatus(shownQuery, value === "" ? null : (value as GalleryStatus)));
          }}
          // The 44px phone floor (--app-tap) and the mock's 36px `.btn--sm`
          // on the desk. `color-scheme: dark` (globals.css) already darkens
          // the native dropdown; no custom menu to maintain.
          className="border-line-2 bg-app-surface text-fg text-app-body min-h-[var(--app-tap)] w-full rounded-[var(--app-radius-sm)] border px-3 min-[600px]:w-auto lg:min-h-9"
        >
          <option value="">Todas</option>
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-0 flex-col gap-1 min-[600px]:flex-row min-[600px]:items-center min-[600px]:gap-2">
        <span className="text-fg-mute text-app-micro tracking-[0.06em] uppercase">Ordenar por</span>
        <select
          value={sortOptionValue(shownQuery)}
          onChange={(event) => {
            navigate(withSortOption(shownQuery, event.target.value));
          }}
          className="border-line-2 bg-app-surface text-fg text-app-body min-h-[var(--app-tap)] w-full rounded-[var(--app-radius-sm)] border px-3 min-[600px]:w-auto lg:min-h-9"
        >
          {sortOptions.map((option) => (
            <option key={option.value || "default"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
