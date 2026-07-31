// The `Gallery` GraphQL type — backed directly by `GalleryDetail`
// (src/lib/galleries.ts), the SAME shape the admin and client gallery pages
// already render from. No parallel query is written for this type: every
// field below reads off the object `getGalleryDetail`/`getGalleryDetailBySlug`
// already assembled (clients, package, frozen snapshot terms, ordered
// assets), so there is nothing here that could drift from what the REST
// pages already show for the same gallery.
//
// `createdAt`/`selectionSubmittedAt` are exposed as ISO strings via a plain
// `resolve`, not Pothos's own `Date` scalar (not registered in this
// builder) — same "ISO string over the wire" convention the REST routes
// already use (e.g. `GET .../selection`'s `submittedAt`).
import "server-only";

import type { GalleryDetail } from "@/lib/galleries";
import { builder } from "../builder";
import { AssetType } from "./asset";
import { GalleryClientType } from "./gallery-client";
import { GalleryStatusType } from "./gallery-status";
import { PackageType } from "./package";

export const GalleryType = builder.objectRef<GalleryDetail>("Gallery").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    title: t.exposeString("title"),
    publicSlug: t.exposeString("publicSlug"),
    status: t.expose("status", { type: GalleryStatusType }),
    sessionDate: t.exposeString("sessionDate"),
    createdAt: t.string({ resolve: (gallery) => gallery.createdAt.toISOString() }),
    selectionSubmittedAt: t.string({
      nullable: true,
      resolve: (gallery) => gallery.selectionSubmittedAt?.toISOString() ?? null,
    }),
    clients: t.field({ type: [GalleryClientType], resolve: (gallery) => gallery.clients }),
    package: t.field({ type: PackageType, resolve: (gallery) => gallery.package }),
    includedPhotosSnapshot: t.exposeInt("includedPhotosSnapshot"),
    extraPhotoPriceCopSnapshot: t.exposeInt("extraPhotoPriceCopSnapshot"),
    assets: t.field({ type: [AssetType], resolve: (gallery) => gallery.assets }),
  }),
});
