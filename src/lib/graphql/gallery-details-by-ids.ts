// Task #138 introduced this module as the batched replacement for the
// `galleries` GraphQL resolver's N+1 — see `src/lib/graphql/types/query.ts`'s
// own comment on the `galleries` field for that bug. At the time, a sibling
// lane held `src/lib/galleries.ts` (task #85's `deliverGallery` region), so
// this file carried its OWN copy of `findGalleryDetail`'s private
// `with`/mapping shape rather than importing it.
//
// Task #154 folded that copy back in: `getGalleryDetailsByIds` now lives in
// `src/lib/galleries.ts`, sharing the exact `with` object and mapper
// `findGalleryDetail` uses for the single-gallery read — see that module's
// comment above `galleryDetailWith` for why that consolidation matters and
// what it does and does not buy. This file survives only as the stable
// import path `query.ts` (and this file's own query-count test,
// `gallery-details-by-ids.test.ts`) already depend on.
import "server-only";

export { getGalleryDetailsByIds } from "@/lib/galleries";
