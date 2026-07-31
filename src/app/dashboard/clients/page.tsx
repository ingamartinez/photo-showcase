import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth-guards";
import { getClientsWithGalleryCount } from "@/lib/clients";
import { formatClientGalleryCount } from "@/lib/format";
import { ClientForm } from "@/components/client-form";

export const metadata: Metadata = {
  title: "Clientes",
  // Admin workspace — never indexed, never followed. Same stance as /login
  // and /dashboard.
  robots: { index: false, follow: false },
};

// Calls requireAdmin() itself, same as every other page under /dashboard —
// see src/lib/auth-guards.ts's header comment for why a page must never rely
// on an ancestor layout as its only check.
export default async function ClientsPage() {
  await requireAdmin();
  const clients = await getClientsWithGalleryCount();

  return (
    <>
      <span className="label text-accent mb-4 block">Clientes</span>
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {clients.length === 0 ? "Todavía no cargaste ningún cliente." : "Con quién trabajaste."}
      </h1>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_360px]">
        <ul className="border-line-2 divide-line-2 divide-y rounded-sm border">
          {clients.length === 0 ? (
            <li className="text-fg-dim p-6 text-[15px] leading-relaxed">
              Cargá el primer cliente con el formulario — nombre, correo y, si querés, el WhatsApp.
            </li>
          ) : (
            clients.map((client) => (
              <li key={client.id} className="flex flex-wrap items-center justify-between gap-3 p-6">
                <div>
                  <p className="font-serif text-lg">{client.name ?? client.email}</p>
                  <p className="text-fg-mute text-sm">{client.email}</p>
                  {client.phone && <p className="text-fg-mute text-sm">{client.phone}</p>}
                </div>
                <span className="label text-fg-mute">
                  {formatClientGalleryCount(client.galleryCount)}
                </span>
              </li>
            ))
          )}
        </ul>
        <ClientForm />
      </div>
    </>
  );
}
