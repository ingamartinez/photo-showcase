import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";

export const metadata: Metadata = {
  title: "Panel",
  // Admin workspace — never indexed, never followed. Same stance as /login.
  robots: { index: false, follow: false },
};

// This slice's whole job: the guarded container, nothing that reads the
// database. `/dashboard/clients` and `/dashboard/galleries` below are real
// destinations for the photographer, filled in by #18 and #19 — until then
// they 404, which is expected for a container shipped ahead of its content.
//
// Calls requireAdmin() itself, same as the layout does — see that file's
// header comment for why a page must never rely on an ancestor layout as
// its only check.
export default async function DashboardPage() {
  const session = await requireAdmin();
  const firstName = session.user.name?.split(" ")[0];

  return (
    <>
      <span className="label text-accent mb-4 block">Panel</span>
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {firstName ? `Hola, ${firstName}.` : "Hola."} Todavía no hay nada acá.
      </h1>
      <p className="text-fg-dim mt-5 max-w-[58ch] text-[15px] leading-relaxed">
        Este va a ser tu punto de partida: cargás un cliente, armás una galería con el paquete que
        contrató y subís las pruebas. Por ahora está vacío porque el panel recién se está
        construyendo — clientes y galerías llegan en los próximos pasos.
      </p>
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
