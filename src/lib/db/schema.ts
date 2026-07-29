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
    // A gallery's clients used to live here as a single NOT NULL FK
    // (`client_id`, `onDelete: "restrict"`). Task #94 (2026-07-29) replaced
    // that with the `galleryClients` join table below: a gallery can now
    // belong to SEVERAL clients at once (a couple's own logins, a family, two
    // businesses sharing a shoot) — see that table's own comment for the full
    // model, and src/lib/gallery-access.ts for the single ownership check
    // every route now shares instead of comparing this column directly.
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
    // Unlock audit trail (task #73) — the admin-only escape hatch that
    // replaces hand-editing `status` back to 'proofing' with a manual SQL
    // `UPDATE` against production (the exact hatch task #25's review flagged
    // as the only recovery path for a stuck `selected` gallery). Only the
    // MOST RECENT unlock is kept here (overwritten on a second unlock of the
    // same gallery) — this is "who did it and when, at minimum" per the
    // task's own acceptance criterion, not an append-only history table.
    //
    // `unlockedByEmail` stores the acting admin's OWN session email as a
    // plain snapshot at write time, not a foreign key onto `users` — same
    // "frozen fact, not a live-updating reference" reasoning as
    // `includedPhotosSnapshot`/`extraPhotoPriceCopSnapshot` above, and
    // consistent with PLAN.md §4 ("identity is the email"). A FK would need
    // a join (or a second relation to `users`, ambiguous with `clientId`'s
    // existing one) just to answer "who", for an app with exactly one admin.
    //
    // `selectionSubmittedAt` above is DELIBERATELY UNTOUCHED by an unlock —
    // see src/app/dashboard/galleries/actions.ts's `unlockSelection` for the
    // full reasoning (task #75 made it a sort key; clearing it here would
    // regress the exact discoverability problem #75 exists to fix).
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }),
    unlockedByEmail: text("unlocked_by_email"),
    // Optional — an admin unlocking mid-phone-call must never be blocked on
    // typing a note first (task #73's own scope note: "consider a reason
    // field", decided as optional).
    unlockReason: text("unlock_reason"),
  },
  (t) => [uniqueIndex("galleries_public_slug_idx").on(t.publicSlug)],
);

// The join table that replaced `galleries.clientId` (task #94, 2026-07-29):
// a gallery can now have SEVERAL clients attached to it at once — a couple's
// own separate logins into the SAME gallery, a family, two businesses
// sharing a shoot. Everyone attached shares the same rights and picks into
// the SAME shared selection (see `assets.selectedBy` below for how that
// shared selection still shows who chose what) — there is no per-client
// permission model in this slice, deliberately (kanban #94's own "Not in
// this slice").
//
// Composite primary key on the pair, same pattern as `accounts` above — this
// is what makes "attach client X to gallery Y twice" a no-op unique
// violation instead of a silent duplicate row, with no extra unique index
// needed.
//
// `userId` restricts on delete for the IDENTICAL reason the old
// `galleries.clientId` FK did: deleting a person must never silently strip a
// delivered gallery of its only link to a human. `galleryId` cascades,
// mirroring `assets.galleryId` below — if a gallery is ever deleted, its
// membership rows disappear with it, the same way its assets already do
// (there is no gallery-delete feature in this app today; this only follows
// the convention `assets.galleryId` already set, for the day one exists).
//
// A gallery with ZERO clients is unreachable BY DESIGN — `gallery-form.tsx`
// requires picking at least one at creation — but that lower bound is
// enforced at the APPLICATION layer, not here: Postgres has no built-in "at
// least one row per gallery_id" constraint short of a trigger, and there is
// no "remove the last client from a gallery" code path anywhere in this app
// yet for such a trigger to guard against. Revisit if a client-removal
// feature is ever added.
export const galleryClients = pgTable(
  "gallery_clients",
  {
    galleryId: uuid("gallery_id")
      .notNull()
      .references(() => galleries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.galleryId, t.userId] })],
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
  // WHO last set `isSelected`/`selectedAt` — task #94's "shared selection,
  // ATTRIBUTED" decision (2026-07-29, owner-approved): with several clients
  // now able to pick into the SAME shared set, an anonymous boolean is no
  // longer enough — the picker needs to show who chose each photo. This
  // stays nullable and is ALWAYS kept in lockstep with `isSelected`: set to
  // the acting session's user id the instant `isSelected` flips to `true`,
  // and cleared back to `null` the instant it flips to `false` (see the
  // PATCH /api/assets/[assetId]/selection route) — never left stale.
  //
  // DESELECTION, decided explicitly rather than left implicit: if A selects
  // a photo and B later deselects it, this column goes back to `null`, NOT
  // "B" — same lockstep as `selectedAt`, which already goes back to `null`
  // on deselect. The alternative (keep B as the last actor even though their
  // action UNDID the pick) would make `selectedBy` answer a different
  // question — "who last touched this row" instead of "who picked this photo
  // right now" — and the UI has no way to tell those two apart without a
  // second flag; showing a name next to an unselected thumbnail would read
  // as an active pick that isn't real. A true "who did what, in order" audit
  // would need a separate append-only event table, not a single column —
  // out of scope for this slice (kanban #94's own "Not in this slice").
  //
  // `onDelete: "set null"`, deliberately NOT "restrict" like
  // `gallery_clients.userId` above — different columns, different failure
  // modes if the referenced user disappears. `gallery_clients.userId`
  // restricts because deleting that row silently would strip a gallery of
  // its only remaining link to a person; there is no equivalent loss here —
  // `isSelected`/`selectedAt` stay exactly as correct with `selectedBy` wiped
  // to `null` as with it populated. Restricting here instead would mean a
  // client who is removed from a gallery (or whose account is deleted)
  // blocks that indefinitely just because they once picked a photo — a
  // stale attribution has no business holding a person's own account
  // hostage.
  selectedBy: text("selected_by").references(() => users.id, { onDelete: "set null" }),
  isEdited: boolean("is_edited").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  galleryClients: many(galleryClients),
}));

export const packagesRelations = relations(packages, ({ many }) => ({
  galleries: many(galleries),
}));

export const galleriesRelations = relations(galleries, ({ one, many }) => ({
  galleryClients: many(galleryClients),
  package: one(packages, { fields: [galleries.packageId], references: [packages.id] }),
  assets: many(assets),
}));

export const galleryClientsRelations = relations(galleryClients, ({ one }) => ({
  gallery: one(galleries, { fields: [galleryClients.galleryId], references: [galleries.id] }),
  user: one(users, { fields: [galleryClients.userId], references: [users.id] }),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  gallery: one(galleries, { fields: [assets.galleryId], references: [galleries.id] }),
  selector: one(users, { fields: [assets.selectedBy], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type Gallery = typeof galleries.$inferSelect;
export type GalleryClient = typeof galleryClients.$inferSelect;
export type Asset = typeof assets.$inferSelect;
