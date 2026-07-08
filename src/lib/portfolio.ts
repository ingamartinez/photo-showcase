// Read-side queries for the public portfolio. Server-only (used from RSC).
import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { portfolioCollections, portfolioItems } from "@/lib/db/schema";
import type { PortfolioItem } from "@/lib/db/schema";

export type CollectionSummary = {
  slug: string;
  title: string;
  description: string | null;
  coverImageKey: string | null;
  itemCount: number;
};

/** All collections in display order, each with its cover and item count. */
export async function getCollections(): Promise<CollectionSummary[]> {
  const rows = await db.query.portfolioCollections.findMany({
    orderBy: asc(portfolioCollections.sortOrder),
    with: { items: { columns: { id: true } } },
  });
  return rows.map((c) => ({
    slug: c.slug,
    title: c.title,
    description: c.description,
    coverImageKey: c.coverImageKey,
    itemCount: c.items.length,
  }));
}

export type ItemWithCollection = PortfolioItem & {
  collection: { slug: string; title: string };
};

/** Featured items across all collections, for the home work grid. */
export async function getFeaturedItems(limit = 12): Promise<ItemWithCollection[]> {
  const rows = await db.query.portfolioItems.findMany({
    where: eq(portfolioItems.isFeatured, true),
    orderBy: [asc(portfolioItems.collectionId), asc(portfolioItems.sortOrder)],
    with: { collection: { columns: { slug: true, title: true } } },
    limit,
  });
  return rows;
}

export type CollectionDetail = {
  slug: string;
  title: string;
  description: string | null;
  items: PortfolioItem[];
};

/** One collection with all its items, for /work/{slug}. */
export async function getCollectionBySlug(slug: string): Promise<CollectionDetail | null> {
  const row = await db.query.portfolioCollections.findFirst({
    where: eq(portfolioCollections.slug, slug),
    with: { items: { orderBy: asc(portfolioItems.sortOrder) } },
  });
  if (!row) return null;
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    items: row.items,
  };
}
