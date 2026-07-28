import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guards";
import {
  formatCop,
  formatGalleryStatus,
  formatSessionDate,
  getGalleryDetail,
} from "@/lib/galleries";
import { getPresignedUrl } from "@/lib/r2";
import { GalleryWorkspace } from "@/components/gallery-workspace";

export const metadata: Metadata = {
  title: "Galería",
  // Admin workspace — never indexed, never followed. Same stance as every
  // other page under /dashboard.
  robots: { index: false, follow: false },
};

const galleryIdSchema = z.uuid();

// Calls requireAdmin() itself, same as every other page under /dashboard —
// see src/lib/auth-guards.ts's header comment for why a page must never rely
// on an ancestor layout as its only check.
export default async function GalleryDetailPage({
  params,
}: {
  params: Promise<{ galleryId: string }>;
}) {
  await requireAdmin();

  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) notFound();

  const gallery = await getGalleryDetail(galleryIdResult.data);
  if (!gallery) notFound();

  // Presigned URLs are generated here, at render time, for the INITIAL
  // paint only — `getPresignedUrl` is a local HMAC signature, not an R2
  // round trip, so doing this once per asset on every page load is cheap.
  // They are good for `PRESIGNED_URL_TTL_SECONDS` (5 minutes; src/lib/r2.ts)
  // from this instant. A photographer who leaves this page open longer than
  // that (uploading ~100 photos is not a 5-minute job) would otherwise see
  // thumbnails start 403ing partway through the session — <GalleryWorkspace>
  // is a client component that refreshes a URL on demand (its <img>
  // `onError` handler re-fetches from `/api/assets/[assetId]/proof`) rather
  // than polling all of them on a timer, so a long-open tab stays correct
  // without hammering the read route for assets nobody has scrolled past.
  const selectedCount = gallery.assets.filter((asset) => asset.isSelected).length;
  const initialAssets = gallery.assets.map((asset) => ({
    id: asset.id,
    originalFilename: asset.originalFilename,
    proofWidth: asset.proofWidth,
    proofHeight: asset.proofHeight,
    isSelected: asset.isSelected,
    sortOrder: asset.sortOrder,
    proofUrl: getPresignedUrl(asset.proofKey),
  }));

  return (
    <>
      <Link
        href="/dashboard/galleries"
        className="label text-fg-dim hover:text-accent-2 mb-6 inline-block transition-colors"
      >
        ← Galerías
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <span className="label text-accent mb-2 block">
            {formatGalleryStatus(gallery.status)}
          </span>
          <h1 className="max-w-[24ch] font-serif text-[clamp(28px,4vw,44px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
            {gallery.title}
          </h1>
          <p className="text-fg-mute mt-2 text-sm">
            {gallery.client.name ?? gallery.client.email} · {gallery.client.email}
          </p>
          <p className="text-fg-mute text-sm">Sesión: {formatSessionDate(gallery.sessionDate)}</p>
        </div>

        <dl className="border-line-2 grid grid-cols-2 gap-x-8 gap-y-2 rounded-sm border p-6 text-sm">
          <dt className="text-fg-mute">Paquete</dt>
          <dd>{gallery.package.name}</dd>
          <dt className="text-fg-mute">Fotos incluidas</dt>
          <dd>{gallery.includedPhotosSnapshot}</dd>
          <dt className="text-fg-mute">Foto extra</dt>
          <dd>{formatCop(gallery.extraPhotoPriceCopSnapshot)}</dd>
          <dt className="text-fg-mute">Fotos subidas</dt>
          <dd>{gallery.assets.length}</dd>
          <dt className="text-fg-mute">Seleccionadas</dt>
          <dd>{selectedCount}</dd>
        </dl>
      </div>

      <div className="mt-12">
        <GalleryWorkspace galleryId={gallery.id} initialAssets={initialAssets} />
      </div>
    </>
  );
}
