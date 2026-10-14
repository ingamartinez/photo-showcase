// Link-preview metadata for /flash/[publicSlug] (epic #232, owner request).
//
// A PUBLIC gallery with at least one photo shares its title and first photo.
// Anything else (private, or public but empty) must leak NEITHER: it returns
// only `robots`, so the root layout's generic Open Graph applies. The image is
// a stable own route, never a presigned R2 URL — chat apps cache the preview
// and a presigned URL would have expired by then.
import type { Metadata } from "next";
import type { FlashAsset, FlashGallery } from "@/lib/db/schema";

const NOINDEX: Metadata["robots"] = { index: false, follow: false };

export function flashOgImagePath(publicSlug: string): string {
  return `/flash/${publicSlug}/og-image`;
}

export function buildFlashMetadata(
  gallery: Pick<FlashGallery, "title" | "isPublic" | "publicSlug"> | null,
  firstAsset: Pick<FlashAsset, "displayWidth" | "displayHeight"> | null,
): Metadata {
  if (!gallery || !gallery.isPublic || !firstAsset) return { robots: NOINDEX };
  const image = {
    url: flashOgImagePath(gallery.publicSlug),
    width: firstAsset.displayWidth,
    height: firstAsset.displayHeight,
  };
  return {
    title: gallery.title,
    robots: NOINDEX,
    openGraph: { title: gallery.title, type: "website", locale: "es_CO", images: [image] },
    twitter: { card: "summary_large_image", title: gallery.title, images: [image.url] },
  };
}
