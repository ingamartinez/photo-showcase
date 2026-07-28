// Read-side query for the gallery-creation package picker. Server-only.
import "server-only";

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { packages } from "@/lib/db/schema";

/** Exactly what the picker renders — nothing more. The live terms
 * (`priceCop`, `extraPhotoPriceCop`, `durationLabel`) are deliberately absent:
 * `createGallery` reads them straight off the `packages` row it selects, and
 * every later read must come from the gallery's snapshot columns. Widening
 * this type is how live terms start leaking back into the app. */
export type PackageForPicker = {
  id: number;
  name: string;
  includedPhotos: number;
};

/** Packages a NEW gallery may be bound to. Retired packages (`active =
 * false`) are deliberately excluded — they stay attached to the galleries
 * that already reference them, but must leave the picker (schema.ts's
 * comment on `packages.active` / the task's acceptance criteria). */
export async function getActivePackages(): Promise<PackageForPicker[]> {
  const rows = await db.query.packages.findMany({
    where: eq(packages.active, true),
    orderBy: asc(packages.sortOrder),
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    includedPhotos: row.includedPhotos,
  }));
}
