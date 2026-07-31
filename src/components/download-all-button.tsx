"use client";

// "Download all" for a delivered gallery's whole selected-and-edited set
// (task #29). Rendered by <ProofGrid>'s own <DeliveredNote> only once the
// gallery is delivered and at least one asset has a final — this component
// itself does not re-check either condition, it only knows how to trigger a
// download for whatever gallery id it's given.
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
//
// TASK #148 — "A BIG GALLERY TAKES REAL TIME ON MOBILE DATA" (that task's own
// body). The route streams the archive without buffering (§11/#29's own
// documented exception), which keeps the DROPLET's memory flat, but says
// nothing about how long the CLIENT waits — and if that wait is invisible,
// the client taps three times and starts three concurrent streams of the
// same gallery, which is exactly the load #29's own memory argument assumed
// would not happen. Two things follow, both state on THIS component rather
// than the page around it, since a same-origin navigation like this one
// gives no other hook to observe it from:
//
//   - A "this takes a while" state, shown from the moment of the click —
//     `isPending` swaps the label to "Preparando tu descarga…" and renders a
//     small note plus an indeterminate pulse bar (`animate-pulse`), the
//     honest version of the mock's own always-on `.zip` box
//     (client.html:948-957): there is nothing to report before a click, so
//     unlike the mock this renders nothing until there is.
//   - The SECOND tap is refused, not merely discouraged. `isPending` guards
//     the click handler itself (`event.preventDefault()`), not just the
//     button's paint — a CSS-only `pointer-events-none` was tried and
//     dropped: `@testing-library/user-event` refuses to `.click()` an
//     element with computed `pointer-events: none` at all (throws, rather
//     than no-op), which would have made the very regression test this
//     guard exists for impossible to write against the same click API real
//     users get simulated through. The JS guard works identically for a
//     mouse tap, a keyboard Enter, or `fireEvent.click`.
//
// NO AUTO RESET, ON PURPOSE. Once `isPending` flips true it stays true for
// the rest of this component's mount — there is no timer counting down to
// re-enable it. The reason is not neglect: a `Content-Disposition:
// attachment` download triggered by a same-tab navigation gives the browser
// NO event this component can observe for "the stream actually finished" (or
// failed) without abandoning the plain-`<a>` approach above and its whole
// reason for existing. Guessing a cooldown would either re-enable too early
// — defeating the guard for the exact multi-gigabyte gallery it exists for —
// or too late, trapping a client whose download genuinely failed behind a
// dead button. Reloading the page is the honest recovery path, the same one
// a great many native download links in the wild rely on.
import { useCallback, useState } from "react";

export function DownloadAllButton({
  galleryId,
  assetCount,
  className,
}: {
  galleryId: string;
  /** Task #148: how many finals the zip will actually contain — <ProofGrid>'s
   * own count off the same `hasFinal` flags `showDownload` already uses per
   * tile. Optional and purely cosmetic (the "Preparando…" note's own "N
   * fotos" clause); omitted entirely when not given rather than guessed. */
  assetCount?: number;
  className?: string;
}) {
  const [isPending, setIsPending] = useState(false);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (isPending) {
        // A tap while the first download is still going — refused outright
        // rather than starting a second concurrent stream of the whole zip.
        event.preventDefault();
        return;
      }
      // Deliberately NOT `preventDefault()`'d — the click's own default
      // navigation is what actually starts the download; this only flips
      // the state that renders the "preparing" feedback and guards the next
      // tap.
      setIsPending(true);
    },
    [isPending],
  );

  const baseClassName =
    className ??
    "border-line text-fg hover:bg-line/40 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors";

  return (
    <div className="flex flex-col items-start gap-2">
      <a
        href={`/api/galleries/${galleryId}/download-all`}
        rel="noopener"
        aria-disabled={isPending}
        onClick={handleClick}
        className={`${baseClassName}${isPending ? "opacity-60" : ""}`}
      >
        {isPending ? "Preparando tu descarga…" : "Descargar todo"}
      </a>
      {isPending && (
        <div className="w-40">
          <p className="text-fg-mute text-[11px]">
            {assetCount ? `${assetCount} foto${assetCount === 1 ? "" : "s"} — ` : ""}no cierres esta
            pestaña
          </p>
          <div className="bg-line mt-1 h-[2px] w-full overflow-hidden rounded-full">
            <div className="bg-accent h-full w-1/3 animate-pulse" />
          </div>
        </div>
      )}
    </div>
  );
}
