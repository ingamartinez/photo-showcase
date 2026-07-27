// Drizzle schema for photo-showcase.
//
// Phase 1 (public portfolio): the portfolio tables back the curated public work.
// Phase 2 (private galleries): identity + domain tables, see PLAN.md §6.
//
// Identity deviates from PLAN.md §6 on purpose: the plan had a separate
// `clients` table alongside NextAuth's `users`. Magic-link auth requires the
// Auth.js database adapter, so `users` exists unconditionally — keeping both
// would mean two rows keyed by email for the same human, and an email fixed in
// only one of them silently revokes that client's access. One identity table
// with a role instead.

import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

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

// ---------------------------------------------------------------------------
// Identity — Auth.js adapter tables + our role model
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", ["admin", "client"]);

// The single identity table. Ids are text UUIDs because that is what the Drizzle
// adapter generates; do not switch to serial (findash uses serial, but it has no
// adapter — Google OAuth with its own users table — so that pattern doesn't
// transfer here).
export const users = pgTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name"),
    email: text("email").notNull(),
    // Set by Auth.js when a magic link is consumed.
    emailVerified: timestamp("email_verified", { withTimezone: true, mode: "date" }),
    image: text("image"),
    role: userRole("role").notNull().default("client"),
    // WhatsApp number — delivery notifications happen outside the app.
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Email IS the identity: the adapter looks users up by it on every magic-link
  // sign-in. Without this constraint a race could create two rows for one person.
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

// Required by the adapter's signature. Stays permanently empty: there are no
// OAuth providers, only the email/magic-link provider.
export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

// Database session strategy: one lookup per request, but revoking a client's
// access takes effect immediately instead of waiting for a JWT to expire.
export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
});

// Magic-link tokens. Single-use: Auth.js deletes the row when it is consumed.
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ---------------------------------------------------------------------------
// Gallery domain
// ---------------------------------------------------------------------------

export const galleryStatus = pgEnum("gallery_status", [
  "draft",
  "proofing",
  "selected",
  "delivered",
  "archived",
]);

// Seeded, editable without a migration (PLAN.md §3). Prices here are the CURRENT
// offer — never the terms of an existing gallery; see the snapshots below.
export const packages = pgTable("packages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  priceCop: integer("price_cop").notNull(),
  includedPhotos: integer("included_photos").notNull(),
  extraPhotoPriceCop: integer("extra_photo_price_cop").notNull(),
  // Human-facing session length, e.g. "1.5–2 h". Display only.
  durationLabel: text("duration_label").notNull(),
  // Retired packages stay for historical galleries but leave the picker.
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const galleries = pgTable(
  "galleries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id")
      .notNull()
      // Restrict, not cascade: deleting a person must never silently take their
      // delivered galleries with it.
      .references(() => users.id, { onDelete: "restrict" }),
    packageId: integer("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    sessionDate: date("session_date").notNull(),
    status: galleryStatus("status").notNull().default("draft"),
    // The only identifier that appears in a URL. Unguessable — sequential ids
    // in the URL would let anyone walk other clients' galleries.
    publicSlug: text("public_slug").notNull(),
    // Commercial terms frozen at creation. Editing a package price must never
    // retroactively change what a past client owed.
    includedPhotosSnapshot: integer("included_photos_snapshot").notNull(),
    extraPhotoPriceCopSnapshot: integer("extra_photo_price_cop_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    selectionSubmittedAt: timestamp("selection_submitted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("galleries_public_slug_idx").on(t.publicSlug)],
);

// One row per photo. Carries both representations of the same asset: the proof
// (always present) and the final (only after the photo is selected and edited).
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  galleryId: uuid("gallery_id")
    .notNull()
    .references(() => galleries.id, { onDelete: "cascade" }),
  originalFilename: text("original_filename").notNull(),
  // R2 object keys, private. Served to clients via short-lived presigned URLs.
  proofKey: text("proof_key").notNull(),
  finalKey: text("final_key"),
  // Proof dimensions after downscaling — the grid needs them to reserve space.
  proofWidth: integer("proof_width").notNull(),
  proofHeight: integer("proof_height").notNull(),
  isSelected: boolean("is_selected").notNull().default(false),
  selectedAt: timestamp("selected_at", { withTimezone: true }),
  isEdited: boolean("is_edited").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  galleries: many(galleries),
}));

export const packagesRelations = relations(packages, ({ many }) => ({
  galleries: many(galleries),
}));

export const galleriesRelations = relations(galleries, ({ one, many }) => ({
  client: one(users, { fields: [galleries.clientId], references: [users.id] }),
  package: one(packages, { fields: [galleries.packageId], references: [packages.id] }),
  assets: many(assets),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  gallery: one(galleries, { fields: [assets.galleryId], references: [galleries.id] }),
}));

export type User = typeof users.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type Gallery = typeof galleries.$inferSelect;
export type Asset = typeof assets.$inferSelect;
