"use client";

// Individual download control for ONE asset's FINAL image (task #28 — the
// last link of the delivery chain: "the client gets their photos... this is
// what they paid for"). Rendered by <ProofGrid>/<ProofLightbox> only for a
// `delivered` gallery's assets that are both selected AND edited
// (`WorkspaceAsset`-style `hasFinal` boolean — see proof-grid.tsx's own
// `ProofAsset` type) — this component itself does not re-check either
// condition, it only knows how to fetch a fresh presigned URL and trigger
// the browser's download for whatever asset id it's given.
//
// Why a click-to-fetch-then-navigate flow, not a plain <a href> pointing at
// an already-presigned URL rendered ahead of time: every other presigned URL
// in this app (proof thumbnails included) is minted by an ownership-checked
// route at the moment it's needed, never baked into the page and left
// sitting in the DOM past `PRESIGNED_URL_TTL_SECONDS` (src/lib/r2.ts) — a
// download button is no different, and a click is exactly "the moment it's
// needed".
//
// Why a real navigation (a temporary <a>, clicked) rather than
// `fetch()` + `URL.createObjectURL()`: R2 answers this GET with
// `Content-Disposition: attachment; filename="…"` (see
// src/app/api/assets/[assetId]/final/route.ts's own comment on
// `buildFinalDownloadFilename`, and `getPresignedUrl`'s new second argument
// in src/lib/r2.ts) — a normal browser navigation to a URL carrying that
// header is what BOTH iOS Safari and Android Chrome treat as "download this
// file", cross-origin URL and all, with zero extra client-side plumbing. A
// blob-URL round trip would work too, but doubles the file's bytes in memory
// for a full-resolution JPEG, for no benefit this app needs. `window.open()`
// is avoided for the same reason `<a>` + `.click()` is used instead: firing
// it AFTER an `await` (this fetch has already resolved by the time we know
// the URL) is exactly the shape some browsers' popup blockers treat as no
// longer "in direct response to a user gesture" and silently block; a
// same-tab navigation via a clicked anchor has no such restriction.
import { useCallback, useState } from "react";

export function DownloadFinalButton({
  assetId,
  originalFilename,
  className,
}: {
  assetId: string;
  // Only used for the button's own accessible name — the actual saved
  // filename is decided server-side by `buildFinalDownloadFilename` and
  // arrives via the presigned URL's `Content-Disposition` header, not
  // anything this component constructs itself.
  originalFilename: string;
  className?: string;
}) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${assetId}/final`);
      if (!response.ok) {
        setError("No se pudo descargar la foto.");
        return;
      }
      const body = (await response.json()) as { url: string };
      const link = document.createElement("a");
      link.href = body.url;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setError("No se pudo conectar.");
    } finally {
      setIsPending(false);
    }
  }, [assetId]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={isPending}
        aria-label={`Descargar: ${originalFilename}`}
        className={
          className ??
          "bg-accent text-bg rounded-full px-3 py-1 text-xs font-medium shadow transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        {isPending ? "Descargando…" : "Descargar"}
      </button>
      {error && <p className="text-[11px] text-[#e0796b]">{error}</p>}
    </div>
  );
}
