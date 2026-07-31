// The package a gallery is bound to, exposed exactly as narrow as
// `src/lib/galleries.ts`'s own `GalleryDetail.package` field: id + name only.
//
// NEVER the package's live `priceCop`/`includedPhotos`/`extraPhotoPriceCop` —
// those describe today's offer, not what THIS gallery's client actually
// agreed to. A gallery's own frozen terms (`includedPhotosSnapshot`,
// `extraPhotoPriceCopSnapshot`) already live directly on the `Gallery` type;
// exposing the live package's price here would be exactly the "retroactively
// change what a past client owed" bug schema.ts's comment on
// `galleries.includedPhotosSnapshot` and PLAN.md's central rule both warn
// against, so this type has no field that could even accidentally read it.
import "server-only";

import { builder } from "../builder";

export type PackageRef = { id: number; name: string };

export const PackageType = builder.objectRef<PackageRef>("Package").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
  }),
});
