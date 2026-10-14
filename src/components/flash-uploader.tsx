"use client";

// Bulk uploader for a flash gallery (task #233). Unlike the finals uploader
// there is no filename matching and no review step: a flash gallery has no
// proofs to pair against, so every chosen file simply becomes a photo. Files go
// up one request at a time so a failure names the exact file.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FINAL_UPLOAD_ACCEPT } from "@/lib/final-formats";

type ItemStatus = "uploading" | "done" | "error";
type Item = { name: string; status: ItemStatus; error?: string };

const ERROR_COPY: Record<string, string> = {
  not_an_image: "Formato no admitido (usa JPEG o PNG).",
  file_too_large: "El archivo es demasiado grande.",
  processing_failed: "No se pudo leer la imagen.",
  upload_failed: "Falló la subida al almacenamiento.",
};

export function FlashUploader({ flashGalleryId }: { flashGalleryId: string }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);

  function update(index: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function handleFiles(files: File[]) {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setItems(files.map((file) => ({ name: file.name, status: "uploading" })));

    for (let index = 0; index < files.length; index++) {
      try {
        const body = new FormData();
        body.set("file", files[index]!);
        const response = await fetch(`/api/flash/${flashGalleryId}/assets`, {
          method: "POST",
          body,
        });
        if (!response.ok) {
          const json = (await response.json().catch(() => ({}))) as { error?: string };
          update(index, {
            status: "error",
            error: ERROR_COPY[json.error ?? ""] ?? `Error ${response.status}`,
          });
          continue;
        }
        update(index, { status: "done" });
      } catch {
        update(index, { status: "error", error: "No se pudo conectar." });
      }
    }

    setBusy(false);
    router.refresh();
  }

  const done = items.filter((item) => item.status === "done").length;

  return (
    <div className="border-line-2 flex flex-col gap-3 rounded-[6px] border border-dashed p-4">
      <span className="text-fg text-sm font-medium">Subir fotos</span>
      <span className="text-fg-dim text-xs">
        JPEG o PNG, tal como los exportaste. Se guardan sin cambios y se generan versiones ligeras
        para ver la galería.
      </span>
      <label className="border-line-2 hover:border-accent flex min-h-11 w-fit cursor-pointer items-center rounded-[5px] border px-4 text-sm font-semibold transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        {busy ? "Subiendo…" : "Elegir archivos"}
        <input
          type="file"
          accept={FINAL_UPLOAD_ACCEPT}
          multiple
          disabled={busy}
          className="sr-only"
          onChange={(event) => {
            const input = event.target;
            const files = Array.from(input.files ?? []);
            input.value = "";
            void handleFiles(files);
          }}
        />
      </label>
      {items.length > 0 && (
        <>
          <p role="status" aria-live="polite" className="text-fg-mute text-xs">
            {done} de {items.length} subidas
          </p>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
            {items.map((item, index) => (
              <li key={`${item.name}-${index}`} className="flex justify-between gap-3">
                <span className="text-fg-dim truncate">{item.name}</span>
                <span className={item.status === "error" ? "text-danger" : "text-fg-mute"}>
                  {item.status === "uploading"
                    ? "Subiendo…"
                    : item.status === "done"
                      ? "Listo"
                      : item.error}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
