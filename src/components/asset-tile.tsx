"use client";

// One proof in the admin grid (task #20): the thumbnail itself (with
// on-demand presigned-URL refresh), plus reorder and delete controls. Task
// #26 adds a final-upload control, rendered only for SELECTED assets — see
// its own comment below for why that follows the exact same "most assets
// never get one" rule the write route itself enforces.
import { useRef, useState } from "react";
import type { WorkspaceAsset } from "@/components/gallery-workspace";

export function AssetTile({
  asset,
  isFirst,
  isLast,
  onDeleted,
  onMoved,
  onFinalUploaded,
}: {
  asset: WorkspaceAsset;
  isFirst: boolean;
  isLast: boolean;
  onDeleted: (assetId: string) => void;
  onMoved: (updates: { id: string; sortOrder: number }[]) => void;
  onFinalUploaded: (assetId: string) => void;
}) {
  const [src, setSrc] = useState(asset.proofUrl);
  const [refreshedOnce, setRefreshedOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalBusy, setFinalBusy] = useState(false);
  const [finalError, setFinalError] = useState<string | null>(null);
  const finalInputRef = useRef<HTMLInputElement>(null);

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

  // Task #26: attaches (or replaces) this asset's final. The route itself
  // is the real guard (an unselected asset gets refused with 409) — this
  // control is only ever RENDERED for a selected asset in the first place
  // (see below), so that refusal should never actually be reachable from
  // this UI, but the route never trusts this component to have gotten that
  // right.
  async function handleFinalFileChosen(file: File) {
    if (finalBusy) return;
    setFinalBusy(true);
    setFinalError(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch(`/api/assets/${asset.id}/final`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setFinalError(body.error ?? `Error ${response.status}`);
        return;
      }
      onFinalUploaded(asset.id);
    } catch {
      setFinalError("No se pudo conectar.");
    } finally {
      setFinalBusy(false);
      if (finalInputRef.current) finalInputRef.current.value = "";
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

      {/* Task #26: only rendered for a SELECTED asset — most assets never
          get a final (schema.ts's own comment on `assets.finalKey`), and
          showing this control on every tile would bury the ones that
          actually need attention among the ones that never will. This is
          also the "make the remaining work obvious" acceptance criterion,
          applied per-tile: `!asset.hasFinal` is visually distinct (the
          "falta" text below), not merely absent. */}
      {asset.isSelected && (
        <div className="border-line-2 flex flex-col gap-1 border-t pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className={asset.hasFinal ? "text-accent-2 text-xs" : "text-xs text-[#e0796b]"}>
              {asset.hasFinal ? "Final subido" : "Falta el final"}
            </span>
            <label className="label hover:text-accent-2 cursor-pointer text-xs transition-colors">
              {finalBusy ? "Subiendo…" : asset.hasFinal ? "Reemplazar" : "Subir final"}
              <input
                ref={finalInputRef}
                type="file"
                accept="image/*"
                disabled={finalBusy}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFinalFileChosen(file);
                }}
              />
            </label>
          </div>
          {finalError && <p className="text-xs text-[#e0796b]">{finalError}</p>}
        </div>
      )}
    </li>
  );
}
