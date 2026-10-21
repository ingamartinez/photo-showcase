// Task #276 — the URL is the only state of the admin gallery list.
//
// This module is deliberately PURE: no `server-only`, no runtime import of
// `@/lib/db`. `import type { Gallery }` below is erased at compile time, so
// the RSC (`src/app/dashboard/galleries/page.tsx`), the client control
// (`src/components/dashboard-gallery-list-controls.tsx`) and the SQL builder
// (`src/lib/galleries.ts`) can all import the SAME parsing, canonical-href
// and sort-toggling logic. Three copies of "what does ?sort=photos&dir=asc
// mean" is how a client and a server end up disagreeing about the URL.
//
// The one thing this module deliberately does NOT do is clamp `page`. Clamping
// needs the matching row count, which only the database knows; the page
// computes it after the count query and calls `clampPage` there. Every link
// this module builds is derived from the ALREADY-CLAMPED query the page
// passes in, so a click from an out-of-range URL returns to a canonical one
// without a redirect.
import type { Gallery } from "@/lib/db/schema";

export const GALLERY_PAGE_SIZE = 25;
export const GALLERY_LIST_PATH = "/dashboard/galleries";

export type GalleryStatus = Gallery["status"];

/** Workflow order — draft first, archived last. This is a PRODUCT rule ("who
 * is this waiting on?"), so it is one typed constant here rather than
 * Postgres's enum declaration order, which nobody reviews as a sort contract.
 * `satisfies Record<GalleryStatus, number>` turns a sixth status added to the
 * enum into a type error until it is ranked. */
export const GALLERY_STATUS_RANK = {
  draft: 0,
  proofing: 1,
  selected: 2,
  delivered: 3,
  archived: 4,
} as const satisfies Record<GalleryStatus, number>;

/** Every status, in workflow order. Drives the filter's options. */
export const GALLERY_STATUSES = (Object.keys(GALLERY_STATUS_RANK) as GalleryStatus[]).sort(
  (a, b) => GALLERY_STATUS_RANK[a] - GALLERY_STATUS_RANK[b],
);

const STATUS_SET = new Set<string>(GALLERY_STATUSES);

/** The six desk columns, in the order the rows place them. */
export const GALLERY_SORT_KEYS = [
  "title",
  "clients",
  "status",
  "package",
  "session",
  "photos",
] as const;

export type GallerySortKey = (typeof GALLERY_SORT_KEYS)[number];

export type SortDirection = "asc" | "desc";

/** The direction a column sorts on its FIRST click — the direction that reads
 * as "the obvious order" for that column: A→Z, workflow order (draft first),
 * newest session, most photos. A second click on the active column reverses
 * it. `dir` is ignored when no sort is chosen: recency is always desc. */
export const DEFAULT_SORT_DIRECTION: Record<GallerySortKey, SortDirection> = {
  title: "asc",
  clients: "asc",
  status: "asc",
  package: "asc",
  session: "desc",
  photos: "desc",
};

export type GalleryListQuery = {
  status: GalleryStatus | null;
  sort: GallerySortKey | null;
  dir: SortDirection;
  page: number;
};

export const DEFAULT_GALLERY_LIST_QUERY: GalleryListQuery = {
  status: null,
  sort: null,
  dir: "desc",
  page: 1,
};

/** `?page=` accepts only a positive decimal integer with no leading zero —
 * so `0`, `-1`, `abc`, `2.5`, `1e3`, `03` and `""` all fall back to page 1. */
const PAGE_PATTERN = /^[1-9][0-9]*$/;

/** Repeated params arrive as `string[]`; `URLSearchParams.get()` returns the
 * first, and so do we, so the server and anything reading the URL in the
 * browser agree. The precedent is `(marketing)/login/page.tsx`'s
 * `Array.isArray(error) ? error[0] : error`. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSortKey(value: string): value is GallerySortKey {
  return (GALLERY_SORT_KEYS as readonly string[]).includes(value);
}

function isDirection(value: string): value is SortDirection {
  return value === "asc" || value === "desc";
}

/** Normalizes raw `searchParams` into the ONE state the page renders from.
 * Unknown or malformed values fall back instead of erroring: a filter is a
 * view, not input, and a shared URL with a stale status should still show a
 * list. The page value is NOT clamped here — see this file's header comment. */
