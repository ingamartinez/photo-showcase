import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth-guards";
import { getClientsWithGalleryCount } from "@/lib/clients";
import { formatClientCount, formatClientGalleryCount } from "@/lib/format";
import { DashboardClientCreateDialog } from "@/components/dashboard-client-create-dialog";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Clientes",
  // Admin workspace — never indexed, never followed. Same stance as /login
  // and /dashboard.
  robots: { index: false, follow: false },
};

// The four columns the desk shows, in the order the rows place them.
// design/system/dashboard.html:872.
const COLUMN_HEADINGS = ["Cliente", "Correo", "Teléfono", "Galerías"] as const;

// The 1024px column track, shared verbatim by the header row and every client
// row — design/system/dashboard.html:585-586. Four columns, no status column:
// epic #125's own body states the reason plainly — "Sin franja de estado: un
// cliente no tiene estado." — so there is no fifth track and no `--row-status`
// channel here, unlike the galleries table this file otherwise mirrors.
const DESK_COLUMNS = "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_150px_70px] lg:gap-3.5";

// Calls requireAdmin() itself, same as every other page under /dashboard —
// see src/lib/auth-guards.ts's header comment for why a page must never rely
// on an ancestor layout as its only check.
//
// ---------------------------------------------------------------------------
// TASK #132 — same markup shape as #131's galleries table
// (src/app/dashboard/galleries/page.tsx): a <ul> of <li>, not a <table>,
// mobile-first with `min-[600px]:` and `lg:` breakpoints that only ADD. Read
// that file's header comment for the full mechanism; this one only notes
// where clients DIFFER from galleries:
//
//   - no status stripe / badge — a client has no state (epic #125's own rule);
//   - the row is a plain `<li>`, not a `<Link>` — a client row is not a link
//     today, because there is no client detail page (this task's own trap);
//   - `row__meta` (teléfono) wraps exactly ONE nullable field, not two, so
//     there is no `display: contents` split — the field itself is the desk's
//     third grid column, present-or-empty, never re-flowing the column count
//     (see the phone cell's own comment below for why that matters).
// ---------------------------------------------------------------------------
export default async function ClientsPage() {
  await requireAdmin();
  const clients = await getClientsWithGalleryCount();

  return (
    <>
      {/* Page head: same shape as galleries/page.tsx — the title stacked over
          the action on a phone, side by side from 600px. The editorial
          `clamp(30px,4.5vw,52px)` serif display headline and the `.label`
          mono eyebrow this page used to open with are gone; that is the
          defect epic #125 exists to fix, not a detail. */}
      <div className="mb-4 min-[600px]:flex min-[600px]:items-end min-[600px]:justify-between min-[600px]:gap-4">
        <div>
          <h1 className="text-fg text-app-title font-medium tracking-[-0.015em] text-balance">
            Clientes
          </h1>
          {/* Suppressed at zero rather than reading "0 clientes en total": the
              panel's own empty state below says it in words. */}
          {clients.length > 0 && (
            <p className="text-fg-dim text-app-body mt-[5px]">
              {/* Counted off the very rows rendered below, not a second
                  query — same rule galleries' own header comment states for
                  its "en total" line. There is no second, "pending" count
                  here: a client has no state to be pending in. */}
              {formatClientCount(clients.length)} en total
            </p>
          )}
        </div>
        <div className="mt-3 min-[600px]:mt-0 min-[600px]:flex-none">
          <DashboardClientCreateDialog />
        </div>
      </div>

      {/* `.panel`, dashboard.html:869. */}
      <div className="border-line bg-app-surface overflow-hidden rounded-[var(--app-radius)] border">
        {clients.length === 0 ? (
          /* A GENUINE empty state (epic #125 / task #88): reached because
             `getClientsWithGalleryCount()` returned zero rows, never because
             the page assumed it. No second "Nuevo cliente" button here on
             purpose — the page head already has the one trigger. */
          <div className="text-fg-dim text-app-body px-[var(--app-pad-card)] py-8 text-center">
            <p className="text-fg text-app-lead mb-1.5">Todavía no cargaste ningún cliente.</p>
            <p className="mx-auto max-w-[46ch]">
              Cargá el primero desde «Nuevo cliente» — nombre, correo y, si querés, el WhatsApp.
            </p>
          </div>
        ) : (
          <ul className="divide-line divide-y">
            {/* `.rowhead`, dashboard.html:871. The ONE element on this page
                that exists at a single width, and it is a legend for columns
                that only exist at that width — not a second copy of a row.
                `aria-hidden` because it labels nothing programmatically: a
                <ul> is not a <table>, so these headings would be read as four
                stray words. The value that is ambiguous without it (teléfono)
                carries its own `sr-only` unit inside its own cell instead. */}
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

            {clients.map((client) => (
              <li
                key={client.id}
                data-client-id={client.id}
                // No `<Link>` here — this task's own trap. A client row is
                // not a link today: there is no client detail page, and this
                // slice does not invent one. If the table ever wants row
                // actions, they are actions, not navigation to a route that
                // does not exist.
                //
                // Touch target: three stacked lines plus 12px of vertical
                // padding on a phone; `--app-row-h` (52px) is the floor on the
                // desk — MEASURED in Chromium against the built stylesheet
                // (see this task's own report). Hover is the same 2.8% white
                // wash galleries uses (`.row:hover`, dashboard.html:308),
                // purely a readability aid: there is no click target here to
                // signal, so no `cursor-pointer` and no interactive role ride
                // along with it.
                className={cn(
                  "hover:bg-fg/[2.8%] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] border-l-[3px] border-l-transparent px-[var(--app-cell-x)] py-3 transition-colors",
                  "[grid-template-areas:'title_n''who_who''meta_meta']",
                  "min-[600px]:grid-cols-[minmax(0,1fr)_auto_auto] min-[600px]:gap-x-3.5 min-[600px]:gap-y-1 min-[600px]:[grid-template-areas:'title_n_n''who_meta_meta']",
                  "lg:min-h-[var(--app-row-h)] lg:py-0 lg:[grid-template-areas:none]",
                  DESK_COLUMNS,
                )}
              >
                {/* Task #132's own preserved rule (page.tsx used to be
                    line 38): a client can exist with an email and no name —
                    `users.name` is nullable for a row created by the
                    magic-link flow rather than this dialog. */}
                <span className="text-app-base lg:text-app-body [grid-area:title] lg:[grid-area:auto]">
                  {client.name ?? client.email}
                </span>

                <span className="text-fg-dim text-app-body [grid-area:who] lg:[grid-area:auto]">
                  {client.email}
                </span>

                {/* Task #132's other preserved rule (page.tsx used to be
                    line 40): the phone renders ONLY when present — a
                    nullable field, not an empty row, so a client with no
                    WhatsApp on file shows nothing here, not a placeholder
                    dash. The wrapping <span> itself is unconditional, though:
                    at >=1024px `.row > * { grid-area: auto }` auto-places
                    children in DOM order, so an element that sometimes does
                    not exist at all would shift every column after it one
                    slot to the left on the rows missing a phone. Rendering
                    the span always and only its TEXT conditionally keeps the
                    column count constant while keeping the visible content
                    exactly as before. */}
                <span className="text-fg-mute text-app-meta tabular-nums [grid-area:meta] lg:[grid-area:auto]">
                  {client.phone && (
                    <>
                      <span className="sr-only">Teléfono: </span>
                      {client.phone}
                    </>
                  )}
                </span>

                <span className="text-fg-mute text-app-meta justify-self-end tabular-nums [grid-area:n] lg:[grid-area:auto]">
                  {formatClientGalleryCount(client.galleryCount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
