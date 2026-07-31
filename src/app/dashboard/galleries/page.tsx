import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import {
  formatGalleryStatus,
  formatSessionDate,
  getGalleriesWithDetails,
  type GalleryWithDetails,
} from "@/lib/galleries";
import { formatPendingSelectionCount, formatStudioGalleryCount } from "@/lib/format";
import { getClientsForPicker } from "@/lib/clients";
import { getActivePackages } from "@/lib/packages";
import { DashboardGalleryCreateDialog } from "@/components/dashboard-gallery-create-dialog";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Galerías",
  // Admin workspace — never indexed, never followed. Same stance as /login
  // and /dashboard.
  robots: { index: false, follow: false },
};

// The six columns the desk shows, in the order the rows place them.
// design/system/dashboard.html:792-795.
const COLUMN_HEADINGS = ["Galería", "Clientes", "Estado", "Paquete", "Sesión", "Fotos"] as const;

// The 1024px column track, shared verbatim by the header row and every gallery
// row — one constant so the two can never drift apart.
// design/system/dashboard.html:561 and :572.
const DESK_COLUMNS =
  "lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_152px_100px_108px_56px] lg:gap-x-3.5";

/* THE STATUS RAMP — design/system/dashboard.html:82-96.
 *
 * Deliberately NOT the brand accent, with one deliberate exception: the ramp
 * answers "who is this waiting on?", and `selected` (the one state that means
 * the PHOTOGRAPHER is the blocker) is the studio's brass. That is task #75's
 * semantics carried into the table, and it is brass as a FEATURE fill — never
 * as a hover or focus wash (epic #125's rule; globals.css's
 * --color-accent-foreground comment enumerates the five legitimate brass
 * fills in the mock).
 *
 * WHY THE HEX VALUES ARE HERE AND NOT IN globals.css. They belong there, as
 * `--app-st-*` — globals.css:420-425 already reserves that exact naming for
 * "the slices that ship badges and rows", which is this one. They are not
 * there yet only because globals.css is owned by another lane this wave. When
 * those tokens land, every string below becomes `var(--app-st-<name>)` and
 * nothing else on this page changes: the row publishes ONE custom property,
 * `--row-status`, and every status-coloured thing under it (the 3px stripe,
 * the badge's ink, border and wash) reads that one property. `--row-status` is
 * NOT a design token and is deliberately not named like one — it is a local
 * per-row channel, the same role `--st` plays in the mock (:305, :337-339).
 */
