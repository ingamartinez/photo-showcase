// The two GraphQL documents the CLIENT-facing gallery pages execute — task
// #31, retyped from codegen in task #32. One module rather than two inline
// documents so that the document, the accessor the page calls, and the test
// that validates the document against the schema all sit together.
//
// THERE ARE NO HAND-WRITTEN RESULT TYPES IN THIS FILE, and that is the point
// of task #32. Each document is written inside `graphql(...)` from
// ./generated, which `bun run codegen` gives one overload per known document
// string; the overload returns a `TypedDocumentNode` carrying that document's
// own result and variable types, and `executeServerDocument` reads both off
// it. The two exported `type`s below are projections of the generated query
// types, not restatements of them.
//
// WHAT THAT BUYS OVER TASK #31'S HAND-WRITTEN TYPES, precisely: #31's types
// were checked against the SCHEMA (./execute.ts validates every document
// before executing it) but never against their own DOCUMENT — a type could
// claim a field the document did not select, and both the validation and the
// runtime tests would stay green while a page read `undefined`. #31 disclosed
// that gap itself. It is now closed by construction, in both directions:
// narrowing the document narrows the type, and editing a document without
// re-running codegen makes `graphql(...)` fall through to its `unknown`
// fallback overload so `bun run typecheck` fails at this call site.
//
// WHY THAT LAST SENTENCE IS THE WHOLE GUARD, and why the generated output is
// therefore COMMITTED rather than produced by a CI step: `graphql()`'s runtime
// implementation is a lookup in a generated map that returns `{}` for a string
// it does not know. So a stale map is a compile error and nothing else — there
// is no runtime check to fall back on, which is exactly why the compile error
// has to be available in a fresh clone with no codegen step run first. See
// codegen.ts's own header.
//
// These run through `executeServerDocument` (./execute.ts), IN PROCESS. Read
// that file's "what this does not do" list before adding a document here; the
// limitation that matters most for these particular reads is that no Yoga
// plugin runs, so nothing here is reachable from a request.
//
// WHAT DELIBERATELY DOES NOT GO THROUGH GRAPHQL, and must not be moved here:
//  * Presigned R2 URLs. `getPresignedUrl()`/`displayKey()` stay direct calls
//    in the page. The epic's non-negotiable rule (task #6) is that binaries
//    never traverse GraphQL, and a presigned URL is the credential that
//    fetches one. Note what the detail document below DOES carry: `proofKey`
//    and `finalKey`, the bare R2 object keys. Those are metadata — R2 is
//    private, a key alone fetches nothing (see ./types/asset.ts's own header).
//  * `getGallerySelection()`. It is not in this schema and was not added:
//    it returns the OTHER clients' display names, and it is deliberately read
//    by the page only after that page's own gates have passed.
import "server-only";

import type { Session } from "next-auth";
import { graphql } from "./generated";
import type { ClientGalleryBySlugQuery, ClientGalleryListQuery } from "./generated/graphql";
import { executeServerDocument } from "./execute";

// ---------------------------------------------------------------------------
// `/galleries` — the client's own gallery index
// ---------------------------------------------------------------------------

/** Resolved once at module scope, on purpose: `executeServerDocument` memoises
 * schema validation per document OBJECT, so a module-scope constant is
 * validated once per process instead of once per render. `graphql()` is a map
 * lookup — it parses nothing at runtime, reads no environment and touches no
 * database — so this is safe to evaluate while `next build` collects page
 * data. */
const CLIENT_GALLERY_LIST_DOCUMENT = graphql(`
  query ClientGalleryList {
    galleryList {
      id
      title
      publicSlug
      status
      sessionDate
      photoCount
      coverProofKey
    }
  }
`);

/** One row of the client's own gallery index, as the document above selects
 * it — derived from the generated query type rather than declared, so it
 * cannot claim a field the document does not ask for. Structurally identical
 * to `ClientGalleryListItem` (src/lib/galleries.ts) today, which is expected:
 * `GalleryListItem`'s GraphQL type is a field-for-field projection of it (see
 * ./types/gallery-list-item.ts). The two are deliberately not aliased to each
 * other — one describes what a Drizzle query returns, the other what this
 * document selects, and narrowing the document should not have to wait for
 * anyone to notice. */
export type ClientGalleryListRow = ClientGalleryListQuery["galleryList"][number];

/** The signed-in client's own galleries, most recent session first — `[]` when
 * they have none. Same scope, same ordering and the same single query as the
 * `getGalleriesForClient` call this replaced; the resolver behind it calls
 * that exact function. */
export async function readClientGalleryList(session: Session): Promise<ClientGalleryListRow[]> {
  const data = await executeServerDocument({
    document: CLIENT_GALLERY_LIST_DOCUMENT,
    session,
  });

  return data.galleryList;
}

