"use client";

// Thumbnail grid of a flash gallery for the admin (task #233), with a delete
// button per photo. `url` is a short-lived presigned URL the page minted for
// the display derivative after `requireAdmin()` — plain <img>, same reasoning
// as asset-tile.tsx (private, expiring URLs gain nothing from next/image).
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteFlashAsset } from "@/app/dashboard/flash/actions";

export type FlashPhoto = {
  id: string;
  originalFilename: string;
  url: string;
  width: number;
  height: number;
};

export function FlashPhotoGrid({ photos }: { photos: FlashPhoto[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function remove(photo: FlashPhoto) {
    if (!window.confirm(`¿Borrar ${photo.originalFilename}?`)) return;
    startTransition(async () => {
      await deleteFlashAsset(photo.id);
      router.refresh();
    });
  }

  if (photos.length === 0) {
    return <p className="text-fg-mute text-sm">Todavía no hay fotos. Sube la primera arriba.</p>;
  }

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {photos.map((photo) => (
        <li key={photo.id} className="flex flex-col gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={photo.originalFilename}
            width={photo.width}
            height={photo.height}
            loading="lazy"
            className="bg-bg-2 aspect-[4/3] w-full rounded-[4px] object-cover"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-fg-mute truncate text-xs">{photo.originalFilename}</span>
            <button
              type="button"
              disabled={pending}
              onClick={() => remove(photo)}
              aria-label={`Borrar ${photo.originalFilename}`}
              className="text-fg-dim min-h-11 text-xs underline disabled:opacity-50 lg:min-h-6"
            >
              Borrar
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
