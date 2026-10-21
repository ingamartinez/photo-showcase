import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import {
  formatGalleryStatus,
  formatSessionDate,
  getGalleriesWithDetails,
  getGalleryListCounts,
  getPendingSelectionCount,
  type GalleryWithDetails,
} from "@/lib/galleries";
import {
  formatFilteredGalleryCount,
  formatGalleryPageRange,
  formatPageOf,
  formatPendingSelectionCount,
  formatStudioGalleryCount,
} from "@/lib/format";
import { getClientsForPicker } from "@/lib/clients";
import { getActivePackages } from "@/lib/packages";
import { DashboardGalleryCreateDialog } from "@/components/dashboard-gallery-create-dialog";
import { DashboardGalleryListControls } from "@/components/dashboard-gallery-list-controls";
import {
  DEFAULT_SORT_DIRECTION,
  GALLERY_PAGE_SIZE,
  GALLERY_SORT_KEYS,
  GALLERY_STATUSES,
  clampPage,
  galleryListHref,
  pageCountFor,
  parseGalleryListQuery,
  sortedBy,
  type GallerySortKey,
  type SortDirection,
} from "@/lib/gallery-list-query";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Galerías",
  // Admin workspace — never indexed, never followed. Same stance as /login
  // and /dashboard.
  robots: { index: false, follow: false },
};

// The six columns the desk shows, in the order the rows place them.
// design/system/dashboard.html:792-795. Keyed by the SORT key, so the legend
// and the ORDER BY cannot disagree about which column is which.
const COLUMN_HEADINGS: Record<GallerySortKey, string> = {
  title: "Galería",
  clients: "Clientes",
  status: "Estado",
  package: "Paquete",
  session: "Sesión",
  photos: "Fotos",
};
const GALLERY_COLUMNS = GALLERY_SORT_KEYS.map((key) => ({ key, heading: COLUMN_HEADINGS[key] }));

// The sort `<select>`'s copy (task #276 §0.3). The sort select is redundant
// with the desk's clickable headings ON PURPOSE: it is the only way back to
// the default "Actividad reciente" order, and it states the current order in
// words instead of in an arrow.
const SORT_LABELS: Record<GallerySortKey, Record<SortDirection, string>> = {
  title: { asc: "Galería (A–Z)", desc: "Galería (Z–A)" },
  clients: { asc: "Clientes (A–Z)", desc: "Clientes (Z–A)" },
  status: { asc: "Estado (de borrador a archivada)", desc: "Estado (de archivada a borrador)" },
  package: { asc: "Paquete (A–Z)", desc: "Paquete (Z–A)" },
  session: { asc: "Sesión (más antigua)", desc: "Sesión (más reciente)" },
  photos: { asc: "Fotos (menos primero)", desc: "Fotos (más primero)" },
};

// The 1024px column track, shared verbatim by the header row and every gallery
// row — one constant so the two can never drift apart.
// design/system/dashboard.html:561 and :572.
const DESK_COLUMNS =
  "lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_152px_100px_108px_56px] lg:gap-3.5";

/* THE STATUS RAMP.
 *
 * Deliberately NOT the brand accent, with one deliberate exception: the ramp
 * answers "who is this waiting on?", and `selected` (the one state that means
 * the PHOTOGRAPHER is the blocker) is the accent. That is task #75's
 * semantics carried into the table, and it is the accent as a FEATURE fill —
 * never as a hover or focus wash (the rule globals.css's
 * --color-accent-foreground comment states).
 *
 * Every value is a reference to an existing brand token rather than a hex of
 * its own, so a palette change cannot leave the ramp behind. The row
 * publishes ONE custom property, `--row-status`, and every status-coloured
 * thing under it (the 3px stripe, the badge's ink, border and wash) reads
 * that one property. `--row-status` is NOT a design token and is deliberately
 * not named like one — it is a local per-row channel.
 */
const STATUS_RAMP: Record<GalleryWithDetails["status"], string> = {
  draft: "[--row-status:var(--fg-mute)]",
  proofing: "[--row-status:var(--steel)]",
  selected: "[--row-status:var(--accent)]",
  delivered: "[--row-status:var(--canvas)]",
  archived: "[--row-status:var(--line)]",
};

