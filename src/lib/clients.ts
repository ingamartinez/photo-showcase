// Read-side query for the admin clients list. Server-only (used from RSC).
//
// A "client" is a `users` row with `role = "client"` — there is no separate
// `clients` table, see schema.ts's header comment for why. Gallery count is
// derived from the relation, never stored (same rule as selection counts on
// a gallery, PLAN.md §6).
import "server-only";

import { count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleryClients, users } from "@/lib/db/schema";

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
    // Task #94: `users.galleries` (a direct `many()` off the old
    // `galleries.clientId` FK) became `users.galleryClients` (through the
    // new `gallery_clients` join table, schema.ts) — each row here is one
    // membership, i.e. one gallery this client is attached to, so counting
    // them still answers the same "how many galleries" question. Only the
    // id is needed to count — pulling full rows here would be wasted work
    // for a list that only ever shows a number.
    //
    // Task #97: `where: isNull(galleryClients.removedAt)` — a removed
    // membership is no longer one of this client's CURRENT galleries for
    // display purposes on this list, the same "removed means gone from every
    // read that matters" rule every other `gallery_clients` reader now
    // follows (src/lib/gallery-access.ts, src/lib/galleries.ts).
    with: {
      galleryClients: { where: isNull(galleryClients.removedAt), columns: { galleryId: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt,
    galleryCount: row.galleryClients.length,
  }));
}

export type ClientForPicker = { id: string; name: string | null; email: string };

/** Every client, alphabetically by name (falling back to email when a client
 * has no name) — for the gallery-creation client picker. Unlike the clients
 * list page (newest first), a picker is easier to scan sorted by name. */
export async function getClientsForPicker(): Promise<ClientForPicker[]> {
  const rows = await db.query.users.findMany({
    where: eq(users.role, "client"),
    columns: { id: true, name: true, email: true },
  });

  return [...rows].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** How many clients exist, total. Powers the "Clientes" summary on
 * `/dashboard` (task #88) — a dedicated `count()` query, same reasoning as
 * `getPendingSelectionCount` in src/lib/galleries.ts: the dashboard index
 * only needs a number, not `getClientsWithGalleryCount().length`, which
 * would pull every client row plus its gallery join just to discard
 * everything but a count. */
export async function getClientCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(users).where(eq(users.role, "client"));
  return row?.value ?? 0;
}

/** Spanish, pluralized copy for `getClientCount`'s result — the total client
 * count on `/dashboard` (task #88). Distinct from `formatClientGalleryCount`
 * in `@/lib/format` (moved out of this file by task #49 — see that module's
 * section comment), which describes how many galleries belong to ONE
 * client, not how many clients exist across the whole studio. */
export function formatClientCount(clientCount: number): string {
  if (clientCount === 1) return "1 cliente";
  return `${clientCount} clientes`;
}
