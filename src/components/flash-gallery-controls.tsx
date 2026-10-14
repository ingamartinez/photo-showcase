"use client";

// The sharing controls of a flash gallery detail page (task #233): the public
// on/off switch, the copyable link, and gallery deletion. The server actions
// re-validate admin on every call — this component is UX, not authority.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteFlashGallery, setFlashGalleryPublic } from "@/app/dashboard/flash/actions";

const buttonClass =
  "border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9";

export function FlashGalleryControls({
  flashGalleryId,
  publicPath,
  initialIsPublic,
}: {
  flashGalleryId: string;
  /** `/flash/<slug>` — the page itself ships in slice #234. */
  publicPath: string;
  initialIsPublic: boolean;
}) {
  const router = useRouter();
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !isPublic;
    startTransition(async () => {
      const result = await setFlashGalleryPublic(flashGalleryId, next);
      if (result.ok) {
        setIsPublic(next);
        setMessage(next ? "La galería ahora es pública." : "La galería ya no es pública.");
        router.refresh();
      } else {
        setMessage(result.message);
      }
    });
  }

  async function copyLink() {
    const absolute = `${window.location.origin}${publicPath}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setMessage("Enlace copiado.");
    } catch {
      setMessage("No se pudo copiar. Selecciona el enlace y cópialo a mano.");
    }
  }

  function remove() {
    if (!window.confirm("¿Borrar esta galería y todas sus fotos? No se puede deshacer.")) return;
    startTransition(async () => {
      const result = await deleteFlashGallery(flashGalleryId);
      if (result.ok) {
        router.push("/dashboard/flash");
      } else {
        setMessage(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={isPublic}
          disabled={pending}
          onClick={toggle}
          className={buttonClass}
        >
          {isPublic ? "Pública: cualquiera con el enlace" : "Privada: solo clientes asignados"}
        </button>
        <button type="button" onClick={() => void copyLink()} className={buttonClass}>
          Copiar enlace
        </button>
        <button type="button" disabled={pending} onClick={remove} className={buttonClass}>
          Borrar galería
        </button>
      </div>
      <p className="text-fg-mute text-xs break-all">
        Enlace: <span className="text-fg-dim">{publicPath}</span>
        {!isPublic && " — solo funciona para el público cuando la galería es pública."}
      </p>
      <p role="status" aria-live="polite" className="text-fg-dim min-h-4 text-xs">
        {message}
      </p>
    </div>
  );
}