const STATUS_RAMP: Record<GalleryWithDetails["status"], string> = {
  draft: "[--row-status:#63616e]",
  proofing: "[--row-status:#7e93ad]",
  selected: "[--row-status:#c8a15a]",
  delivered: "[--row-status:#7a9b82]",
  archived: "[--row-status:#4a4954]",
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
export default async function GalleriesPage() {
  await requireAdmin();
  const [galleries, clients, packages] = await Promise.all([
    getGalleriesWithDetails(),
    getClientsForPicker(),
    getActivePackages(),
  ]);

  // Both numbers are counted off the very rows rendered below — not a second
  // query, and not an estimate. `getGalleriesWithDetails()` has no limit, so
  // "23 galerías en total" is literally the length of this list, and the
  // pending tally is the subset of it whose badge says "Selección enviada".
  // Epic #125's rule from #129/#174: a counter that lies is worse than one
  // that is absent, and the only counter that cannot lie is one derived from
  // what is on the screen.
  const pendingCount = galleries.filter((gallery) => gallery.status === "selected").length;
  const pendingCopy = formatPendingSelectionCount(pendingCount);

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
          {galleries.length > 0 && (
            <p className="text-fg-dim text-app-body mt-[5px]">
              {/* The mock reads "23 en total · 2 esperando tu revisión"
                  (dashboard.html:783). The wording here comes from the shipped
                  pluralizers in @/lib/format instead of a fourth hand-rolled
                  one, so the Spanish agrees with /dashboard's own copy. */}
              {formatStudioGalleryCount(galleries.length)} en total
              {pendingCopy && ` · ${pendingCopy}`}
            </p>
          )}
        </div>
        <div className="mt-3 min-[600px]:mt-0 min-[600px]:flex-none">
          <DashboardGalleryCreateDialog clients={clients} packages={packages} />
        </div>
      </div>

      {/* `.panel`, dashboard.html:270-274. */}
      <div className="border-line bg-app-surface overflow-hidden rounded-[var(--app-radius)] border">
        {galleries.length === 0 ? (
          /* `.empty`, dashboard.html:351-354. A GENUINE empty state (epic
             #125 / task #88): reached because `getGalleriesWithDetails()`
             returned zero rows, never because the page assumed it.
             No second "Nueva galería" button here on purpose — the page head
             already has the one trigger, and two controls with the same
             accessible name pointing at the same dialog is noise in a work
             tool. */
          <div className="text-fg-dim text-app-body px-[var(--app-pad-card)] py-8 text-center">
            <p className="text-fg text-app-lead mb-1.5">Todavía no armaste ninguna galería.</p>
            <p className="mx-auto max-w-[46ch]">
              Armá la primera desde «Nueva galería» — elegí paquete, título y fecha de la sesión. El
              cliente es opcional: podés agregarlo después.
            </p>
          </div>
        ) : (
          <ul className="divide-line divide-y">
            {/* `.rowhead`, dashboard.html:293 and :559-568. The ONE element on
                this page that exists at a single width, and it is a legend for
                columns that only exist at that width — not a second copy of a
                row. `aria-hidden` because it labels nothing programmatically:
                a <ul> is not a <table>, so these headings would be read as six
                stray words. The values that are ambiguous without them carry
                their own `sr-only` unit inside each row instead. */}
            <li
              aria-hidden="true"
              className={cn(
                "text-fg-mute text-app-micro bg-app-raised hidden items-center py-[9px] pr-[var(--app-cell-x)] pl-[calc(var(--app-cell-x)+3px)] tracking-[0.06em] uppercase lg:grid",
                DESK_COLUMNS,
                "[&>:last-child]:text-right",
              )}
            >
              {COLUMN_HEADINGS.map((heading) => (
                <span key={heading}>{heading}</span>
              ))}
            </li>

            {galleries.map((gallery) => (
              <li key={gallery.id}>
                {/* The whole row is the link, at every width — `.row`,
                    dashboard.html:295-313 / :485-491 / :570-576.

                    Touch target: three stacked lines plus 12px of vertical
                    padding on a phone; `--app-row-h` (52px) is the floor on
                    the desk. Measured in this slice at 390px: 71px. At 1280px:
                    52px — over WCAG 2.2 SC 2.5.8's 24px pointer minimum, and
                    the phone value clears the 44px touch floor.

                    Hover is a 2.8% white wash (:308), NEVER brass — epic
                    #125's rule, and it cost a review round in #127/#128. */}
                <Link
                  href={`/dashboard/galleries/${gallery.id}`}
                  // The status, machine-readable. This is what the chrome
                  // tests assert on — see the note on the badge below.
                  data-status={gallery.status}
                  className={cn(
                    "hover:bg-fg/[2.8%] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] border-l-[3px] border-l-[color:var(--row-status)] px-[var(--app-cell-x)] py-3 transition-colors",
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
                        - and, for `selected` only, real words a screen reader
                          reads out — the state that means somebody is waiting
                          on YOU is the one whose urgency the colour was
                          carrying alone.
                      The chrome tests assert the first and the third. They
                      deliberately no longer assert on class names. */}
                  <span className="justify-self-end [grid-area:state] lg:justify-self-start lg:[grid-area:auto]">
                    <span
                      className={cn(
                        "text-app-micro inline-flex items-center gap-1.5 rounded-full border py-[3px] pr-[9px] pl-[7px] tracking-[0.03em] whitespace-nowrap",
                        "border-[var(--row-status)]/40 bg-[var(--row-status)]/12 text-[color:var(--row-status)]",
                        gallery.status === "selected" && "font-semibold",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="size-[5px] shrink-0 rounded-full bg-current"
                      />
                      {formatGalleryStatus(gallery.status)}
                      {gallery.status === "selected" && (
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
        )}
      </div>
    </>
  );
}
