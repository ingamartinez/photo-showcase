/* eslint-disable no-console -- CLI script: console is the intended output. */
// Idempotent portfolio seed. Reads src/content/portfolio.ts and mirrors it into
// the portfolio_collections / portfolio_items tables.
//
// Run with `bun db:seed`. Safe to re-run: it replaces all portfolio rows with
// the current manifest state (a full resync, not an append). Only portfolio
// tables are touched — nothing else in the DB.

import { collections } from "@/content/portfolio";
import { db } from "./index";
import { portfolioCollections, portfolioItems } from "./schema";

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
  console.log(`Seeded ${collectionCount} collections, ${itemCount} items.`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
