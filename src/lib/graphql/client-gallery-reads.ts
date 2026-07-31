// The two GraphQL documents the CLIENT-facing gallery pages execute, and the
// result types they expect — task #31. One module rather than two inline
// documents so that the document, the TypeScript shape the page reads off it,
// and the test that validates one against the schema all sit together.
//
// These run through `executeServerDocument` (./execute.ts), IN PROCESS. Read
// that file's "what this does not do" list before adding a document here; the
// two limitations that matter most for these particular reads are:
//  * the result types below are HAND-WRITTEN and cast into. `execute.ts`
//    validates each document against the schema, so a field that does not
//    exist throws — but nothing yet proves these `type` declarations describe
//    what the document actually returns. Task #32 adds codegen; until then,
//    keep every field of a type below visible in the document above it.
//  * no Yoga plugin runs, so nothing here is reachable from a request.
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

import { parse } from "graphql";
import type { Session } from "next-auth";
import type { ClientGalleryListItem, GalleryDetail } from "@/lib/galleries";
import { executeServerDocument } from "./execute";

// ---------------------------------------------------------------------------
// `/galleries` — the client's own gallery index
// ---------------------------------------------------------------------------

/** Parsed once at module scope, on purpose: `executeServerDocument` memoises
 * schema validation per document OBJECT, so a module-scope constant is
 * validated once per process instead of once per render. `parse` reads no
 * environment and touches no database, so this is safe to evaluate while
 * `next build` collects page data. */
const CLIENT_GALLERY_LIST_DOCUMENT = parse(/* GraphQL */ `
  query ClientGalleryList {
    galleryList {
      id
      title
      publicSlug
      status
      sessionDate
      photoCount
    }
  }
`);

/** Exactly `ClientGalleryListItem` (src/lib/galleries.ts) — reused rather than
 * re-declared, because `galleryList`'s GraphQL type is a field-for-field
 * projection of it (see ./types/gallery-list-item.ts) and the page renders the
 * same six fields it always did. If the document above ever selects fewer
 * fields than this type declares, that is a bug the type will not catch; see
 * this file's header. */
type ClientGalleryListData = { galleryList: ClientGalleryListItem[] };

/** The signed-in client's own galleries, most recent session first — `[]` when
 * they have none. Same scope, same ordering and the same single query as the
 * `getGalleriesForClient` call this replaced; the resolver behind it calls
 * that exact function. */
export async function readClientGalleryList(session: Session): Promise<ClientGalleryListItem[]> {
  const data = await executeServerDocument<ClientGalleryListData>({
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
 * (see ./types/package.ts). */
const CLIENT_GALLERY_DETAIL_DOCUMENT = parse(/* GraphQL */ `
  query ClientGalleryBySlug($publicSlug: String!) {
    galleryBySlug(publicSlug: $publicSlug) {
      id
      title
      status
      sessionDate
      selectionSubmittedAt
      includedPhotosSnapshot
      extraPhotoPriceCopSnapshot
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

export type ClientGalleryDetailAsset = {
  id: string;
  originalFilename: string;
  /** The bare R2 object key, unbranded — it made a round trip through
   * Postgres and then through GraphQL, and `R2Key` survives neither. The page
   * re-attaches the brand with `storedKey()` (task #78) before presigning. */
  proofKey: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  finalKey: string | null;
  isEdited: boolean;
};

export type ClientGalleryDetail = {
  id: string;
  title: string;
  status: GalleryDetail["status"];
  sessionDate: string;
  /** An ISO string, NOT a `Date` — `Gallery.selectionSubmittedAt` resolves
   * through `.toISOString()` (see ./types/gallery.ts) because this builder has
   * no `Date` scalar registered. The page passes it straight to `<ProofGrid>`,
   * which wanted a string anyway. */
  selectionSubmittedAt: string | null;
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  package: { name: string };
  assets: ClientGalleryDetailAsset[];
};

type ClientGalleryDetailData = { galleryBySlug: ClientGalleryDetail | null };

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
  const data = await executeServerDocument<ClientGalleryDetailData>({
    document: CLIENT_GALLERY_DETAIL_DOCUMENT,
    session,
    variableValues: { publicSlug },
  });

  return data.galleryBySlug;
}

/** The documents this app executes in process, exported for
 * `client-gallery-reads.test.ts` to `validate()` against the real schema.
 * Exported ONLY for that: a caller wanting one of these should call the
 * function above it, which pairs the document with its result type. */
export const CLIENT_GALLERY_DOCUMENTS = {
  ClientGalleryList: CLIENT_GALLERY_LIST_DOCUMENT,
  ClientGalleryBySlug: CLIENT_GALLERY_DETAIL_DOCUMENT,
} as const;