// ---------------------------------------------------------------------------
// `/galleries/[publicSlug]` — one gallery, by its client-facing slug
// ---------------------------------------------------------------------------

/** Narrower than `Gallery`'s full field set on purpose — the same allowlist
 * discipline the page's own asset mapping follows. `publicSlug` is absent (the
 * page already has it, from the URL), `createdAt` is absent (nothing renders
 * it), and `clients` is absent because this page must never render the OTHER
 * clients attached to the gallery from here: the collaborative tray gets its
 * names from `getGallerySelection`, behind the page's gates. `package` selects
 * `name` only — never a live price, which the schema does not expose at all
 * (see ./types/package.ts).
 *
 * Every one of those omissions is now load-bearing on the TYPE too, not only
 * on the wire: `ClientGalleryDetail` below is projected off this document, so
 * a page that starts reading `gallery.publicSlug` stops compiling instead of
 * reading `undefined`. */
const CLIENT_GALLERY_DETAIL_DOCUMENT = graphql(`
  query ClientGalleryBySlug($publicSlug: String!) {
    galleryBySlug(publicSlug: $publicSlug) {
      id
      title
      status
      sessionDate
      selectionSubmittedAt
      includedPhotosSnapshot
      extraPhotoPriceCopSnapshot
      originalPhotoPriceCopSnapshot
      selectionTrayMode
      package {
        name
      }
      assets {
        id
        originalFilename
        proofKey
        proofWidth
        proofHeight
        isSelected
        finalKey
        isEdited
      }
    }
  }
`);

/** The gallery the detail document selects, with the refusal `null` stripped —
 * `readClientGalleryBySlug` below keeps the `| null` in its own return type,
 * where it means something.
 *
 * Two properties of this type are inherited from the schema rather than chosen
 * here, and both used to be hand-written claims:
 *  * `selectionSubmittedAt` is `string | null`, an ISO string and never a
 *    `Date` — this builder registers no `Date` scalar, so
 *    `Gallery.selectionSubmittedAt` resolves through `.toISOString()` (see
 *    ./types/gallery.ts). The page passes it straight to `<ProofGrid>`, which
 *    wanted a string anyway.
 *  * every other field is non-null, because task #32 made this schema say so
 *    (see ../graphql/builder.ts). Before that the schema claimed all of them
 *    were nullable while the hand-written types claimed none of them were, and
 *    nothing checked the two against each other. */
export type ClientGalleryDetail = NonNullable<ClientGalleryBySlugQuery["galleryBySlug"]>;

/** One photo of that gallery. `proofKey`/`finalKey` are bare R2 object keys,
 * unbranded — they made a round trip through Postgres and then through
 * GraphQL, and `R2Key` survives neither. The page re-attaches the brand with
 * `storedKey()` (task #78) before presigning. */
export type ClientGalleryDetailAsset = ClientGalleryDetail["assets"][number];

/**
 * One gallery by its client-facing slug, or `null`.
 *
 * `null` is DELIBERATELY AMBIGUOUS and the caller must treat it that way: it
 * means "no gallery you may see under that slug", covering slug-matches-nothing,
 * you-are-not-an-owner, and not-yet-client-visible alike. See ./types/query.ts
 * on `galleryBySlug` for why the schema refuses to distinguish them, and
 * `/galleries/[publicSlug]/page.tsx` for how the page recovers the distinction
 * it needs for its HTTP status without this field leaking it.
 */
export async function readClientGalleryBySlug(
  publicSlug: string,
  session: Session,
): Promise<ClientGalleryDetail | null> {
  const data = await executeServerDocument({
    document: CLIENT_GALLERY_DETAIL_DOCUMENT,
    session,
    variableValues: { publicSlug },
  });

  return data.galleryBySlug;
}

/** The documents this app executes in process, exported for
 * `client-gallery-reads.test.ts` to `validate()` against the real schema.
 * Exported ONLY for that: a caller wanting one of these should call the
 * function above it, which pairs the document with its result type.
 *
 * Still worth validating even though these documents are now GENERATED from
 * the schema, for a reason worth writing down: they are generated from
 * `schema.graphql`, a COMMITTED snapshot, not from the live Pothos schema. If
 * that snapshot goes stale, codegen keeps happily typing documents against an
 * older schema. This validates against `getSchema()` — the real one — and
 * ./schema-sdl.test.ts checks the snapshot itself. */
export const CLIENT_GALLERY_DOCUMENTS = {
  ClientGalleryList: CLIENT_GALLERY_LIST_DOCUMENT,
  ClientGalleryBySlug: CLIENT_GALLERY_DETAIL_DOCUMENT,
} as const;
