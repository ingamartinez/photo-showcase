import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatSessionDate } from "@/lib/galleries";
import {
  getFirstFlashAsset,
  listFlashAssets,
  resolveFlashGallery,
  resolvePublicFlashGallery,
} from "@/lib/flash-access";
import { FlashGalleryViewer } from "@/components/flash-gallery-viewer";
import { buildFlashMetadata } from "@/lib/flash-meta";

// Link-preview metadata. Reads through `resolvePublicFlashGallery`, so a
// private gallery gets NOTHING but `noindex` (generic site OG) — its title and
// image never reach the head of a page a stranger can request.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicSlug: string }>;
}): Promise<Metadata> {
  const { publicSlug } = await params;
  const gallery = await resolvePublicFlashGallery(publicSlug);
  const first = gallery ? await getFirstFlashAsset(gallery.id) : null;
  return buildFlashMetadata(gallery, first);
}

// Public by design when `isPublic` (no login, never linked from the site);
// otherwise only an actively assigned client or an admin. A denied viewer and a
// missing gallery both end in the same 404.
export default async function FlashGalleryPage({
  params,
}: {
  params: Promise<{ publicSlug: string }>;
}) {
  const { publicSlug } = await params;
  const gallery = await resolveFlashGallery(publicSlug);
  if (!gallery) notFound();

  const assets = await listFlashAssets(gallery.id);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 min-[620px]:px-7 lg:px-12">
      <p className="text-fg-mute text-sm tracking-[0.1em] uppercase">Alejo Frames</p>
      <h1 className="text-title mt-4 max-w-[24ch] font-serif leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {gallery.title}
      </h1>
      <p className="text-fg-dim mt-3 text-[15px]">
        {gallery.sessionDate ? `${formatSessionDate(gallery.sessionDate)} · ` : ""}
        {assets.length} {assets.length === 1 ? "foto" : "fotos"}
      </p>

      {assets.length === 0 ? (
        <p className="text-fg-dim mt-8 text-[15px]">Todavía no hay fotos en esta galería.</p>
      ) : (
        // Same grid, tiles and viewer as a delivered normal gallery (task
        // #237). Only ids and filenames cross to the client component; every
        // URL it builds is a `/flash/<slug>/…` route.
        <div className="mt-8">
          <FlashGalleryViewer
            publicSlug={gallery.publicSlug}
            assets={assets.map((asset) => ({
              id: asset.id,
              originalFilename: asset.originalFilename,
            }))}
          />
        </div>
      )}
    </main>
  );
}
