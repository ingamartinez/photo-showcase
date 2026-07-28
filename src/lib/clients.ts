// Read-side query for the admin clients list. Server-only (used from RSC).
//
// A "client" is a `users` row with `role = "client"` — there is no separate
// `clients` table, see schema.ts's header comment for why. Gallery count is
// derived from the relation, never stored (same rule as selection counts on
// a gallery, PLAN.md §6).
import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export type ClientWithGalleryCount = {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  createdAt: Date;
  galleryCount: number;
};

/** Every client, most recently added first, each with how many galleries the
 * photographer has built for them so far. */
export async function getClientsWithGalleryCount(): Promise<ClientWithGalleryCount[]> {
  const rows = await db.query.users.findMany({
    where: eq(users.role, "client"),
    orderBy: desc(users.createdAt),
    // Only the id is needed to count — pulling full gallery rows here would
    // be wasted work for a list that only ever shows a number.
    with: { galleries: { columns: { id: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt,
    galleryCount: row.galleries.length,
  }));
}

/** Spanish, pluralized copy for the gallery count shown next to each client. */
export function formatGalleryCount(count: number): string {
  if (count === 0) return "Sin galerías todavía";
  if (count === 1) return "1 galería";
  return `${count} galerías`;
}
