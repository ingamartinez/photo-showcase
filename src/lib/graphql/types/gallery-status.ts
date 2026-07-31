// GraphQL enum for `galleries.status` — task #30.
//
// Reuses `galleryStatus.enumValues` (Drizzle's own `pgEnum` export, schema.ts)
// rather than re-typing the five literal strings a second time: the exact
// "don't duplicate a rule that already exists" concern schema.ts's own
// comments on `galleries` raise for this codebase's other repeated-list bugs
// (kanban #86/#87/#88/#91/#96). If a status is ever added to the Postgres
// enum, this GraphQL enum grows with it automatically instead of silently
// missing a value.
import "server-only";

import { galleryStatus } from "@/lib/db/schema";
import { builder } from "../builder";

export const GalleryStatusType = builder.enumType("GalleryStatus", {
  values: galleryStatus.enumValues,
});
