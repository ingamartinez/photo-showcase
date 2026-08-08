// One photo within a gallery, exposed exactly as narrow as
// `src/lib/galleries.ts`'s own `GalleryDetailAsset` shape.
//
// `proofKey`/`finalKey` are R2 OBJECT KEYS, not URLs — R2 objects are
// private, so these are never enough on their own to fetch image bytes. The
// existing presigned-URL REST routes
// (`src/app/api/assets/[assetId]/proof/route.ts`,
// `.../final/route.ts`) are still the only way to turn a key into something
// that actually loads — task #30's own "watch out": binary reads stay on
// REST, this schema only ever hands back metadata. A GraphQL client wiring
// these fields up to an `<img>` tag would need to go back through those
// routes, exactly like the current dashboard does.
import "server-only";

import { builder } from "../builder";

export type AssetRef = {
  id: string;
  originalFilename: string;
  proofKey: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  sortOrder: number;
  finalKey: string | null;
  isEdited: boolean;
  // Task #223 — the photographer deliberately delivered this photo even
  // though the client never picked it. Exposed because the client gallery
  // page reads its assets through THIS schema, and it needs the flag both to
  // decide whether a download button renders and to keep the photo out of
  // #222's collapsed "no elegidas" accordion.
  //
  // `deliveredFor` (the person attribution) is deliberately NOT exposed here.
  // It is a USER ID, and this type is what the client-facing page reads; the
  // by-person tray gets its attribution through the selection route's own
  // already-labelled channel (`SelectionPicker`), which sends a display label
  // rather than an identifier. Adding a raw user id to this schema would put
  // one on the client for no reader that exists.
  isExtra: boolean;
};

export const AssetType = builder.objectRef<AssetRef>("Asset").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    originalFilename: t.exposeString("originalFilename"),
    proofKey: t.exposeString("proofKey"),
    proofWidth: t.exposeInt("proofWidth"),
    proofHeight: t.exposeInt("proofHeight"),
    isSelected: t.exposeBoolean("isSelected"),
    sortOrder: t.exposeInt("sortOrder"),
    finalKey: t.exposeString("finalKey", { nullable: true }),
    isEdited: t.exposeBoolean("isEdited"),
    isExtra: t.exposeBoolean("isExtra"),
  }),
});
