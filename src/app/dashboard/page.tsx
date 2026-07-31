import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { getClientCount } from "@/lib/clients";
import {
  formatClientCount,
  formatPendingSelectionCount,
  formatStudioGalleryCount,
  formatTileCount,
} from "@/lib/format";
import { getGalleryCount, getPendingSelectionCount } from "@/lib/galleries";

export const metadata: Metadata = {
  title: "Panel",
  // Admin workspace — never indexed, never followed. Same stance as /login.
  robots: { index: false, follow: false },
};

// The guarded container. `/dashboard/clients` and `/dashboard/galleries`
// below are the real destinations for the photographer (#18 and #19).
//
// Task #17 wrote this shell's copy when the studio genuinely had no clients
// and no galleries. #18 and #19 then built both, and #75 added the
// pending-selection banner — but until task #88, this page still read
// exactly ONE thing from the database (`getPendingSelectionCount`) and
// hardcoded the rest, including "Todavía no hay nada acá." That lied the
// moment the first client and gallery existed: it now reads all three
// counts, so the genuine empty state below is reached by queries returning
// zero, never by a constant.
//
// Task #130 rebuilt this page's OWN markup for the app surface (epic #125):
// the editorial serif display headline and mono eyebrow are gone, replaced
// by the mock's overview hierarchy (design/system/dashboard.html:660-731,
// its `#screen-panel`/`#screen-panel-vacio`) — a small "Hola, {name}" line,
// a demoted sans title, the pending-selection state as the loudest element
// on the screen (it is the only thing that means someone is blocked on the
// photographer), and the client/gallery/pending counts as compact stat
// tiles below it. None of the three reads above changed — this was a
// hierarchy rewrite, not a data rewrite.
//
// Review round 1 caught a real defect in the first pass: the tiles called
// `formatClientCount`/`formatStudioGalleryCount` (full Spanish sentences,
// "14 clientes") for their OWN number line except at zero, where they fell
// back to a literal `"0"` — three tiles in the same grid row each showing a
// differently-shaped value. `formatTileCount` (`@/lib/format`) now supplies
// a bare, locale-grouped digit for every tile in every state, matching
// `design/system/dashboard.html:655-669`'s uniform eyebrow + bare `.stat__n`
// digit. The sentence formatters stay in use for the PROSE line above the
// tiles ("Tenés 14 clientes y 23 galerías en marcha.") — that sentence needs
// the noun; the tile does not, because its eyebrow already carries it.
//
// Calls requireAdmin() itself, same as the layout does — see that file's
// header comment for why a page must never rely on an ancestor layout as
// its only check.
export default async function DashboardPage() {
  const session = await requireAdmin();
  const firstName = session.user.name?.split(" ")[0];
  const [pendingSelectionCount, clientCount, galleryCount] = await Promise.all([
    getPendingSelectionCount(),
    getClientCount(),
    getGalleryCount(),
  ]);
  const pendingSelectionCopy = formatPendingSelectionCount(pendingSelectionCount);
  // The genuine first-run empty state — reached because BOTH counts came
  // back zero, not because the page assumes it.
  const isEmpty = clientCount === 0 && galleryCount === 0;

  return (
    <>
      {/* Page head: the greeting is demoted, not deleted (task #130's trap) —
          a small muted line above a title that is no longer the serif
          display headline this page used to open with. Mirrors
          `.page-head__hello` + `.page-head__title` + `.page-head__sub`,
          dashboard.html:662-667 and :735-743. */}
      <div className="mb-[var(--app-gap)]">
        <p className="text-fg-mute text-[length:var(--app-text-body)]">
          {firstName ? `Hola, ${firstName}` : "Hola"}
        </p>
        <h1 className="text-fg mt-[3px] max-w-[24ch] text-[length:var(--app-text-title)] leading-tight font-medium tracking-[-0.015em] text-balance">
          {isEmpty ? "Todavía no hay nada acá." : "Así está tu estudio."}
        </h1>
        <p className="text-fg-dim mt-[5px] max-w-[46ch] text-[length:var(--app-text-body)]">
          {isEmpty
            ? "Este va a ser tu punto de partida: cargás un cliente, armás una galería con el paquete que contrató y subís las pruebas."
            : `Tenés ${formatClientCount(clientCount)} y ${formatStudioGalleryCount(galleryCount)} en marcha.`}
        </p>
      </div>

      {/* The loudest element on the screen, on purpose — it is the only
          state here that means someone is blocked on the photographer.
          Mirrors `.alert`, dashboard.html:669-675, :239-256: a warm brass
          wash (the ONE place on this page brass is a fill, not a hover —
          epic #125's rule at dashboard.html:82-91), the whole card one
          link, and a primary "Ver" pill that is a `<span>` (not a nested
          `<button>`/`<a>`) so the card stays a single accessible target,
          same shape the mock itself uses. */}
      {pendingSelectionCopy && (
        <Link
          href="/dashboard/galleries"
          className="border-accent/40 bg-accent/10 hover:bg-accent/15 mb-[var(--app-gap)] grid gap-3 rounded-[var(--app-radius)] border p-[var(--app-pad-card)] transition-colors sm:grid-cols-[1fr_auto] sm:items-center"
        >
          <span>
            <span className="text-accent-2 flex items-center gap-2 text-[length:var(--app-text-lead)]">
              <span aria-hidden="true" className="bg-accent size-2 shrink-0 rounded-full" />
              Esperando tu revisión
            </span>
            <p className="text-fg-dim mt-1 text-[length:var(--app-text-body)]">
              {pendingSelectionCopy}
            </p>
          </span>
          <span className="bg-accent inline-flex min-h-[var(--app-tap)] items-center justify-center rounded-[var(--app-radius-sm)] px-4 font-semibold text-[#14100A] sm:min-h-0 sm:py-2">
            Ver
          </span>
        </Link>
      )}

      {/* Compact stat tiles, replacing the two full-row link cards this page
          used to spend on a single number each. Mirrors `.stats`,
          dashboard.html:677-693, :745-761: three equal columns even at
          phone width, EVERY tile's value a bare `formatTileCount()` digit
          (see this file's header comment for the review-round-1 fix this
          was) — the zero case adds an explanatory note sentence below the
          digit, exactly the copy `page.chrome.test.tsx` asserts on (task
          #88); it does not replace the digit with a sentence. */}
      <div className="grid grid-cols-3 gap-2">
        <Link
          href="/dashboard/clients"
          className="border-line hover:border-line-2 block rounded-[var(--app-radius)] border bg-[var(--app-surface)] p-3 transition-colors"
        >
          <span className="text-fg-mute block text-[length:var(--app-text-micro)] tracking-[0.06em] uppercase">
            Clientes
          </span>
          <p className="text-fg mt-1.5 text-[length:var(--app-text-lead)] leading-tight font-medium tabular-nums">
            {formatTileCount(clientCount)}
          </p>
          {clientCount === 0 && (
            <p className="text-fg-mute mt-1 text-[length:var(--app-text-meta)]">
              Todavía no cargaste ningún cliente.
            </p>
          )}
        </Link>
        <Link
          href="/dashboard/galleries"
          className="border-line hover:border-line-2 block rounded-[var(--app-radius)] border bg-[var(--app-surface)] p-3 transition-colors"
        >
          <span className="text-fg-mute block text-[length:var(--app-text-micro)] tracking-[0.06em] uppercase">
            Galerías
          </span>
          <p className="text-fg mt-1.5 text-[length:var(--app-text-lead)] leading-tight font-medium tabular-nums">
            {formatTileCount(galleryCount)}
          </p>
          {galleryCount === 0 && (
            <p className="text-fg-mute mt-1 text-[length:var(--app-text-meta)]">
              Todavía no armaste ninguna galería.
            </p>
          )}
        </Link>
        <Link
          href="/dashboard/galleries"
          className="border-line hover:border-line-2 block rounded-[var(--app-radius)] border bg-[var(--app-surface)] p-3 transition-colors"
        >
          <span className="text-fg-mute block text-[length:var(--app-text-micro)] tracking-[0.06em] uppercase">
            Esperan
          </span>
          <p className="text-fg mt-1.5 text-[length:var(--app-text-lead)] leading-tight font-medium tabular-nums">
            {formatTileCount(pendingSelectionCount)}
          </p>
        </Link>
      </div>
    </>
  );
}
