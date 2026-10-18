import Link from "next/link";
import { ActingClientSelect, type ActingClientOption } from "@/components/acting-client-select";

export type PreviewSubject = {
  id: string;
  /** The removed person's last known label, when the selection view still
   * carries it; `null` renders the anonymous "Esta persona". */
  label: string | null;
  isActive: boolean;
};

/**
 * Orientation banner for task #139 — rendered ONLY on `/galleries/
 * [publicSlug]` when the session viewing it is an admin (see
 * `isAdminPreviewingClientGallery` in src/lib/gallery-access.ts for the
 * gate this page checks before rendering it). It grants nothing and blocks
 * nothing by itself; it ORIENTS the photographer.
 *
 * Epic #250 S7 corrected what it says. Before this slice it claimed that a
 * toggle here "se guarda ... a tu nombre" (`assets.selectedBy`, task #94).
 * That is no longer true: a client PATCH writes only the named client's own
 * `asset_picks` row, and an admin write goes through `actingClientId` on
 * behalf of the selected client (decision 12). With no subject selected the
 * admin may only look.
 *
 * Three states, one sentence each (owner-approved C15-C17):
 *   - acting as an active client -> C15;
 *   - no subject (the default "Nadie (solo mirar)") -> C16;
 *   - a REMOVED member (`resolveViewAs` allows inspecting their history) ->
 *     C17, read-only because `getGalleryClients` no longer returns them.
 */
export function ClientPreviewBanner({
  dashboardHref,
  members,
  subject,
}: {
  dashboardHref: string;
  members: ActingClientOption[];
  subject: PreviewSubject | null;
}) {
  const copy =
    subject && subject.isActive ? (
      <>
        Estás viendo esto{" "}
        <strong className="text-fg font-medium">como lo ve {subject.label}</strong> — lo que toques
        aquí se pide a su nombre en el acto.
      </>
    ) : subject ? (
      <>
        <strong className="text-fg font-medium">{subject.label ?? "Esta persona"}</strong> ya no es
        parte de esta galería: solo puedes mirar.
      </>
    ) : (
      <>
        Estás viendo esto <strong className="text-fg font-medium">como lo ve el cliente</strong>.
        Elige un cliente para pedir fotos a su nombre.
      </>
    );

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
      <span>{copy}</span>
      <div className="flex items-center gap-4">
        {/* A removed subject has no option of their own in `members` (that
            query filters `removedAt IS NULL`), so the select falls back to
            "Nadie (solo mirar)" while the sentence above explains why. */}
        <ActingClientSelect members={members} value={subject?.isActive ? subject.id : null} />
        {/* Plain link — no tracked uppercase device; that treatment is
            retired. */}
        <Link
          href={dashboardHref}
          className="text-accent hover:text-accent-2 shrink-0 text-sm transition-colors"
        >
          Volver al panel
        </Link>
      </div>
    </div>
  );
}
