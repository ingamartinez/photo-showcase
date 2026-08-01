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
import { SelectionTrayModeType } from "./selection-tray-mode";

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
    // Task #206 — closes the wiring gap #205 deliberately left open (see that
    // task's own kanban body, "Hueco de cableado que deja #205"): the price
    // was frozen in the database but stopped at this exact boundary, with
    // `use-shared-selection.ts` hardcoding `0` in its place. Exposed the same
    // way its two siblings above are — a plain `exposeInt` off the frozen
    // snapshot column, never the live `packages` row.
    originalPhotoPriceCopSnapshot: t.exposeInt("originalPhotoPriceCopSnapshot"),
    selectionTrayMode: t.expose("selectionTrayMode", { type: SelectionTrayModeType }),
    // Task #214 — whether this gallery's client may pick `original` at all
    // (task #206's own per-photo control, gated by this flag as of this
    // task). A plain `exposeBoolean` off `GalleryDetail.allowsOriginalSelection`
    // (src/lib/galleries.ts), never derived here.
    allowsOriginalSelection: t.exposeBoolean("allowsOriginalSelection"),
    assets: t.field({ type: [AssetType], resolve: (gallery) => gallery.assets }),
  }),
});
