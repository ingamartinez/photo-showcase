"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

export type GalleryItem = {
  id: number;
  imageKey: string;
  alt: string;
  title: string | null;
  width: number;
  height: number;
};

export function CollectionGallery({ items }: { items: GalleryItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const isOpen = open !== null;

  const close = useCallback(() => setOpen(null), []);
  const go = useCallback(
    (dir: 1 | -1) => setOpen((i) => (i === null ? i : (i + dir + items.length) % items.length)),
    [items.length],
  );

  // Keyboard navigation + body scroll lock while the lightbox is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, close, go]);

  const current = open === null ? null : items[open];

  return (
    <>
      <div className="work">
        {items.map((item, i) => (
          <figure key={item.id}>
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="block w-full cursor-zoom-in"
              aria-label={`Ampliar: ${item.alt}`}
            >
              <Image
                src={item.imageKey}
                alt={item.alt}
                width={item.width}
                height={item.height}
                sizes="(max-width: 560px) 100vw, (max-width: 900px) 50vw, 33vw"
              />
              {item.title && (
                <figcaption>
                  <span className="text-accent">{item.title}</span>
                </figcaption>
              )}
            </button>
          </figure>
        ))}
      </div>

      {current && (
        <div
          className="bg-bg-sunken/97 fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm sm:p-10"
          role="dialog"
          aria-modal="true"
          aria-label={current.alt}
          onClick={close}
        >
          <button
            type="button"
            onClick={close}
            aria-label="Cerrar"
            className="border-line-2 text-fg-dim hover:border-accent hover:text-accent-2 absolute top-5 right-5 z-10 flex size-11 items-center justify-center rounded-full border transition-colors"
          >
            ✕
          </button>

          {items.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(-1);
                }}
                aria-label="Anterior"
                className="border-line-2 text-fg-dim hover:border-accent hover:text-accent-2 absolute left-3 z-10 flex size-11 items-center justify-center rounded-full border transition-colors sm:left-6"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  go(1);
                }}
                aria-label="Siguiente"
                className="border-line-2 text-fg-dim hover:border-accent hover:text-accent-2 absolute right-3 z-10 flex size-11 items-center justify-center rounded-full border transition-colors sm:right-6"
              >
                ›
              </button>
            </>
          )}

          <figure
            className="flex max-h-full flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative h-[80vh] w-[min(92vw,900px)]">
              <Image
                src={current.imageKey}
                alt={current.alt}
                fill
                sizes="(max-width: 900px) 92vw, 900px"
                className="rounded-sm object-contain"
                priority
              />
            </div>
            <figcaption className="label text-fg-dim">{current.title ?? current.alt}</figcaption>
          </figure>
        </div>
      )}
    </>
  );
}
