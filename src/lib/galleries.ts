// Read-side query for the admin gallery list. Server-only (used from RSC).
//
// Every field returned here that describes commercial terms comes off the
// gallery row's own snapshot columns (`includedPhotosSnapshot`,
// `extraPhotoPriceCopSnapshot`) — never off the joined `package` row's live
// price/quota. That join exists only to show the package's NAME; reading its
// price here would be the exact bug the snapshot columns exist to prevent
// (see schema.ts's comment on `galleries.includedPhotosSnapshot` and the
// epic's central rule).
import "server-only";

import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleries } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";

export type GalleryWithDetails = {
  id: string;
  title: string;
  publicSlug: string;
  status: Gallery["status"];
  sessionDate: string;
  createdAt: Date;
  client: { id: string; name: string | null; email: string };
  package: { id: number; name: string };
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  photoCount: number;
};

/** Every gallery, most recently created first, with the client and package it
 * is bound to, its frozen terms, and its (derived, never stored) photo
 * count. */
export async function getGalleriesWithDetails(): Promise<GalleryWithDetails[]> {
  const rows = await db.query.galleries.findMany({
    orderBy: desc(galleries.createdAt),
    with: {
      client: { columns: { id: true, name: true, email: true } },
      package: { columns: { id: true, name: true } },
      // Only the id is needed to count — pulling full asset rows here would
      // be wasted work for a list that only ever shows a number (same
      // reasoning as getClientsWithGalleryCount in src/lib/clients.ts).
      assets: { columns: { id: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    publicSlug: row.publicSlug,
    status: row.status,
    sessionDate: row.sessionDate,
    createdAt: row.createdAt,
    client: { id: row.client.id, name: row.client.name, email: row.client.email },
    // Narrowed explicitly to id + name — even though the query only selects
    // those two columns (the `with: { package: { columns: ... } }` above),
    // this makes it impossible for a future change to that `columns` list to
    // leak the package's live price/quota through this function without
    // ALSO changing the mapping here (see this file's header comment).
    package: { id: row.package.id, name: row.package.name },
    includedPhotosSnapshot: row.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: row.extraPhotoPriceCopSnapshot,
    photoCount: row.assets.length,
  }));
}

/** Spanish copy for a gallery's workflow state (PLAN.md §2). */
export function formatGalleryStatus(status: Gallery["status"]): string {
  switch (status) {
    case "draft":
      return "Borrador";
    case "proofing":
      return "En pruebas";
    case "selected":
      return "Selección enviada";
    case "delivered":
      return "Entregada";
    case "archived":
      return "Archivada";
  }
}

/** `session_date` is stored as a plain "YYYY-MM-DD" string (no time, no
 * timezone — see schema.ts's `date("session_date")`). Formatting it via `new
 * Date(...)` would parse it as UTC midnight and can render a day off in a
 * timezone behind UTC; splitting the string avoids that entirely. */
export function formatSessionDate(sessionDate: string): string {
  const [year, month, day] = sessionDate.split("-");
  return `${day}/${month}/${year}`;
}
