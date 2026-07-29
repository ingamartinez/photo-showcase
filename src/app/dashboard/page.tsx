import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { formatPendingSelectionCount, getPendingSelectionCount } from "@/lib/galleries";

export const metadata: Metadata = {
  title: "Panel",
  // Admin workspace — never indexed, never followed. Same stance as /login.
  robots: { index: false, follow: false },
};

// The guarded container. `/dashboard/clients` and `/dashboard/galleries`
// below are the real destinations for the photographer (#18 and #19).
//
// It now reads ONE thing from the database (task #75): how many galleries
// are waiting on a review, so a submission is visible the moment the
// photographer opens `/dashboard` — not only if they happen to click into
// `/dashboard/galleries` and read every row's status, and not only if the
// notification email actually arrives (task #74's logging seam makes a
// failed send auditable; this makes the underlying fact noticeable
// regardless of whether that email ever lands).
//
// Calls requireAdmin() itself, same as the layout does — see that file's
// header comment for why a page must never rely on an ancestor layout as
// its only check.
export default async function DashboardPage() {
  const session = await requireAdmin();
  const firstName = session.user.name?.split(" ")[0];
  const pendingSelectionCopy = formatPendingSelectionCount(await getPendingSelectionCount());

  return (
    <>
      <span className="label text-accent mb-4 block">Panel</span>
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {firstName ? `Hola, ${firstName}.` : "Hola."} Todavía no hay nada acá.
      </h1>
      <p className="text-fg-dim mt-5 max-w-[58ch] text-[15px] leading-relaxed">
        Este va a ser tu punto de partida: cargás un cliente, armás una galería con el paquete que
        contrató y subís las pruebas.{" "}
        {pendingSelectionCopy
          ? // Task #75's banner (below) proves the panel is NOT empty right
            // now — this clause is the one bit of copy that would otherwise
            // contradict it, so it's the only part of the sentence that
            // changes when there's something waiting.
            "El resto todavía está vacío porque el panel recién se está construyendo — clientes y galerías llegan en los próximos pasos."
          : "Por ahora está vacío porque el panel recién se está construyendo — clientes y galerías llegan en los próximos pasos."}
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
            Todavía no cargaste ningún cliente.
          </p>
        </Link>
        <Link
          href="/dashboard/galleries"
          className="border-line-2 hover:border-accent group block rounded-sm border p-6 transition-colors"
        >
          <span className="label text-fg-mute">Galerías</span>
          <p className="group-hover:text-accent-2 mt-3 font-serif text-xl transition-colors">
            Todavía no armaste ninguna galería.
          </p>
        </Link>
      </div>
    </>
  );
}
