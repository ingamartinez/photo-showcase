// One row of the CLIENT's own gallery index (`/galleries`, task #22) — backed
// directly by `ClientGalleryListItem` (src/lib/galleries.ts), the same shape
// that page already renders from.
//
// WHY THIS EXISTS ALONGSIDE `Gallery`, since two gallery-shaped types in one
// schema is exactly the kind of thing that needs a reason: `Gallery` is backed
// by `GalleryDetail`, which materialises every asset ROW of the gallery
// (`galleryDetailWith` in src/lib/galleries.ts). This type carries a
// `photoCount` instead, which `getGalleriesForClient` derives from an
// id-only `assets` projection in the SAME query that fetches the galleries. A
// list of 8 galleries costs one query and no asset rows here, versus two
// queries and every asset row of all 8 through `Gallery`. The difference is
// not GraphQL selection-set depth — Pothos resolves both types off a FIXED
// Drizzle projection, so asking `Gallery` for only `assets { id }` still
// fetches all nine asset columns. Until this schema has per-field resolvers
// with a dataloader, the projection is chosen by which TYPE you ask for.
//
// What is NOT duplicated between the two: the ownership rule. Both the
// `galleryList` and `galleries` fields scope to the caller through the one
// `getGalleriesForClient` in src/lib/galleries.ts — see ./query.ts.
//
// Deliberately carries NO commercial terms at all (no package, no
// `includedPhotosSnapshot`, no `extraPhotoPriceCopSnapshot`): an index row has
// no use for them, and the narrowest projection that renders the page is the
// one that cannot leak a field nobody meant to expose.
import "server-only";

import type { ClientGalleryListItem } from "@/lib/galleries";
import { builder } from "../builder";
import { GalleryStatusType } from "./gallery-status";

export const GalleryListItemType = builder
  .objectRef<ClientGalleryListItem>("GalleryListItem")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      title: t.exposeString("title"),
      publicSlug: t.exposeString("publicSlug"),
      status: t.expose("status", { type: GalleryStatusType }),
      sessionDate: t.exposeString("sessionDate"),
      /** Derived, never stored — `getGalleriesForClient` counts the rows of an
       * id-only `assets` projection. See PLAN.md's rule that selection counts
       * and their derivatives are computed, not persisted. */
      photoCount: t.exposeInt("photoCount"),
      /** Task #180 — the bare R2 key of the photographer's own explicitly-
       * picked cover photo, or `null` when none has been picked yet (the
       * ordinary state for a fresh gallery, see schema.ts's own comment on
       * `galleries.coverAssetId`). A KEY, never a presigned URL: this schema
       * never carries one, for the same reason `Gallery.assets` carries
       * `proofKey`/`finalKey` rather than a signed URL (see ./asset.ts's own
       * header, and client-gallery-reads.ts's "what deliberately does not go
       * through GraphQL"). The PAGE presigns it, the same way it already
       * presigns every other proof key it renders. */
      coverProofKey: t.exposeString("coverProofKey", { nullable: true }),
    }),
  });
