import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { getFlashGalleriesWithDetails } from "@/lib/flash";
import { formatSessionDate } from "@/lib/galleries";
import { FlashGalleryCreateForm } from "@/components/flash-gallery-create-form";

export const metadata: Metadata = {
  title: "Galerías flash",
  robots: { index: false, follow: false },
};

// Calls requireAdmin() itself, like every page under /dashboard.
export default async function FlashGalleriesPage() {
  await requireAdmin();
  const flashGalleries = await getFlashGalleriesWithDetails();

  return (
    <>
      <div className="mb-4">
        <h1 className="text-fg text-app-title font-medium tracking-[-0.015em] text-balance">
          Galerías flash
        </h1>
        <p className="text-fg-dim text-app-body mt-[5px]">
          Fotos para regalar: finales tal cual, sin selección ni precio. Compártelas con un enlace o
          asígnalas a tus clientes.
        </p>
        <p className="mt-2">
          <Link href="/dashboard/galleries" className="text-fg-dim text-app-body underline">
            Volver a galerías
          </Link>
        </p>
      </div>

      <div className="border-line bg-app-surface mb-4 rounded-[var(--app-radius)] border p-[var(--app-pad-card)]">
        <FlashGalleryCreateForm />
      </div>

      <div className="border-line bg-app-surface overflow-hidden rounded-[var(--app-radius)] border">
        {flashGalleries.length === 0 ? (
          <p className="text-fg-dim text-app-body px-[var(--app-pad-card)] py-8 text-center">
            Todavía no hay galerías flash.
          </p>
        ) : (
          <ul className="divide-line divide-y">
            {flashGalleries.map((flash) => (
              <li key={flash.id}>
                <Link
                  href={`/dashboard/flash/${flash.id}`}
                  className="hover:bg-fg/[2.8%] flex flex-col gap-1 px-[var(--app-cell-x)] py-3 transition-colors min-[600px]:flex-row min-[600px]:items-center min-[600px]:justify-between"
                >
                  <span className="text-app-base">{flash.title}</span>
                  <span className="text-fg-mute text-app-meta flex flex-wrap gap-x-3">
                    <span>{flash.isPublic ? "Pública" : "Privada"}</span>
                    <span>
                      {flash.clients.length === 0
                        ? "Sin clientes"
                        : `${flash.clients.length} cliente${flash.clients.length === 1 ? "" : "s"}`}
                    </span>
                    {flash.sessionDate && <span>{formatSessionDate(flash.sessionDate)}</span>}
                    <span className="tabular-nums">
                      {flash.photoCount} foto{flash.photoCount === 1 ? "" : "s"}
                    </span>
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
