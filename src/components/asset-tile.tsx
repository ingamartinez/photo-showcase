"use client";

// One proof in the admin grid (task #20): the thumbnail itself (with
// on-demand presigned-URL refresh), plus reorder and delete controls.
import { useState } from "react";
import type { WorkspaceAsset } from "@/components/gallery-workspace";

export function AssetTile({
  asset,
  isFirst,
  isLast,
  onDeleted,
  onMoved,
}: {
  asset: WorkspaceAsset;
  isFirst: boolean;
  isLast: boolean;
  onDeleted: (assetId: string) => void;
  onMoved: (updates: { id: string; sortOrder: number }[]) => void;
}) {
  const [src, setSrc] = useState(asset.proofUrl);
  const [refreshedOnce, setRefreshedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A presigned proof URL is only good for 5 minutes
  // (`PRESIGNED_URL_TTL_SECONDS`, src/lib/r2.ts). On a gallery page left
  // open longer than that (uploading ~100 photos is not a 5-minute job),
  // the <img> below fails to load with the ORIGINAL url — this refetches a
  // fresh one from the read route (task #16) ONCE, on demand, rather than
  // polling every tile on a timer regardless of whether it's even still on
  // screen. Guarded by `refreshedOnce` so a genuinely broken/deleted object
  // fails once and stays failed, instead of retrying forever.
  async function handleImgError() {
    if (refreshedOnce) return;
    setRefreshedOnce(true);
    try {
      const response = await fetch(`/api/assets/${asset.id}/proof`);
      if (!response.ok) return;
      const body = (await response.json()) as { url: string };
      setSrc(body.url);
    } catch {
      // Leave the broken thumbnail as-is; nothing else to try here.
    }
  }

  async function handleDelete() {
    if (busy) return;
    if (
      !window.confirm(`¿Eliminar "${asset.originalFilename}"? Esta acción no se puede deshacer.`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      if (!response.ok) {
        setError("No se pudo eliminar.");
        return;
      }
      onDeleted(asset.id);
    } catch {
      setError("No se pudo conectar.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(direction: "up" | "down") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${asset.id}/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      if (!response.ok) {
        setError("No se pudo reordenar.");
        return;
      }
      const body = (await response.json()) as { updated: { id: string; sortOrder: number }[] };
      onMoved(body.updated);
    } catch {
      setError("No se pudo conectar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-line-2 flex flex-col gap-2 rounded-sm border p-2">
      <div
        className="bg-line-2 relative overflow-hidden rounded-sm"
        style={{ aspectRatio: `${asset.proofWidth} / ${asset.proofHeight}` }}
      >
        {/* Plain <img>, not next/image: proof URLs are short-lived, private,
            presigned R2 URLs whose query string (and therefore exact form)
            is never stable between two loads of the same asset — configuring
            a next/image remote pattern for that buys nothing, since
            processProof already downscales/compresses server-side. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={asset.originalFilename}
          onError={() => void handleImgError()}
          className="h-full w-full object-cover"
        />
      </div>
      <p className="text-fg-mute truncate text-xs" title={asset.originalFilename}>
        {asset.originalFilename}
      </p>
      {error && <p className="text-xs text-[#e0796b]">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <button
            type="button"
            disabled={busy || isFirst}
            onClick={() => void handleMove("up")}
            aria-label="Mover antes"
            className="border-line-2 hover:border-accent rounded-sm border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={busy || isLast}
            onClick={() => void handleMove("down")}
            aria-label="Mover después"
            className="border-line-2 hover:border-accent rounded-sm border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleDelete()}
          className="text-xs text-[#e0796b] transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          Eliminar
        </button>
      </div>
    </li>
  );
}
