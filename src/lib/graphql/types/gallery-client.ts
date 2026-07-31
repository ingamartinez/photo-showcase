// One of a gallery's attached clients (task #94's `galleryClients` join
// table), exposed exactly as narrow as `src/lib/galleries.ts`'s own
// `GalleryClientContact`/`GalleryDetail.clients` shape: id, name, email. For
// DISPLAY only — "which humans is this gallery for" — never itself an
// ownership decision. See `src/lib/gallery-access.ts`'s `isGalleryOwner` for
// the one function every resolver in this schema actually asks that
// question to, same as every REST route.
import "server-only";

import { builder } from "../builder";

export type GalleryClientRef = { id: string; name: string | null; email: string };

export const GalleryClientType = builder.objectRef<GalleryClientRef>("GalleryClient").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name", { nullable: true }),
    email: t.exposeString("email"),
  }),
});