export function parseGalleryListQuery(
  params: Record<string, string | string[] | undefined>,
): GalleryListQuery {
  const statusValue = firstValue(params.status);
  const status =
    statusValue !== undefined && STATUS_SET.has(statusValue)
      ? (statusValue as GalleryStatus)
      : null;

  const sortValue = firstValue(params.sort);
  const sort = sortValue !== undefined && isSortKey(sortValue) ? sortValue : null;

  const dirValue = firstValue(params.dir);
  const dir: SortDirection =
    sort === null
      ? "desc"
      : dirValue !== undefined && isDirection(dirValue)
        ? dirValue
        : DEFAULT_SORT_DIRECTION[sort];

  const pageValue = firstValue(params.page);
  const page = pageValue !== undefined && PAGE_PATTERN.test(pageValue) ? Number(pageValue) : 1;

  return { status, sort, dir, page };
}

export function pageCountFor(matching: number): number {
  return Math.max(1, Math.ceil(matching / GALLERY_PAGE_SIZE));
}

/** Clamps an out-of-range page to the last real page. A redirect would add a
 * round-trip for a URL no UI emits; the clamp plus canonical hrefs means one
 * click returns to the canonical URL anyway. */
export function clampPage(query: GalleryListQuery, matching: number): GalleryListQuery {
  return { ...query, page: Math.min(query.page, pageCountFor(matching)) };
}

/** The ONLY function that builds an href on this page. Params are emitted in
 * a fixed order (`status, sort, dir, page`) and any param equal to its
 * default is omitted, so every state has exactly one URL and the default
 * state is the bare path. */
export function galleryListHref(query: GalleryListQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.sort) {
    params.set("sort", query.sort);
    if (query.dir !== DEFAULT_SORT_DIRECTION[query.sort]) params.set("dir", query.dir);
  }
  if (query.page > 1) params.set("page", String(query.page));

  const search = params.toString();
  return search ? `${GALLERY_LIST_PATH}?${search}` : GALLERY_LIST_PATH;
}

/** Clicking a column heading: the active column reverses, a new one starts at
 * its default direction. Either way the page resets to 1 and the filter
 * survives. */
export function sortedBy(query: GalleryListQuery, key: GallerySortKey): GalleryListQuery {
  const dir =
    query.sort === key ? (query.dir === "asc" ? "desc" : "asc") : DEFAULT_SORT_DIRECTION[key];
  return { ...query, sort: key, dir, page: 1 };
}

/** Encodes the current sort as a `<select>` value: `""` for the default
 * recency order, otherwise `${key}:${dir}`. */
export function sortOptionValue(query: GalleryListQuery): string {
  return query.sort === null ? "" : `${query.sort}:${query.dir}`;
}

/** Decodes a sort `<select>` value. Unknown values decode to the default
 * order, same posture as `parseGalleryListQuery`. */
export function withSortOption(query: GalleryListQuery, value: string): GalleryListQuery {
  const separator = value.indexOf(":");
  const key = separator === -1 ? value : value.slice(0, separator);
  const direction = separator === -1 ? "" : value.slice(separator + 1);

  if (!isSortKey(key)) {
    return { ...query, sort: null, dir: "desc", page: 1 };
  }

  return {
    ...query,
    sort: key,
    dir: isDirection(direction) ? direction : DEFAULT_SORT_DIRECTION[key],
    page: 1,
  };
}

/** Changing the filter keeps the sort and resets the page. */
export function withStatus(
  query: GalleryListQuery,
  status: GalleryStatus | null,
): GalleryListQuery {
  return { ...query, status, page: 1 };
}
