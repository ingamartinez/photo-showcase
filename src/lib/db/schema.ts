// Drizzle schema for photo-showcase.
//
// Phase 1 (public portfolio): the two tables below back the curated public work.
// The private-gallery domain (clients, packages, galleries, assets) plus
// NextAuth's adapter tables land in Phase 2. See PLAN.md §6 and §10.

import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// A curated group of work (e.g. "Weddings", "Portraits"). Public, read-only.
export const portfolioCollections = pgTable(
  "portfolio_collections",
  {
    id: serial("id").primaryKey(),
    // URL segment: /work/{slug}. Stable, lowercase, unique.
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // Key/path of the image used as the collection's cover on the index grid.
    coverImageKey: text("cover_image_key"),
    // Manual ordering on the collections index (ascending).
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("portfolio_collections_slug_idx").on(t.slug)],
);

// A single photo within a collection. Served via next/image from the image key.
export const portfolioItems = pgTable("portfolio_items", {
  id: serial("id").primaryKey(),
  collectionId: integer("collection_id")
    .notNull()
    .references(() => portfolioCollections.id, { onDelete: "cascade" }),
  // Path/key of the web-optimized image. Phase 1: a /public path; may move to R2 later.
  imageKey: text("image_key").notNull(),
  // Optional human caption shown under/over the photo.
  title: text("title"),
  // Alt text — required for a11y and SEO. Never optional at the product level.
  alt: text("alt").notNull(),
  // Intrinsic dimensions: next/image needs these for path-based src to avoid CLS.
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  // Surface this photo in the home-page featured selection.
  isFeatured: boolean("is_featured").notNull().default(false),
  // Manual ordering within the collection (ascending).
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const portfolioCollectionsRelations = relations(portfolioCollections, ({ many }) => ({
  items: many(portfolioItems),
}));

export const portfolioItemsRelations = relations(portfolioItems, ({ one }) => ({
  collection: one(portfolioCollections, {
    fields: [portfolioItems.collectionId],
    references: [portfolioCollections.id],
  }),
}));

export type PortfolioCollection = typeof portfolioCollections.$inferSelect;
export type PortfolioItem = typeof portfolioItems.$inferSelect;
