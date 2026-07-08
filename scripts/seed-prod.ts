// Portfolio seed runner — used in dev (`bun db:seed`) and in production from
// the CD workflow as:
//   sudo -n -u photoshowcase bun scripts/seed-prod.ts
//
// Expects:
//   - cwd at the project (dev) or release dir (prod)
//   - Postgres reachable (dev: platform socket; prod: peer auth over
//     /var/run/postgresql, PGDATABASE=photoshowcase)
//
// Relative imports (not the "@/" alias) so it resolves in the standalone
// release, which has no tsconfig path mapping — same pattern as migrate-prod.ts.
//
// Idempotent full resync: replaces all portfolio rows with the current manifest
// state. Only the portfolio tables are touched.

import { collections } from "../src/content/portfolio";
import { db } from "../src/lib/db";
import { portfolioCollections, portfolioItems } from "../src/lib/db/schema";

function imageKey(slug: string, file: string): string {
  return `/portfolio/${slug}/${file}`;
}

async function seed(): Promise<void> {
  await db.transaction(async (tx) => {
    // Full resync: cascade clears items via the FK.
    await tx.delete(portfolioCollections);

    for (const [collectionIndex, collection] of collections.entries()) {
      const [inserted] = await tx
        .insert(portfolioCollections)
        .values({
          slug: collection.slug,
          title: collection.title,
          description: collection.description ?? null,
          coverImageKey: collection.cover ? imageKey(collection.slug, collection.cover) : null,
          sortOrder: collectionIndex,
        })
        .returning({ id: portfolioCollections.id });

      if (collection.items.length === 0) continue;

      await tx.insert(portfolioItems).values(
        collection.items.map((item, itemIndex) => ({
          collectionId: inserted.id,
          imageKey: imageKey(collection.slug, item.file),
          title: item.title ?? null,
          alt: item.alt,
          width: item.width,
          height: item.height,
          isFeatured: item.featured ?? false,
          sortOrder: itemIndex,
        })),
      );
    }
  });

  const collectionCount = collections.length;
  const itemCount = collections.reduce((sum, c) => sum + c.items.length, 0);
  console.log(`[seed] ${collectionCount} collections, ${itemCount} items`);
}

seed()
  .then(async () => {
    await db.$client.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[seed] failed:", error);
    await db.$client.end();
    process.exit(1);
  });
