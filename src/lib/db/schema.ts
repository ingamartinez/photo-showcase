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
  type AnyPgColumn,
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

// Task #205 — what the client asked for THIS pick to become, not whether they
// picked it at all (that is `assets.isSelected`, unchanged). Two values, on
// purpose: `edited` (today's only behavior — the photographer retouches the
// shot) and `original` (deliver it AS SHOT, no edit, at its own, cheaper
// price — see `packages.originalPhotoPriceCop`'s own comment for why it costs
// less). NOT a third state alongside "not selected" — see
// `assets.selectionKind`'s own comment for why that would be the wrong shape.
export const selectionKind = pgEnum("selection_kind", ["edited", "original"]);

// Task #204 — how the client's own "Fotos elegidas" tray lays out its picks.
// `flat` (today's only behavior) is one list, each thumbnail labelled with
// who picked it. `by-person` groups the SAME picks into one row per picker,
// each with a name and count. Purely a presentation choice: it changes
// nothing about what is selected, who owes what, or the frozen commercial
// terms above — see galleries.selectionTrayMode's own comment for why it
// carries none of #200's audit columns.
export const selectionTrayMode = pgEnum("selection_tray_mode", ["flat", "by-person"]);

// Seeded, editable without a migration (PLAN.md §3). Prices here are the CURRENT
// offer — never the terms of an existing gallery; see the snapshots below.
export const packages = pgTable("packages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  priceCop: integer("price_cop").notNull(),
  includedPhotos: integer("included_photos").notNull(),
  extraPhotoPriceCop: integer("extra_photo_price_cop").notNull(),
  // Task #205 — the price of an "original" pick: a photo the client wants
  // delivered AS SHOT, never edited. Same shape as `extraPhotoPriceCop`
  // above (the CURRENT offer, copied into a gallery's own frozen snapshot at
  // creation, never re-read after that — see `galleries.originalPhotoPriceCopSnapshot`
  // below). `notNull().default(2_000)` because packages already exist in
  // production; the owner picked this default (2026-08-01, task #205's own
  // kanban body) — cheaper than `extraPhotoPriceCop` (5_000 today), because
  // an original is less work to produce than an edit.
  originalPhotoPriceCop: integer("original_photo_price_cop").notNull().default(2_000),
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
    // Task #205 — the frozen price of an "original" pick, same shape and same
    // reasoning as `extraPhotoPriceCopSnapshot` above: copied from
    // `packages.originalPhotoPriceCop` exactly once, by `createGallery`, and
    // never re-read from `packages` afterward. `notNull().default(2_000)` —
    // there are galleries in production; the default is the SAME value
    // `packages.originalPhotoPriceCop` defaults to (that column's own
    // comment has the owner's reasoning), so every existing gallery's
    // migrated snapshot matches what its own package would have quoted it.
    // `computeQuota` (src/lib/quota.ts) only ever multiplies this by the
    // count of ORIGINAL picks, which is always 0 for every gallery that
    // exists before task #206 (the slice that lets a client choose
    // `original` at all) ships — so this column changes nothing observable
    // about any gallery's numbers today; see `assets.selectionKind` below
    // for the other half of that guarantee.
    originalPhotoPriceCopSnapshot: integer("original_photo_price_cop_snapshot")
      .notNull()
      .default(2_000),
    // Task #193 (widened by #205 to cover the third snapshot above): did the
    // admin type a manual value for any of the three snapshots above at
    // creation, instead of accepting the chosen package's terms as-is?
    // `notNull().default(false)` — there are galleries in production, and
    // every one of them created before this column existed was, definitionally,
    // never overridden.
    //
    // WRITTEN ONCE, BY `createGallery`, NEVER DERIVED. The tempting
    // alternative — comparing `includedPhotosSnapshot`/
    // `extraPhotoPriceCopSnapshot`/`originalPhotoPriceCopSnapshot` against the
    // CURRENT `packages` row for the gallery's `packageId` — looks equivalent
    // today but silently rots the
    // moment a package's price is edited (task #193's own trap): editing
    // "Estándar" from 13 to 20 included photos would make every OLD,
    // never-overridden gallery bound to it suddenly "look" overridden (its
    // frozen 13 no longer matches the live 20), and a gallery that WAS
    // overridden to exactly the package's old value would stop looking
    // overridden the instant the live row changes to match something else.
    // This is exactly the class of bug the snapshot columns above exist to
    // prevent, reintroduced through a comparison instead of a write. A flag
    // set once, at creation, and never touched again is the only shape that
    // stays true regardless of what happens to `packages` afterward.
    termsOverridden: boolean("terms_overridden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    selectionSubmittedAt: timestamp("selection_submitted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // The photo the CLIENT index (`/galleries`) uses as this gallery's 16:10
    // card cover (task #180). NOT a reference type FIELD on `portfolioCollections`
    // (which already has its own, unrelated `coverImageKey` for the PUBLIC
    // portfolio, schema.ts's own comment above) — this is the first cover
    // concept for a PRIVATE gallery.
    //
    // DECIDED BY THE OWNER (task #180, 2026-07-31): the cover is picked
    // EXPLICITLY by the photographer from among the gallery's own uploaded
    // assets. Deliberately NOT derived ("first photo", "first selected") —
    // both alternatives were on the table and the owner rejected both, so
    // this column exists precisely so the choice does not have to be
    // recomputed from asset order, which the photographer does not control
    // photo-by-photo. See `ClientGalleryListItem.coverProofKey` in this
    // file's own `getGalleriesForClient` for the read side.
    //
    // NULLABLE, and NULL is the ORDINARY state, not an edge case: every
    // gallery is created with no cover chosen (there is no admin surface in
    // THIS slice that writes this column — task #180's own card names that
    // as a follow-up, most likely #133/#134's territory, not invented here as
    // a third screen). A gallery with zero assets cannot have a cover by
    // definition, and one WITH assets simply has not had one picked yet.
    // `getGalleriesForClient`'s client-index card renders a graceful
    // text-forward fallback (task #143's own card, unchanged) whenever this
    // is `null` — see that function's own comment for the read side, and
    // src/app/galleries/page.tsx for the fallback markup.
    //
    // `onDelete: "set null"`, same reasoning as `assets.selectedBy` below:
    // deleting the underlying asset (`DELETE /api/assets/[assetId]`) must not
    // leave this column pointing at a row that no longer exists — the
    // gallery falls back to no-cover, which already renders correctly,
    // rather than the delete route needing to know about every place that
    // might reference an asset it is removing.
    //
    // Declared with a FORWARD reference to `assets` (defined further down
    // this file) rather than the other way around — safe because `assets`
    // already existed as a table before this column did (the FK constraint
    // is added in its own migration, ALTER TABLE against an already-existing
    // table, not a circular CREATE TABLE). Deliberately NOT modeled as a
    // Drizzle `relations()` entry alongside `assets: many(assets)` below:
    // this table and `assets` already have one relation pair
    // (`galleries.assets` / `assets.gallery`, via `assets.galleryId`) and
    // Drizzle requires an explicit `relationName` to disambiguate a SECOND
    // relation between the same two tables — not worth the risk of
    // destabilizing the widely-used existing pair for a single nullable
    // pointer this file only ever reads with a plain, explicit join/lookup
    // (see `getGalleriesForClient`).
    coverAssetId: uuid("cover_asset_id").references((): AnyPgColumn => assets.id, {
      onDelete: "set null",
    }),
    // Unlock audit trail (task #73) — the admin-only escape hatch that
    // replaces hand-editing `status` back to 'proofing' with a manual SQL
    // `UPDATE` against production (the exact hatch task #25's review flagged
    // as the only recovery path for a stuck `selected` gallery). Only the
    // MOST RECENT unlock is kept here (overwritten on a second unlock of the
    // same gallery) — this is "who did it and when, at minimum" per the
    // task's own acceptance criterion, not an append-only history table.
    //
    // Task #83 asked whether that is ENOUGH, since #73 framed these columns
    // as "an audit trail for a money conversation" and last-write-wins is a
    // current state, not a trail. DECIDED 2026-07-30, owner-approved:
    // last-write-wins is accepted, and no history table is built.
    //
    // The reasoning, because "we decided not to" is not a record: what an
    // overwrite destroys is the history of the PHOTOGRAPHER'S OWN unlocks.
    // The evidence a disputed money conversation actually turns on — which
    // photos were picked, when, and by whom — lives in `assets.isSelected` /
    // `selectedAt` / `selectedBy`, and an unlock touches none of it;
    // `selectionSubmittedAt` above is likewise preserved. So the only record
    // that degrades belongs to the single trusted operator, who has direct
    // database access anyway and is explicitly outside the threat model
    // (task #66, task #24's review). "The photographer reopened this twice"
    // is not something a counterparty litigates against the photographer's
    // own records.
    //
    // This also keeps the codebase consistent with itself: `assets.selectedBy`
    // below reached the same conclusion independently (task #94) — a true
    // "who did what, in order" audit needs a separate append-only event
    // table, not a column, and neither slice had a real dispute to justify
    // building one. Deciding differently here would leave two contradictory
    // answers to one question.
    //
    // Reopen if a second admin appears, or if "how many times was this
    // reopened" ever becomes the question being asked.
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
    // Terms-edit audit trail (task #200) — the SAME shape as
    // `unlockedAt`/`unlockedByEmail` above, on purpose: `termsUpdatedByEmail`
    // is the acting admin's own session email, snapshotted at write time, NOT
    // a foreign key onto `users` (identical "frozen fact, not a live-updating
    // reference" reasoning, PLAN.md §4's "identity is the email"). Only the
    // MOST RECENT edit is kept — last-write-wins, not an append-only log, same
    // scope cut task #83 already made for the unlock trail and the same
    // reasoning: the evidence a disputed money conversation actually turns on
    // is `includedPhotosSnapshot`/`extraPhotoPriceCopSnapshot` themselves
    // (the CURRENT, effective terms) plus who/when last touched them, not a
    // full history of every edit.
    //
    // Both NULLABLE, and NULL is the ORDINARY state — every gallery that has
    // never had its terms edited after creation (which is most of them) has
    // both columns NULL, including every gallery that existed before this
    // migration ran.
    termsUpdatedAt: timestamp("terms_updated_at", { withTimezone: true }),
    termsUpdatedByEmail: text("terms_updated_by_email"),
    // Task #204 — which of the two tray layouts (see `selectionTrayMode`
    // above) this gallery's client-facing view uses. `notNull().default("flat")`
    // because there are galleries in production: every one of them, created
    // before this column existed, keeps the exact layout it already had —
    // this is an additive capability switched on later, never a change to
    // what happens today (the app's own owner-set constraint on this slice).
    //
    // Presentation, not a commercial term: unlike `includedPhotosSnapshot`/
    // `extraPhotoPriceCopSnapshot`, this carries no `*UpdatedAt`/`*UpdatedByEmail`
    // audit pair. Task #200's audit columns exist because a disputed money
    // conversation can turn on "what were this gallery's terms, and who
    // changed them" — flipping how the same picks are grouped on screen is
    // not that kind of fact, and there is no dispute this column could ever
    // need to settle. Changeable by the admin at ANY gallery status
    // (src/app/dashboard/galleries/actions.ts's `updateSelectionTrayMode`) —
    // it never touches `assets.isSelected`/`selectedBy` or the snapshot
    // columns, so there is no state gate to enforce.
    selectionTrayMode: selectionTrayMode("selection_tray_mode").notNull().default("flat"),
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
// A gallery with ZERO active clients is allowed ONLY while it is still
// `draft`. Two ways to get there, both deliberate: task #97's
// `removeGalleryClient` strips the last active client off a `draft` gallery
// on purpose, and task #100 made a gallery CREATABLE with no clients at all,
// so the photographer can set the session up and upload proofs before the
// client record exists. Past `draft` the lower bound holds: a
// `proofing`/`selected`/`delivered` gallery with nobody attached is a dead
// end nobody can open.
//
// The rule — "a gallery past `draft` has at least one active client" — lives
// in ONE place, `activeClientRuleViolation()` in src/lib/galleries.ts. Its
// consumers, all of which grep as calls to that one function: the three
// server actions that can break it (`publishGallery`, `deliverGallery`,
// `removeGalleryClient` in src/app/dashboard/galleries/actions.ts) and the
// gallery detail page's two UX mirrors. No caller re-derives the condition.
//
// Enforced primarily at the APPLICATION layer — a CHECK constraint cannot
// express this (Postgres CHECKs do not span tables, and this compares
// `galleries.status` against a COUNT of sibling rows). A deferred CONSTRAINT
// TRIGGER pair (drizzle/0005_gallery-active-client-trigger.sql) enforces it
// in the database too, from BOTH sides, as a backstop against hand-written
// SQL. That backstop is not the primary check and must never become one: its
// message is diagnostic, not user-facing copy.
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
    // Task #97: removal is SOFT, decided by the owner. NULL means attached;
    // a value means removed, and records WHEN — same nullable-timestamp
    // vocabulary as `selectionSubmittedAt`/`deliveredAt`/`selectedAt` above
    // ("has this happened yet"), not a status enum for a two-state fact that
    // also wants a date (the owner's own framing).
    //
    // A row is NEVER deleted on removal — the composite PK stays the
    // identity of "this person was ever attached to this gallery", and a
    // removed row still proves that fact happened, on purpose (the owner:
    // "sigue constando que en algún momento existió").
    //
    // THIS IS THE SAFETY-CRITICAL COLUMN the whole feature rests on: every
    // query anywhere in this app that reads `gallery_clients` to answer "can
    // this person see this gallery" MUST also filter `removedAt IS NULL`, or
    // a removed client keeps every right this table grants — see
    // src/lib/gallery-access.ts's `isGalleryOwner`, `getGalleryClients` and
    // `getGalleriesForClient` in src/lib/galleries.ts, and the email
    // fan-outs in src/app/dashboard/galleries/actions.ts for the reachable
    // set this task swept for.
    //
    // Re-attaching a previously-removed client UPDATEs this same row back to
    // `NULL` (the composite PK makes a second INSERT for the same pair
    // impossible) rather than inserting a new one — see
    // `attachGalleryClients` in src/app/dashboard/galleries/actions.ts.
    //
    // NO `removed_by_email` COMPANION COLUMN, decided in task #97 (the ticket
    // asked for this call explicitly, following `galleries.unlockedByEmail`'s
    // precedent above). The two look alike and are not: `unlockedByEmail`
    // exists because an UNLOCK reopens a selection the client already
    // submitted — it reverses a commercial fact, happens during a money
    // conversation, and task #73 paired it with an optional `unlockReason`
    // precisely so the "who and why" of that reversal survives the phone
    // call. A membership removal has no counterpart: it changes nobody's
    // surcharge, reverses no client-visible commitment, and `removedAt` alone
    // already answers the only question anyone has asked of it ("is this
    // person still attached, and since when did they stop being"). With
    // exactly one admin (PLAN.md §4), a `removed_by_email` column would
    // record the same address on every row it ever held. Revisit if a second
    // admin ever exists — at that point the argument above stops holding and
    // the column earns itself.
    removedAt: timestamp("removed_at", { withTimezone: true }),
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
  // Task #205 — WHAT the client asked for this pick to become: `edited`
  // (default, today's only behavior) or `original` (delivered as shot, no
  // edit — see `packages.originalPhotoPriceCop`'s own comment). Deliberately
  // NOT merged with `isSelected` into a three-state enum ("not selected" /
  // "selected, edited" / "selected, original") — `isSelected` already answers
  // WHETHER this asset is picked, and every existing reader of that boolean
  // (tasks #24, #66, #95, #114) would need re-auditing the moment "selected"
  // stopped being a plain true/false. This column only ever answers WHAT was
  // asked for, and is meaningless while `isSelected` is `false` — the same
  // "meaningless until selected" relationship `selectedAt`/`selectedBy` above
  // already have with it.
  //
  // `notNull().default("edited")` — there are assets in production, and this
  // slice (#205) is domain + admin surfaces ONLY: nothing anywhere in the app
  // writes any value but `edited` to this column yet. The client control that
  // lets a pick actually BE `original` is task #206, the next slice.
  //
  // ONE MORE THING WORTH WRITING DOWN, because it is easy to reach for the
  // wrong mental model: this app NEVER STORES an "original" file distinct
  // from the edited one (`src/app/api/galleries/[galleryId]/proofs/route.ts`,
  // "Never stored, never referenced again once this function returns" —
  // PLAN.md's own "originals are never stored" rule). "Original" here is a
  // COMMERCIAL LABEL on what the client requested, not a second set of bytes
  // this app can serve. The photographer delivers an original pick by
  // uploading it as that asset's `finalKey`, exactly the same mechanism used
  // for an edited pick today — this column changes what it COSTS, never how
  // it is DELIVERED.
  selectionKind: selectionKind("selection_kind").notNull().default("edited"),
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
