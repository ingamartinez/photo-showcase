import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatSessionDate } from "@/lib/galleries";
import {
  getFirstFlashAsset,
  listFlashAssets,
  resolveFlashGallery,
  resolvePublicFlashGallery,
} from "@/lib/flash-access";
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
  const base = `/flash/${gallery.publicSlug}`;

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
        <>
          <a
            href={`${base}/zip`}
            className="bg-accent text-ink mt-6 inline-flex min-h-12 items-center rounded-sm px-6 text-sm font-semibold"
          >
            Descargar todo
          </a>
          <ul className="mt-8 grid grid-cols-1 gap-6 min-[620px]:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset, index) => (
              <li key={asset.id}>
                {/* Plain <img>: the src is a redirecting own route, not a path
                    next/image's optimizer can cache. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${base}/display/${asset.id}`}
                  alt={`Foto ${index + 1} de ${gallery.title}`}
                  width={asset.displayWidth}
                  height={asset.displayHeight}
                  loading={index < 3 ? "eager" : "lazy"}
                  className="bg-bg-2 h-auto w-full rounded-sm"
                />
                <a
                  href={`${base}/final/${asset.id}`}
                  className="text-accent-2 mt-2 inline-flex min-h-12 items-center text-sm"
                >
                  Descargar
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
