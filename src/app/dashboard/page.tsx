import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { formatClientCount, getClientCount } from "@/lib/clients";
import {
  formatGalleryCountTotal,
  formatPendingSelectionCount,
  getGalleryCount,
  getPendingSelectionCount,
} from "@/lib/galleries";

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
      <span className="label text-accent mb-4 block">Panel</span>
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {firstName ? `Hola, ${firstName}.` : "Hola."}{" "}
        {isEmpty ? "Todavía no hay nada acá." : "Así está tu estudio."}
      </h1>
      <p className="text-fg-dim mt-5 max-w-[58ch] text-[15px] leading-relaxed">
        {isEmpty
          ? "Este va a ser tu punto de partida: cargás un cliente, armás una galería con el paquete que contrató y subís las pruebas."
          : `Tenés ${formatClientCount(clientCount)} y ${formatGalleryCountTotal(galleryCount)} en marcha.`}
      </p>
      {pendingSelectionCopy && (
        <Link
          href="/dashboard/galleries"
          className="border-accent bg-accent/10 hover:bg-accent/15 mt-10 block rounded-sm border p-6 transition-colors"
        >
          <span className="label text-accent">Esperando tu revisión</span>
          <p className="text-accent mt-3 font-serif text-xl">{pendingSelectionCopy}</p>
        </Link>
      )}
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <Link
          href="/dashboard/clients"
          className="border-line-2 hover:border-accent group block rounded-sm border p-6 transition-colors"
        >
          <span className="label text-fg-mute">Clientes</span>
          <p className="group-hover:text-accent-2 mt-3 font-serif text-xl transition-colors">
            {clientCount === 0
              ? "Todavía no cargaste ningún cliente."
              : formatClientCount(clientCount)}
          </p>
        </Link>
        <Link
          href="/dashboard/galleries"
          className="border-line-2 hover:border-accent group block rounded-sm border p-6 transition-colors"
        >
          <span className="label text-fg-mute">Galerías</span>
          <p className="group-hover:text-accent-2 mt-3 font-serif text-xl transition-colors">
            {galleryCount === 0
              ? "Todavía no armaste ninguna galería."
              : formatGalleryCountTotal(galleryCount)}
          </p>
        </Link>
      </div>
    </>
  );
}
