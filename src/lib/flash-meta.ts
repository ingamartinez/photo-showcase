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
    ...flashOgDimensions(firstAsset.displayWidth, firstAsset.displayHeight),
  };
  return {
    title: gallery.title,
    robots: NOINDEX,
    openGraph: { title: gallery.title, type: "website", locale: "es_CO", images: [image] },
    twitter: { card: "summary_large_image", title: gallery.title, images: [image.url] },
  };
}

/** Longest edge of the served preview. WhatsApp drops heavy preview images, so
 * the og-image route serves a ~1200px JPEG instead of the 1600px display WebP. */
export const FLASH_OG_MAX_EDGE = 1200;

/** Dimensions of the og-image the route ACTUALLY serves for a display
 * derivative of `width` x `height` (fit inside the max edge, never enlarged).
 * The route resizes with the same rule, and `og:image:width/height` declare
 * these numbers. */
export function flashOgDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, FLASH_OG_MAX_EDGE / width, FLASH_OG_MAX_EDGE / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
