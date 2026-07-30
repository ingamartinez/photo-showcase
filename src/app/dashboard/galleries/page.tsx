import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { formatGalleryStatus, formatSessionDate, getGalleriesWithDetails } from "@/lib/galleries";
import { getClientsForPicker } from "@/lib/clients";
import { getActivePackages } from "@/lib/packages";
import { GalleryForm } from "@/components/gallery-form";

export const metadata: Metadata = {
  title: "Galerías",
  // Admin workspace — never indexed, never followed. Same stance as /login
  // and /dashboard.
  robots: { index: false, follow: false },
};

// Calls requireAdmin() itself, same as every other page under /dashboard —
// see src/lib/auth-guards.ts's header comment for why a page must never rely
// on an ancestor layout as its only check.
export default async function GalleriesPage() {
  await requireAdmin();
  const [galleries, clients, packages] = await Promise.all([
    getGalleriesWithDetails(),
    getClientsForPicker(),
    getActivePackages(),
  ]);

  return (
    <>
      <span className="label text-accent mb-4 block">Galerías</span>
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {galleries.length === 0 ? "Todavía no armaste ninguna galería." : "Tus galerías."}
      </h1>

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_360px]">
        <ul className="border-line-2 divide-line-2 divide-y rounded-sm border">
          {galleries.length === 0 ? (
            <li className="text-fg-dim p-6 text-[15px] leading-relaxed">
              Armá la primera galería con el formulario — elegí paquete, título y fecha de la
              sesión. El cliente es opcional: podés agregarlo después.
            </li>
          ) : (
            galleries.map((gallery) => (
              <li key={gallery.id}>
                <Link
                  href={`/dashboard/galleries/${gallery.id}`}
                  className="hover:bg-line-2/20 flex flex-wrap items-center justify-between gap-3 p-6 transition-colors"
                >
                  <div>
                    <p className="font-serif text-lg">{gallery.title}</p>
                    <p className="text-fg-mute text-sm">
                      {/* Task #94: a gallery can have several clients now —
                          joined with " · " so the list still fits on one
                          line without truncating anyone.

                          Task #100: ZERO clients is a legitimate state for a
                          draft, so it gets its own words. Joining an empty
                          list would render " · Estándar" — a leading
                          separator floating over nothing, which reads as
                          missing data rather than as a deliberate state. */}
                      {gallery.clients.length === 0
                        ? "Todavía sin cliente"
                        : gallery.clients.map((client) => client.name ?? client.email).join(" · ")}
                      {" · "}
                      {gallery.package.name}
                    </p>
                    <p className="text-fg-mute text-sm">
                      Sesión: {formatSessionDate(gallery.sessionDate)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {/* `selected` is the one status that means "somebody is
                    waiting on you" (task #75) — every other status gets the
                    same muted `text-fg-mute` treatment as before, but this
                    one gets the studio's single accent colour (see
                    globals.css's header comment: "a single tungsten-brass
                    accent used sparingly") plus a dot, so it reads at a
                    glance without requiring the words to be read. */}
                    <span
                      className={
                        gallery.status === "selected"
                          ? "label text-accent flex items-center gap-1.5 font-semibold"
                          : "label text-fg-mute"
                      }
                    >
                      {gallery.status === "selected" && (
                        <span
                          className="bg-accent inline-block size-1.5 rounded-full"
                          aria-hidden="true"
                        />
                      )}
                      {formatGalleryStatus(gallery.status)}
                    </span>
                    <span className="text-fg-mute text-sm">{gallery.photoCount} fotos</span>
                  </div>
                </Link>
              </li>
            ))
          )}
        </ul>

        {/* Task #100: the form renders even with ZERO clients in the studio.
            This page used to replace it with "Cargá un cliente antes de armar
            una galería" — the exact ordering the owner asked to reverse: the
            shoot happens, the files come off the card, and the client record
            may not exist yet. <GalleryForm> renders that guidance (plus the
            link to /dashboard/clients) inside the client field itself, where
            it belongs, instead of blocking the whole form. */}
        <GalleryForm clients={clients} packages={packages} />
      </div>
    </>
  );
}
