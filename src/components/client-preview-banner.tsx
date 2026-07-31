import Link from "next/link";

/**
 * Orientation banner for task #139 — rendered ONLY on `/galleries/
 * [publicSlug]` when the session viewing it is an admin (see
 * `isAdminPreviewingClientGallery` in src/lib/gallery-access.ts for the
 * gate this page checks before rendering it). Purely informational: it
 * grants nothing and blocks nothing.
 *
 * Its one job is to stop the confusion task #139's own trap note names —
 * "no convertir esto en modo impersonación": an admin here is not acting AS
 * the client, they are looking at what the client looks at. The permission
 * model underneath is unchanged (task #66, closed 2026-07-30): a toggle an
 * admin taps on this page still writes to the real client's selection,
 * attributed to this admin session (`assets.selectedBy`, task #94) — this
 * banner exists so that write is never a surprise.
 */
export function ClientPreviewBanner({ dashboardHref }: { dashboardHref: string }) {
  return (
    // No `role="status"` here on purpose: this is static orientation copy
    // present for the whole time the page is open, not a live-region
    // announcement — and this page's own submit-selection panel already
    // owns `role="status"` for a `selected` gallery's "ya no se puede
    // modificar" message (submit-selection-panel.tsx). Giving both the same
    // role would make `getByRole("status")` ambiguous the moment an admin
    // previews a gallery in that status — caught by mutation-testing this
    // exact banner (see this task's own report).
    <div className="border-line-2 bg-bg-2 text-fg-mute mb-8 flex flex-wrap items-center justify-between gap-3 rounded-sm border px-4 py-3 text-sm">
      <span>
        Estás viendo esto <strong className="text-fg font-medium">como lo ve el cliente</strong> —
        lo que toques acá se guarda como si lo hubiera tocado el cliente.
      </span>
      <Link
        href={dashboardHref}
        className="label text-accent hover:text-accent-2 shrink-0 transition-colors"
      >
        Volver al panel
      </Link>
    </div>
  );
}
