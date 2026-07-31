import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import {
  formatClientGalleryCardState,
  formatGalleryIndexHeading,
  formatGalleryIndexLede,
  formatSessionDate,
} from "@/lib/galleries";
import { readClientGalleryList } from "@/lib/graphql/client-gallery-reads";
import { getPresignedUrl, storedKey } from "@/lib/r2";

// Per-`tone` colour for the state chip (`design/system/client.html:169-171`:
// `.state--you`/`.state--wait`/`.state--done`) — a component-local map, not a
// new `globals.css` token: `--color-*` under `@theme inline` is agent-9's
// (#175) this cycle, and `#8FAE97` (the mock's "done" green) has no existing
// brand token to reuse, so it is an arbitrary Tailwind value here rather than
// a new custom property.
const STATE_TONE_CLASS: Record<ReturnType<typeof formatClientGalleryCardState>["tone"], string> = {
  pending: "text-accent-2",
  waiting: "text-fg-dim",
  done: "text-[#8FAE97]",
};

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
// and land here, but the read below scopes the result to THEIR OWN
// galleries either way, so there is no separate "everyone's galleries"
// branch for an admin to fall into by visiting this route.
export default async function ClientGalleriesPage() {
  const session = await requireSession();

  // Task #31: read through the GraphQL schema (`Query.galleryList`), executed
  // IN PROCESS rather than over HTTP — see
  // src/lib/graphql/execute.ts's header for why, and what that path does and
  // does not include.
  //
  // NOTHING ABOUT THE SCOPING RULE MOVED. The resolver behind `galleryList`
  // calls the SAME `getGalleriesForClient(session.user.id)` this page called
  // directly before, so the ownership subquery, the soft-removed-client
  // filter and the CLIENT_VISIBLE_STATUSES filter are all still the one
  // implementation in src/lib/galleries.ts — including its deliberate absence
  // of an admin bypass. What changed is where the call is made from, not what
  // it does.
  //
  // The session's own user id — never an id read from the URL or a form
  // field, this route's core acceptance criterion (task #22) — and passing
  // the whole session in is what keeps that true: `galleryList` takes no
  // arguments at all, so there is nothing a caller could name a different
  // client through. There is nothing else in scope on this route to read an
  // id from either: no dynamic segment, no query string, no form.
  const galleries = await readClientGalleryList(session);
  const hasGalleries = galleries.length > 0;
  const heading = formatGalleryIndexHeading(session.user.name, hasGalleries);
  const lede = formatGalleryIndexLede(galleries.map((gallery) => gallery.sessionDate));

  return (
    <>
      <span className="label text-accent mb-4 block">Tus galerías</span>
      {/* `.display`, client.html:121-125 and the heading markup at 597-600.
          `formatGalleryIndexHeading` (src/lib/galleries.ts) decides the exact
          lines, including the null-name degrade this task's own late-added
          acceptance criterion asks for — see that function's own comment. */}
      <h1 className="max-w-[24ch] font-serif text-[clamp(30px,4.5vw,52px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
        {heading.lines.map((line, index) => (
          <span key={line}>
            {index > 0 && <br />}
            {line}
          </span>
        ))}
      </h1>

      {!hasGalleries ? (
        <p className="text-fg-dim mt-5 max-w-[58ch] text-[15px] leading-relaxed">
          Cuando publiquemos las pruebas de tu sesión, tu galería va a aparecer acá.
        </p>
      ) : (
        <>
          {/* `.lede`, client.html:126 and 600 — count + earliest year, both
              derived from the galleries this render already fetched, never a
              second query. */}
          {lede && (
            <p className="text-fg-dim mt-3 max-w-[46ch] text-[15px] leading-relaxed">{lede}</p>
          )}

          {/* `.gal-list`, client.html:150 — a single ordered list either way:
              the trap this task's own body names ("no agregar filtros, orden
              ni búsqueda") rules out anything fancier than "well-ordered
              list", for one row as much as for six. */}
          <ul className="mt-10 flex flex-col gap-2">
            {galleries.map((gallery) => {
              const state = formatClientGalleryCardState(gallery.status);
              // Task #180 — the photographer's own explicitly-picked cover
              // (never derived, see galleries.ts's own comment on
              // `coverProofKey`). Presigned HERE, in the page, not in the
              // GraphQL resolver: same "binaries/credentials never traverse
              // GraphQL" stance every other proof in this app already
              // follows (src/lib/graphql/client-gallery-reads.ts's header).
              // `null` — no cover chosen yet — is this gallery's ORDINARY
              // starting state, not an edge case; see the `else` branch
              // below for what that degrades to.
              const coverUrl = gallery.coverProofKey
                ? getPresignedUrl(storedKey(gallery.coverProofKey))
                : null;

              // `.state`/`.gal-card__t`/`.gal-card__meta`, client.html:607-609
              // — shared between both card variants below so the two never
              // drift into two different renderings of the SAME three facts.
              const cardText = (
                <>
                  <span
                    className={`label mb-2 flex items-center gap-[7px] ${STATE_TONE_CLASS[state.tone]}`}
                  >
                    <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-current" />
                    {state.label}
                  </span>
                  <p className="font-serif text-2xl">{gallery.title}</p>
                  <p className="text-fg-mute mt-1 text-sm">
                    {formatSessionDate(gallery.sessionDate)} · {gallery.photoCount} fotos
                  </p>
                </>
              );

              return (
                <li key={gallery.id}>
                  {/* Routed by the gallery's own `publicSlug`, not its id —
                  same client-facing URL every gallery already uses
                  (`/galleries/[publicSlug]`). That page itself decides what
                  to render for the gallery's current status (proofing →
                  selection, delivered → downloads once that page grows one)
                  — this list's only job is to get the client to the right
                  gallery, not to duplicate that per-status branching here. */}
                  {coverUrl ? (
                    // `.gal-card`, client.html:604-627 — a photo card, 16:10,
                    // text overlaid on a bottom-to-top gradient. This is the
                    // ONLY branch that ever renders a photo; #143's original
                    // text-forward card (the `else` below) is the fallback
                    // for every gallery that has not had a cover picked yet,
                    // not a legacy path being phased out.
                    <Link
                      href={`/galleries/${gallery.publicSlug}`}
                      className="hover:border-accent/50 relative block overflow-hidden rounded-sm border border-transparent transition-colors"
                    >
                      {/* `.gal-card__img`, client.html:152 — 16:10, reserved
                          before the photo loads (no CLS), same discipline
                          proof-tile.tsx's own aspect-ratio box already
                          holds itself to for the proofing grid's tiles. */}
                      <div className="relative aspect-[16/10]">
                        {/* Plain <img>, not next/image: same reasoning as
                            proof-tile.tsx — a short-lived presigned R2 URL
                            is not a stable path next/image's optimizer can
                            cache or re-derive a src set from. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={coverUrl}
                          alt=""
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                        {/* The mock's own bottom-to-top gradient
                            (client.html:153-156) — text sits directly on
                            the photo, so this is what keeps it legible
                            regardless of what the photo itself looks
                            like. */}
                        <div
                          aria-hidden
                          className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-transparent"
                        />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 px-6 pb-[18px]">{cardText}</div>
                    </Link>
                  ) : (
                    // The degrade this task's own acceptance criterion
                    // requires: no cover chosen yet must never collapse the
                    // card or leave a broken hole where a photo should be.
                    // #143's original bordered, text-only card, verbatim —
                    // it already works today, and it keeps working here.
                    <Link
                      href={`/galleries/${gallery.publicSlug}`}
                      className="border-line-2 hover:border-accent/50 flex flex-wrap items-center justify-between gap-3 rounded-sm border p-6 transition-colors"
                    >
                      <div>{cardText}</div>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
