import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guards";
import { getClientsForPicker } from "@/lib/clients";
import { flashGalleryPath, getFlashGalleryDetail } from "@/lib/flash";
import { formatSessionDate } from "@/lib/galleries";
import { flashDisplayKey, getPresignedUrl } from "@/lib/r2";
import { FlashGalleryControls } from "@/components/flash-gallery-controls";
import { EditFlashGalleryMetaDialog } from "@/components/edit-flash-gallery-meta-dialog";
import { FlashUploader } from "@/components/flash-uploader";
import { FlashClientsPanel } from "@/components/flash-clients-panel";
import { FlashPhotoGrid } from "@/components/flash-photo-grid";

export const metadata: Metadata = {
  title: "Galería flash",
  robots: { index: false, follow: false },
};

const flashIdSchema = z.uuid();

// Calls requireAdmin() itself, like every page under /dashboard. The grid's
// image URLs are short-lived presigned URLs minted here, AFTER that check —
// the server never streams image bytes.
export default async function FlashGalleryDetailPage({
  params,
}: {
  params: Promise<{ flashId: string }>;
}) {
  await requireAdmin();

  const { flashId } = await params;
  if (!flashIdSchema.safeParse(flashId).success) notFound();

  const [flash, allClients] = await Promise.all([
    getFlashGalleryDetail(flashId),
    getClientsForPicker(),
  ]);
  if (!flash) notFound();

  const assignedIds = new Set(flash.clients.map((client) => client.id));
  const eligibleClients = allClients.filter((client) => !assignedIds.has(client.id));

  const photos = flash.assets.map((asset) => ({
    id: asset.id,
    originalFilename: asset.originalFilename,
    url: getPresignedUrl(flashDisplayKey(flash.id, asset.id)),
    width: asset.displayWidth,
    height: asset.displayHeight,
  }));

  return (
    <>
      <div className="mb-4">
        <Link href="/dashboard/flash" className="text-fg-dim text-app-body underline">
          Galerías flash
        </Link>
        <h1 className="text-fg text-app-title mt-2 font-medium tracking-[-0.015em] text-balance">
          {flash.title}
        </h1>
        {flash.sessionDate && (
          <p className="text-fg-dim text-app-body mt-[5px]">
            {formatSessionDate(flash.sessionDate)}
          </p>
        )}
        <div className="mt-2">
          <EditFlashGalleryMetaDialog
            flashGalleryId={flash.id}
            title={flash.title}
            sessionDate={flash.sessionDate}
          />
        </div>
      </div>

      <section
        aria-labelledby="flash-share"
        className="border-line bg-app-surface mb-4 rounded-[var(--app-radius)] border p-[var(--app-pad-card)]"
      >
        <h2 id="flash-share" className="text-app-lead mb-3 font-medium">
          Compartir
        </h2>
        <FlashGalleryControls
          flashGalleryId={flash.id}
          publicPath={flashGalleryPath(flash.publicSlug)}
          initialIsPublic={flash.isPublic}
        />
      </section>

      <section
        aria-labelledby="flash-clients"
        className="border-line bg-app-surface mb-4 rounded-[var(--app-radius)] border p-[var(--app-pad-card)]"
      >
        <h2 id="flash-clients" className="text-app-lead mb-3 font-medium">
          Clientes
        </h2>
        <FlashClientsPanel
          flashGalleryId={flash.id}
          assignedClients={flash.clients}
          eligibleClients={eligibleClients}
        />
      </section>

      <section
        aria-labelledby="flash-photos"
        className="border-line bg-app-surface rounded-[var(--app-radius)] border p-[var(--app-pad-card)]"
      >
        <h2 id="flash-photos" className="text-app-lead mb-3 font-medium">
          Fotos ({photos.length})
        </h2>
        <div className="mb-4">
          <FlashUploader flashGalleryId={flash.id} />
        </div>
        <FlashPhotoGrid photos={photos} />
      </section>
    </>
  );
}
