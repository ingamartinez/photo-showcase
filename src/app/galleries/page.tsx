import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import { formatGalleryStatus, formatSessionDate, getGalleriesForClient } from "@/lib/galleries";

export const metadata: Metadata = {
  title: "Tus galerías",
  // Every client's own gallery list is unlisted and reachable only by a
  // signed-in session — never indexed, same stance as `/galleries/[publicSlug]`.
  robots: { index: false, follow: false },
};

// Calls requireSession() itself, same as every other guarded page in this
// app — see src/lib/auth-guards.ts's header comment for why a page must
// never rely on an ancestor layout (src/app/galleries/layout.tsx here) as
// its only check. `requireSession()`, not `requireAdmin()`: this page is
// this client area's landing page (task #22) — an admin may also sign in
// and land here, but `getGalleriesForClient` below scopes the result to
// THEIR OWN galleries either way (see that function's own comment), so
// there is no separate "everyone's galleries" branch for an admin to fall
// into by visiting this route.
export default async function ClientGalleriesPage() {
  const session = await requireSession();

  // The session's own user id — never an id read from the URL or a form
  // field, this task's core acceptance criterion. There is nothing else in
  // scope on this route to read an id from: no dynamic segment, no query
  // string, no form.
  const galleries = await getGalleriesForClient(session.user.id);

  return (
    <>
      <span className="label text-accent mb-4 block">Tus galerías</span>
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {galleries.length === 0 ? "Todavía no tenés ninguna galería." : "Tu historial."}
      </h1>

      {galleries.length === 0 ? (
        <p className="text-fg-dim mt-5 max-w-[58ch] text-[15px] leading-relaxed">
          Cuando publiquemos las pruebas de tu sesión, tu galería va a aparecer acá.
        </p>
      ) : (
        <ul className="border-line-2 divide-line-2 mt-10 divide-y rounded-sm border">
          {galleries.map((gallery) => (
            <li key={gallery.id}>
              {/* Routed by the gallery's own `publicSlug`, not its id — same
              client-facing URL every gallery already uses
              (`/galleries/[publicSlug]`). That page itself decides what to
              render for the gallery's current status (proofing → selection,
              delivered → downloads once that page grows one) — this list's
              only job is to get the client to the right gallery, not to
              duplicate that per-status branching here. */}
              <Link
                href={`/galleries/${gallery.publicSlug}`}
                className="hover:bg-line-2/20 flex flex-wrap items-center justify-between gap-3 p-6 transition-colors"
              >
                <div>
                  <p className="font-serif text-lg">{gallery.title}</p>
                  <p className="text-fg-mute text-sm">
                    Sesión: {formatSessionDate(gallery.sessionDate)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="label text-fg-mute">{formatGalleryStatus(gallery.status)}</span>
                  <span className="text-fg-mute text-sm">{gallery.photoCount} fotos</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
