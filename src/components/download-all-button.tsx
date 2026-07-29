"use client";

// "Download all" for a delivered gallery's whole selected-and-edited set
// (task #29). Rendered by <ProofGrid> only once the gallery is delivered and
// at least one asset has a final — this component itself does not re-check
// either condition, it only knows how to trigger a download for whatever
// gallery id it's given.
//
// A PLAIN `<a href>`, unlike <DownloadFinalButton>'s click-to-fetch-then-
// navigate dance — and deliberately so. That component fetches a JSON body
// carrying a THIRD-PARTY (R2) presigned URL first because the actual bytes
// live on a different origin with their own short TTL to respect. This
// button's target, `GET /api/galleries/[galleryId]/download-all`, is THIS
// origin: it streams the zip archive directly, with its own
// `Content-Disposition: attachment` header already set server-side (see that
// route's own comment) — a normal navigation to a same-origin URL already
// carries the session cookie needed for the route's own ownership check, so
// there is no presigned URL to fetch first and nothing that goes stale while
// this link sits on the page.
export function DownloadAllButton({
  galleryId,
  className,
}: {
  galleryId: string;
  className?: string;
}) {
  return (
    <a
      href={`/api/galleries/${galleryId}/download-all`}
      rel="noopener"
      className={
        className ??
        "border-line text-fg hover:bg-line/40 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors"
      }
    >
      Descargar todo
    </a>
  );
}