// Calls requireAdmin() itself, same as every other page under /dashboard —
// see src/lib/auth-guards.ts's header comment for why a page must never rely
// on an ancestor layout as its only check.
//
// ---------------------------------------------------------------------------
// TASK #131 — the list is a table on the desk and a stack of cards on a phone,
// out of ONE markup. It is a <ul> of <li>, not a <table>: epic #125's
// mobile-first note makes that the rule, because the only way a real <table>
// reaches 390px is horizontal scroll or a second copy of the markup, and a
// second copy has to be duplicated in the chrome tests too, where one of the
// two copies rots in silence.
//
// The mechanism, from design/system/dashboard.html:283-331 and :557-583:
//   phone    `grid-template-areas` stacks title+badge, then clients, then meta
//            and count on one line.
//   >=600px  the same areas, rearranged onto three columns (:485-491).
//   >=1024px areas are cleared, every child auto-places into the six-column
//            track above, and a header row (which exists at NO other width)
//            appears. `display: contents` on the meta cell is the trick that
//            makes it work: paquete and fecha are one compact line on a phone
//            and two REAL grid columns on the desk, from the same elements.
//
// Every breakpoint rule here is `min-[600px]:` or `lg:` and only ADDS. There
// is no `max-width` query anywhere on this page — epic #125's hard rule.
// ---------------------------------------------------------------------------
//
// TASK #276 — the URL is the only state of this list: ?status, ?sort, ?dir,
// ?page. This page normalizes it, asks the count query how many rows match,
// CLAMPS the page to the last real one (no redirect: every link below is built
// from the clamped state, so one click returns to a canonical URL), and only
// then fetches that page. Both counter numbers come from queries, never from
// the rendered rows — see the comment below.
export default async function GalleriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();

  const parsed = parseGalleryListQuery(await searchParams);
  // The count comes FIRST because the clamp and the pager both need it. These
  // four are independent, so they travel together.
  const [counts, pendingCount, clients, packages] = await Promise.all([
    getGalleryListCounts(parsed.status),
    getPendingSelectionCount(),
    getClientsForPicker(),
    getActivePackages(),
  ]);
  const query = clampPage(parsed, counts.matching);
  const pageCount = pageCountFor(counts.matching);
  // Always called, even when nothing matches: it returns [] cheaply, and the
  // empty branches below are keyed off the COUNTS, not off `galleries.length`
  // — otherwise an out-of-range page and an empty studio would look alike.
  const galleries = await getGalleriesWithDetails(query);

  // TASK #276 RETIRES the #129/#174 invariant that "both counters are counted
  // off the very rows rendered below". Pagination made that impossible: page 2
  // of 3 renders 25 of 63 galleries, so a row-derived "en total" would LIE.
  // The replacements are still the same predicates, just queried:
  //   - `studioTotal`/`matching` from `getGalleryListCounts` (every status,
  //     archived included — this page's "en total" has always meant that);
  //   - the pending tally from `getPendingSelectionCount`, the SAME function
  //     the nav badge reads, so the two can never disagree. It is deliberately
  //     NOT filtered: it is the photographer's queue for the day, not a
  //     property of the page they happen to be looking at (§0.8).
  // #263's predicate is unchanged: a gallery counts when claimed photos have
  // no uploaded final, in a status that can hold work.
  const pendingCopy = formatPendingSelectionCount(pendingCount);
  const countCopy =
    query.status === null
      ? `${formatStudioGalleryCount(counts.studioTotal)} en total`
      : formatFilteredGalleryCount(counts.matching, counts.studioTotal);
  const firstRow = (query.page - 1) * GALLERY_PAGE_SIZE + 1;
  const lastRow = firstRow + galleries.length - 1;

  const statusOptions = GALLERY_STATUSES.map((status) => ({
    value: status,
    label: formatGalleryStatus(status),
  }));
  // Approved plan §4's option ORDER: each column's default direction first,
  // its reverse second. That is `asc, desc` for the four A→Z / workflow
  // columns, and `desc, asc` for Sesión and Fotos — where "más reciente" /
  // "más primero" is the order that reads as the obvious one, and therefore
  // belongs at the top of the list. `DEFAULT_SORT_DIRECTION` is the single
  // declaration of that per-column default, so the first option here and the
  // first click on the column heading can never disagree.
  const sortOptions = [
    { value: "", label: "Actividad reciente" },
    ...GALLERY_SORT_KEYS.flatMap((key) => {
      const first = DEFAULT_SORT_DIRECTION[key];
      const second: SortDirection = first === "asc" ? "desc" : "asc";
      return [first, second].map((dir) => ({
        value: `${key}:${dir}`,
        label: SORT_LABELS[key][dir],
      }));
    }),
  ];

  return (
    <>
      {/* Page head: `.page-head`, dashboard.html:208-217 and :473-475 — the
          title stacked over the action on a phone, side by side from 600px.
          The editorial `clamp(30px,4.5vw,52px)` serif display headline and the
          `.label` mono eyebrow this page used to open with are gone; that is
          the defect epic #125 exists to fix, not a detail. */}
      <div className="mb-4 min-[600px]:flex min-[600px]:items-end min-[600px]:justify-between min-[600px]:gap-4">
        <div>
          <h1 className="text-fg text-app-title font-medium tracking-[-0.015em] text-balance">
            Galerías
          </h1>
          {/* Suppressed at zero rather than reading "0 galerías en total":
              the panel's own empty state below says it in words. */}
          {counts.studioTotal > 0 && (
            <p className="text-fg-dim text-app-body mt-[5px]">
              {/* No filter: "23 galerías en total · 2 selecciones esperando" —
                  the copy this page has always shown. With a filter, "3 de 63
                  galerías" so the number above the list names BOTH the filtered
                  total and the studio total (§0.3). The wording comes from the
                  shipped pluralizers in @/lib/format instead of a fifth
                  hand-rolled one. */}
              {countCopy}
              {pendingCopy && ` · ${pendingCopy}`}
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2 min-[600px]:mt-0 min-[600px]:flex-none min-[600px]:items-end">
          <DashboardGalleryCreateDialog clients={clients} packages={packages} />
          {/* Epic #232: flash galleries are a separate area (photos to give
              away), reached from here rather than a fourth nav destination. */}
          <Link href="/dashboard/flash" className="text-fg-dim text-app-body underline">
            Galerías flash
          </Link>
        </div>
      </div>

      {/* `.panel`, dashboard.html:270-274. Panel order: control strip, desk
          legend, rows, pager. A GENUINE empty studio shows none of them. */}
      <div className="border-line bg-app-surface overflow-hidden rounded-[var(--app-radius)] border">
        {counts.studioTotal === 0 ? (
          /* `.empty`, dashboard.html:351-354. Reached because the studio has
             ZERO galleries (`studioTotal === 0`), never because this page
             assumed it — and never because a filter matched nothing, which has
             its own block below.
             No second "Nueva galería" button here on purpose — the page head
             already has the one trigger, and two controls with the same
             accessible name pointing at the same dialog is noise in a work
             tool. */
          <div className="text-fg-dim text-app-body px-[var(--app-pad-card)] py-8 text-center">
            <p className="text-fg text-app-lead mb-1.5">Todavía no armaste ninguna galería.</p>
            <p className="mx-auto max-w-[46ch]">
              Arma la primera desde «Nueva galería» — elige paquete, título y fecha de la sesión. El
              cliente es opcional: puedes agregarlo después.
            </p>
          </div>
        ) : (
          <>
            {/* The filter and sort strip, `.panel__head` (dashboard.html:276-280),
                at EVERY width — the desk headings are a second affordance, not
                a replacement. The labels are resolved here (the RSC), because
                `formatGalleryStatus` lives in the server-only galleries module. */}
            <DashboardGalleryListControls
              query={query}
              statusOptions={statusOptions}
              sortOptions={sortOptions}
            />

            {counts.matching > 0 ? (
              <>
                {/* `.rowhead`, dashboard.html:293 and :559-568. The ONE element
                    on this page that exists at a single width, and it is a
                    legend for columns that only exist at that width — not a
                    second copy of a row.

                    TASK #276 MOVED IT OUT OF THE <ul>. It is no longer
                    `aria-hidden`: its six cells are now LINKS, and focusable
                    content inside an aria-hidden subtree is an accessibility
                    violation. It is a `role="group"` of links, not a table
                    role — epic #125 forbids fake table roles on a <ul>, and
                    `aria-sort` is only valid on a columnheader. The active
                    direction therefore travels in the link's ACCESSIBLE NAME
                    (", orden ascendente" / ", orden descendente"), which is
                    also why there is no `aria-sort` and no `aria-current`
                    anywhere on this page.

                    Outside the <ul>, the list count stays honest: 25
                    galleries, not 26 items. At <1024px the group is
                    `display: none`, so it is absent from the accessibility
                    tree entirely and the select above is the sort control. */}
                <div
                  role="group"
                  aria-label="Ordenar por columna"
                  className={cn(
                    "text-fg-mute text-app-micro bg-app-raised border-line hidden items-center border-b py-[5px] pr-[var(--app-cell-x)] pl-[calc(var(--app-cell-x)+3px)] tracking-[0.06em] uppercase lg:grid",
                    DESK_COLUMNS,
                  )}
                >
                  {GALLERY_COLUMNS.map(({ key, heading }) => {
                    const active = query.sort === key;
                    return (
                      <Link
                        key={key}
                        href={galleryListHref(sortedBy(query, key))}
                        className={cn(
                          "inline-flex min-h-6 items-center gap-1",
                          active ? "text-fg" : "text-fg-mute hover:text-fg",
                          key === "photos" && "justify-self-end",
                        )}
                      >
                        {heading}
                        {active && (
                          <>
                            <span aria-hidden="true">
                              {query.dir === "asc" ? "\u2191" : "\u2193"}
                            </span>
                            <span className="sr-only">
                              {query.dir === "asc" ? ", orden ascendente" : ", orden descendente"}
                            </span>
                          </>
                        )}
                      </Link>
                    );
                  })}
                </div>

                <ul className="divide-line divide-y">
                  {galleries.map((gallery) => (
                    <li key={gallery.id}>
                      {/* The whole row is the link, at every width — `.row`,
                          dashboard.html:295-313 / :485-491 / :570-576.

                          Touch target: three stacked lines plus 12px of vertical
                          padding on a phone; `--app-row-h` (52px) is the floor on
                          the desk. MEASURED in Chromium against the built
                          stylesheet, not assumed — 93.3px at 320px and 390px, 73.3px
                          at 768px, 52px at 1024px and 1280px. The phone value clears
                          epic #125's 44px touch floor with room to spare and the
                          desk value clears WCAG 2.2 SC 2.5.8's 24px pointer minimum.
                          No width from 320px to 1280px produces horizontal overflow.

                          Hover is a 2.8% white wash (:308), NEVER brass — epic
                          #125's rule, and it cost a review round in #127/#128.
                          Focus comes from globals.css:472-474's global outline, the
                          same 2px brass the mock uses (dashboard.html:113). */}
                      <Link
                        href={`/dashboard/galleries/${gallery.id}`}
                        // The status, machine-readable. This is what the chrome
                        // tests assert on — see the note on the badge below.
                        data-status={gallery.status}
                        className={cn(
                          "hover:bg-fg/[2.8%] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] px-[var(--app-cell-x)] py-3 transition-colors",
                          "[grid-template-areas:'title_state''who_who''meta_n']",
                          "min-[600px]:grid-cols-[minmax(0,1fr)_auto_auto] min-[600px]:gap-x-3.5 min-[600px]:gap-y-1 min-[600px]:[grid-template-areas:'title_state_n''who_meta_meta']",
                          "lg:min-h-[var(--app-row-h)] lg:py-0 lg:[grid-template-areas:none]",
                          DESK_COLUMNS,
                          STATUS_RAMP[gallery.status],
                        )}
                      >
                        <span className="text-app-base lg:text-app-body [grid-area:title] lg:[grid-area:auto]">
                          {gallery.title}
                        </span>

                        <span className="text-fg-dim text-app-body [grid-area:who] lg:[grid-area:auto]">
                          {/* Task #94: a gallery can have several clients now —
                              joined with " · " so the list still fits on one
                              line without truncating anyone.

                              Task #100: ZERO clients is a legitimate state for a
                              draft, so it gets its own words AND its own muted,
                              italic treatment (`.row__fallback`,
                              dashboard.html:322 / :725). Joining an empty list would
                              render a leading separator floating over nothing, which
                              reads as missing data rather than as a deliberate
                              state. */}
                          {gallery.clients.length === 0 ? (
                            <span className="text-fg-mute italic">Todavía sin cliente</span>
                          ) : (
                            gallery.clients.map((client) => client.name ?? client.email).join(" · ")
                          )}
                        </span>

                        {/* `.row__state` + `.badge`, dashboard.html:316 / :333-349 /
                            :578.

                            TASK #75, PRESERVED AND IMPROVED. #75's point, in its own
                            words, was that a submitted gallery should read "at a
                            glance without requiring the words to be read" — and it
                            delivered that with colour alone, which never satisfied
                            it for a photographer who cannot perceive the colour or
                            who is listening to the page. So the distinction is
                            carried three ways now:
                              - `data-status` on the row (machine-readable);
                              - the ramp's own hue on the stripe, badge ink, border
                                and wash (visual, at a glance);
                              - and, for a row with pending work only, real words a
                                screen reader reads out — the state that means
                                somebody is waiting on YOU is the one whose urgency
                                the colour was carrying alone. Since epic #250/#263
                                this is `pendingWorkCount > 0`, not `status ===
                                "selected"`: work arrives in `proofing` too, and a
                                `selected` gallery with every final uploaded is
                                waiting on nobody.
                            The chrome tests assert the first and the third. They
                            deliberately no longer assert on class names. */}
                        <span className="justify-self-end [grid-area:state] lg:justify-self-start lg:[grid-area:auto]">
                          <span
                            className={cn(
                              "text-app-micro inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-[9px] pl-[7px] tracking-[0.03em] whitespace-nowrap",
                              "border-[var(--row-status)]/40 bg-[var(--row-status)]/12 text-[color:var(--row-status)]",
                              gallery.pendingWorkCount > 0 && "font-semibold",
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className="size-[5px] shrink-0 rounded-full bg-current"
                            />
                            {formatGalleryStatus(gallery.status)}
                            {gallery.pendingWorkCount > 0 && (
                              <span className="sr-only"> — esperando tu revisión</span>
                            )}
                          </span>
                        </span>

                        {/* `display: contents` at 1024px is what promotes paquete and
                            fecha into two REAL columns of the grid while they stay
                            one compact line on a phone (dashboard.html:318-320,
                            :579-582). Same elements, both widths. */}
                        <span className="text-fg-mute text-app-meta flex items-center gap-2 [grid-area:meta] lg:contents">
                          <span className="after:content-['_·'] lg:after:content-none">
                            {gallery.package.name}
                          </span>
                          <span className="tabular-nums">
                            <span className="sr-only">Sesión: </span>
                            {formatSessionDate(gallery.sessionDate)}
                          </span>
                        </span>

                        {/* The mock's `.row__n` is a bare tabular number under a
                            "Fotos" column heading (:321, :802). That heading is
                            `aria-hidden` and does not exist at all on a phone, so
                            the unit is carried here where it is always available. */}
                        <span className="text-fg-mute text-app-meta justify-self-end tabular-nums [grid-area:n] lg:[grid-area:auto]">
                          {gallery.photoCount}
                          <span className="sr-only"> fotos</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>

                {/* The pager is the mirror of the control strip: same raised
                    background and rule, on top instead of bottom. It appears
                    only past ONE page, so a 12-gallery studio never sees it.
                    Prev/next only — the acceptance criterion asks for exactly
                    that, and a numbered strip does not fit at 320px next to
                    the range line. */}
                {pageCount > 1 && (
                  <div className="border-line bg-app-raised flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-[var(--app-cell-x)] py-2.5">
                    {/* The node persists across the RSC navigation, so a page
                        change is announced once; on first load nothing is. */}
                    <p aria-live="polite" className="text-fg-dim text-app-meta tabular-nums">
                      {formatGalleryPageRange(firstRow, lastRow, counts.matching)}
                    </p>
                    <nav
                      aria-label="Paginación"
                      className="text-fg-dim text-app-meta flex items-center"
                    >
                      {query.page > 1 ? (
                        <Link
                          href={galleryListHref({ ...query, page: query.page - 1 })}
                          className="text-fg-dim hover:text-fg inline-flex min-h-[var(--app-tap)] items-center px-3 lg:min-h-9"
                        >
                          Anterior
                        </Link>
                      ) : (
                        /* A disabled state that stays a LINK for assistive
                           technology but has no href: not focusable, and it
                           cannot navigate. `<Link aria-disabled>` would still
                           navigate. */
                        <a
                          role="link"
                          aria-disabled="true"
                          className="text-fg-mute inline-flex min-h-[var(--app-tap)] items-center px-3 lg:min-h-9"
                        >
                          Anterior
                        </a>
                      )}
                      <span className="px-1 tabular-nums">
                        {formatPageOf(query.page, pageCount)}
                      </span>
                      {query.page < pageCount ? (
                        <Link
                          href={galleryListHref({ ...query, page: query.page + 1 })}
                          className="text-fg-dim hover:text-fg inline-flex min-h-[var(--app-tap)] items-center px-3 lg:min-h-9"
                        >
                          Siguiente
                        </Link>
                      ) : (
                        <a
                          role="link"
                          aria-disabled="true"
                          className="text-fg-mute inline-flex min-h-[var(--app-tap)] items-center px-3 lg:min-h-9"
                        >
                          Siguiente
                        </a>
                      )}
                    </nav>
                  </div>
                )}
              </>
            ) : query.status ? (
              /* Filter-empty, NOT studio-empty: the studio has galleries, this
                 status does not. The control strip above stays so the filter
                 can be changed, and "Quitar filtro" keeps the sort. */
              <div className="text-fg-dim text-app-body px-[var(--app-pad-card)] py-8 text-center">
                <p className="text-fg text-app-lead mb-1.5">
                  Ninguna galería en «{formatGalleryStatus(query.status)}».
                </p>
                <p className="mx-auto max-w-[46ch]">
                  Prueba con otro estado.{" "}
                  <Link
                    href={galleryListHref({ ...query, status: null, page: 1 })}
                    className="text-fg underline"
                  >
                    Quitar filtro
                  </Link>
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
