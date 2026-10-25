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
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  jsonb,
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
// the billed unit's holder. `by-person` groups the SAME units into one row per
// billed person, each with a name and count. Purely a presentation choice: it
// changes
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
    // Task #231 — OPTIONAL frozen volume scale for extras, shape
    // `[{ minExtras, priceCop }]` sorted by `minExtras` (see
    // src/lib/extra-price-tiers.ts). NULL = flat price: every gallery that
    // existed before this column keeps `extraPhotoPriceCopSnapshot` exactly as
    // before. WITH a scale, THIS column is the truth and
    // `extraPhotoPriceCopSnapshot` (still notNull) just mirrors the first
    // tier's price so legacy readers never see a nonsense value.
    extraPhotoPriceTiersSnapshot: jsonb("extra_photo_price_tiers_snapshot").$type<
      { minExtras: number; priceCop: number }[]
    >(),
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
    // `onDelete: "set null"`, same reasoning as `assets.billedTo` below:
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
    // `selectedAt` / `billedTo`, and an unlock touches none of it;
    // `selectionSubmittedAt` above is likewise preserved. So the only record
    // that degrades belongs to the single trusted operator, who has direct
    // database access anyway and is explicitly outside the threat model
    // (task #66, task #24's review). "The photographer reopened this twice"
    // is not something a counterparty litigates against the photographer's
    // own records.
    //
    // This also keeps the codebase consistent with itself: `assets.billedTo`
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
    // it never touches `assets.isSelected`/`billedTo` or the snapshot
    // columns, so there is no state gate to enforce.
    selectionTrayMode: selectionTrayMode("selection_tray_mode").notNull().default("flat"),
    // Task #214 — gates whether THIS gallery's client can pick `original` at
    // all (task #206's own per-photo control). `notNull().default(false)`
    // because there are galleries in production, all of them created before
    // this column existed: the owner's OWN framing (2026-08-01, after
    // watching #206 ship) is "by default every extra photo is edited, but if
    // I turn this on, the client can choose which ones are original" — a
    // `false` default is what makes every EXISTING gallery render exactly as
    // it did before #206 shipped (see `proof-tile.tsx`'s own gate on this
    // column, `isSelected && !isLocked && allowsOriginalSelection`), rather
    // than something that was silently always-on becoming, retroactively,
    // something an admin has to remember to turn off.
    //
    // Deliberately NOT tied to `originalPhotoPriceCopSnapshot` above being
    // non-zero, and not derived from whether any asset already carries
    // `selectionKind: "original"` — a gallery can have a perfectly real
    // frozen original-photo price and this switch OFF at the same time (the
    // photographer priced it, but hasn't decided to let THIS client choose
    // yet); that is a valid state, not one this column collapses into "must
    // be true because the price exists".
    //
    // ADMIN-ONLY WRITE, no state gate: `updateAllowsOriginalSelection`
    // (src/app/dashboard/galleries/actions.ts) can flip this at any point in
    // the gallery's workflow, same as `selectionTrayMode` above — there is no
    // "too late to change your mind" moment for a presentation-adjacent
    // commercial toggle like this one.
    //
    // TURNING THIS OFF WITH ORIGINALS ALREADY PICKED is the one case that
    // needed an explicit owner decision (2026-08-01): reset every asset in
    // this gallery still marked `selectionKind: "original"` back to
    // `"edited"`, in the SAME transaction as flipping this flag to `false` —
    // see `updateAllowsOriginalSelection`'s own header comment for why an
    // off-switch that leaves orphaned `original` picks is exactly the
    // inconsistent state this decision exists to prevent, and the dialog that
    // shows the admin a before/after preview before that reset applies
    // (`AllowsOriginalSelectionControl`, src/components/).
    //
    // LISTEN/NOTIFY, DECIDED EXPLICITLY RATHER THAN LEFT IMPLICIT — TWO
    // SEPARATE FACTS, NOT ONE, because they turned out to need different
    // answers:
    //
    //   1. THIS COLUMN ITSELF does NOT travel over the `notifySelectionChanged`
    //      channel task #114 built (src/lib/selection-events.ts). That channel
    //      exists for the SHARED SELECTION — several clients picking into the
    //      same gallery at once, where a pick landing within seconds is the
    //      whole point (PLAN.md §11). This flag is an ADMIN-ONLY setting,
    //      changed rarely, from the dashboard, not from the client's own page —
    //      the same category as `includedPhotosSnapshot`/
    //      `extraPhotoPriceCopSnapshot`/`selectionTrayMode` above, none of
    //      which push over that channel either. A client with the gallery open
    //      when the admin flips this sees the change on their NEXT full page
    //      load of `/galleries/[publicSlug]` (`updateAllowsOriginalSelection`
    //      already calls `revalidatePath` for that route, same as its
    //      siblings) — not instantly, mid-session. This is an accepted
    //      staleness window, not an oversight: the money-safety property that
    //      actually matters (a client cannot buy an "original" this gallery
    //      does not allow) is enforced by the SERVER gate on
    //      `PATCH /api/assets/[assetId]/selection` regardless of what a stale
    //      tab still renders — see that route's own header comment. Revisit
    //      only if this flag starts changing mid-session often enough that the
    //      staleness itself becomes the complaint, which task #214's own
    //      kanban body gives no evidence of (production has zero galleries
    //      with any `original` picks at all as of this write).
    //
    //   2. THE RESET THIS COLUMN'S OWN OFF-SWITCH TRIGGERS is a DIFFERENT
    //      question, and the answer is the opposite: turning this off
    //      genuinely rewrites `assets.selection_kind` for every asset that was
    //      `"original"` — that IS shared-selection state, the exact thing
    //      task #114's channel exists to propagate. `updateAllowsOriginalSelection`
    //      (src/app/dashboard/galleries/actions.ts) DOES call
    //      `notifySelectionChanged` on that branch, a fourth call site
    //      alongside the PATCH toggle route, the submit route and
    //      `unlockSelection` — see that function's own "TASK #114 NOTIFY"
    //      comment for the full reasoning, including why turning the switch ON
    //      does not notify (it never touches `assets` at all).
    allowsOriginalSelection: boolean("allows_original_selection").notNull().default(false),
    // Task #244 — opt-in "rolling delivery". When true, a client of a
    // `proofing`/`selected` gallery can read every uploaded final the moment
    // it exists, instead of waiting for the whole gallery to be `delivered`
    // (src/lib/final-access.ts's `canReadFinalDeliverable` is the ONE place
    // that reads it). Default false: without it, every existing gallery would
    // expose finals the photographer uploads while still editing. Not a
    // commercial term: billing (`computeQuota`) is unaffected.
    rollingDelivery: boolean("rolling_delivery").notNull().default(false),
  },
  (t) => [uniqueIndex("galleries_public_slug_idx").on(t.publicSlug)],
);

// The join table that replaced `galleries.clientId` (task #94, 2026-07-29):
// a gallery can now have SEVERAL clients attached to it at once — a couple's
// own separate logins into the SAME gallery, a family, two businesses
// sharing a shoot. Everyone attached shares the same rights and picks into
// the SAME shared selection (see `assets.billedTo` below for how that
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
    // Epic #239 — the selection lock is PER PERSON, not per gallery. Two
    // nullable timestamps, same "has this happened yet" vocabulary as
    // `removedAt` above:
    //   - `selectionLockedAt`: non-null = this client can no longer change
    //     picks. NOBODY can undo another person's pick, locked or not: a
    //     pick is a row of `asset_picks` keyed by its owner.
    //   - `selectionSubmittedAt`: non-null = the client pressed "Enviar
    //     selección" themselves.
    // Three states follow: open (locked NULL), submitted (both set) and
    // locked by the admin (locked set, submitted NULL — slice #242).
    // Unlocking clears BOTH. The gallery moves `proofing -> selected` when it
    // has at least one active member and EVERY active member is done — no
    // unsent pick and either sent or locked (epic #250 decision 13;
    // src/lib/gallery-client-locks.ts's `settleGalleryLockStatus`). Like every
    // other read of this table, anything consulting these columns must filter
    // `removedAt IS NULL` — a removed client's lock state is history.
    selectionLockedAt: timestamp("selection_locked_at", { withTimezone: true }),
    selectionSubmittedAt: timestamp("selection_submitted_at", { withTimezone: true }),
    // Task #244 — WHO set `selectionLockedAt`, stored explicitly instead of
    // inferred from the two timestamps: under rolling delivery every order
    // sets `selectionSubmittedAt`, so "locked + submitted" no longer means
    // "the client locked themselves" (a member can order and LATER be locked
    // by the photographer). `'client'` = the classic (#239) submit, which
    // nothing writes any more (epic #250 S5: an order never locks);
    // `'admin'` = the photographer's lock, the only value written today.
    // `'client'` survives only as history in closed galleries, where the
    // gallery status already freezes every control. Always cleared together
    // with `selectionLockedAt`; null while open.
    selectionLockedBy: text("selection_locked_by", { enum: ["client", "admin"] }),
  },
  (t) => [primaryKey({ columns: [t.galleryId, t.userId] })],
);

// One row per photo. Carries both representations of the same asset: the proof
// (always present) and the final (only after the photo is selected and edited).
export const assets = pgTable(
  "assets",
  {
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
    // Epic #250 — the CLAIM stamp: when the asset's unit was claimed. It is
    // written on every claim since S4 (not only in rolling-delivery
    // galleries), and is NULL on classic claims imported by the 0017
    // backfill. NEVER use it to decide whether an asset is claimed — that is
    // `isSelected`. Carts live in `asset_picks` rows with
    // `submitted_at IS NULL`. Kept in lockstep with the claim: cleared when
    // the asset is unclaimed.
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    // Epic #250, S4 — the TS field is `billedTo`: the person this asset's
    // single billed unit is attributed to (the claim's holder, or the
    // escalation's winner). The DB column stays `selected_by`.
    //
    // WHO holds the asset's SINGLE billed unit — the claim's holder, or the
    // escalation's winner. Not "who picked it": several people may have an
    // `asset_picks` row for the same asset (decision 1), and that set of
    // askers is read from `asset_picks`, never from this column. Written only
    // by an order submit or by an admin re-resolution; a CLIENT PATCH never
    // touches `assets` (decision 7, structural).
    //
    // Nullable: a legacy unit with no recorded owner, imported by the 0017
    // backfill. It renders "Sin registro" and lands in the attribution
    // layer's matching bucket — honest, rather than a guessed name.
    //
    // `onDelete: "set null"`, deliberately NOT "restrict" like
    // `gallery_clients.userId` above — different columns, different failure
    // modes if the referenced user disappears. `gallery_clients.userId`
    // restricts because deleting that row silently would strip a gallery of
    // its only remaining link to a person; there is no equivalent loss here —
    // `isSelected`/`selectedAt` stay exactly as correct with `billedTo` wiped
    // to `null` as with it populated. Restricting here instead would mean a
    // client who is removed from a gallery (or whose account is deleted)
    // blocks that indefinitely just because they once picked a photo — a
    // stale attribution has no business holding a person's own account
    // hostage.
    billedTo: text("selected_by").references(() => users.id, { onDelete: "set null" }),
    // Epic #250 — WHEN the asset's current billed unit ARRIVED (the claim, or
    // the escalation that moved it). It orders the included photos in
    // `quota-attribution.ts` (S3, decision 6: attribution by arrival, never by
    // pick). Null whenever `isSelected` is false, i.e. the photo is unclaimed
    // (a cart) or was never picked at all. Backfilled from
    // `coalesce(requested_at, selected_at)` by task #257.
    billedAt: timestamp("billed_at", { withTimezone: true }),
    // The RESOLVED kind of the claimed unit: `edited` iff some submitted pick
    // asked for an edit (decision 3). Each person's own request lives on
    // `asset_picks.kind`, not here. `edited` (default, today's only behavior)
    // or `original` (delivered as shot, no
    // edit — see `packages.originalPhotoPriceCop`'s own comment). Deliberately
    // NOT merged with `isSelected` into a three-state enum ("not selected" /
    // "selected, edited" / "selected, original") — `isSelected` already answers
    // WHETHER this asset is picked, and every existing reader of that boolean
    // (tasks #24, #66, #95, #114) would need re-auditing the moment "selected"
    // stopped being a plain true/false. This column only ever answers WHAT was
    // asked for, and is meaningless while `isSelected` is `false` — the same
    // "meaningless until selected" relationship `selectedAt`/`billedTo` above
    // already have with it.
    //
    // `notNull().default("edited")` — there are assets in production, so a
    // migrated existing row must keep meaning exactly what it already meant.
    // Task #205 shipped the column with every existing/new row still `edited`
    // (domain + admin surfaces only, nothing wrote `original` yet). Task #206
    // is the client control that lets a pick actually BECOME `original` — see
    // `PATCH /api/assets/[assetId]/selection`'s own header comment for the
    // write path and its state gate.
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
    // Task #223 — the photographer DELIBERATELY delivered this photo even
    // though the client never picked it: a gift, a shot they liked better than
    // anything in the selection. Set by `POST /api/assets/[assetId]/final` when
    // it accepts an upload for an asset with `isSelected: false`.
    //
    // WHY THIS IS A STORED FLAG rather than derived from `finalKey IS NOT NULL
    // AND isSelected = false`, which is the shape it looks like it should have:
    // that predicate is ALSO true for a photo the client picked, the
    // photographer finished, and the claim was later UNCLAIMED (an admin
    // removal re-resolved it). `finalKey` and `isEdited` are never cleared on
    // unclaim (only `selectedAt`/`billedTo`/`billedAt` are — see those
    // columns above), so a derived rule would silently start
    // delivering discarded photos for free. That is a regression nobody asked
    // for, and no amount of care at the read sites can recover intent that was
    // never recorded. An extra is a DECISION, so it gets written down. A
    // CLIENT never clears `assets` any more; only an admin re-resolution can.
    //
    // Meaningless while `isSelected` is `true` — the same "meaningless until"
    // relationship `selectionKind`/`selectedAt`/`billedTo` above already have
    // with that boolean. Consequence worth stating plainly, because it is
    // reachable: if the photographer gifts a photo while the gallery is still
    // `proofing` and a member then CLAIMS it (sends a pick), `isSelected` wins
    // — the photo becomes an ordinary pick and counts against the package like
    // any other.
    // The client asked for it; charging for it is the honest outcome, and the
    // alternative (a pick that is silently free because of an earlier gift)
    // would make the quota unexplainable to the person paying it.
    //
    // There WAS deliberately no "clear this on delete" rule, because there was
    // no operation to hang one on: the app had no "delete just the final" path
    // — `DELETE /api/assets/[assetId]` removes the whole row (and its R2
    // objects) — so a stranded `true` on a final-less asset was unreachable
    // rather than merely unlikely. TASK #287 ADDED THAT OPERATION, so the
    // sentence above is now history rather than a rule: reopening a delivered
    // gallery clears `finalKey`, `isEdited`, `isExtra` and `deliveredFor`
    // TOGETHER on every asset of the gallery (see
    // `gallery_final_cleanup` and the reopen action), because a gift intent
    // that outlives the file it describes is stale, not harmless. Generic
    // unclaim (`pick-claims.ts`) still does NOT touch any of them — an admin
    // removing one client's pick must not discard a produced file.
    isExtra: boolean("is_extra").notNull().default(false),
    // Task #223 — WHICH PERSON a photographer-added extra (`isExtra` above)
    // belongs to, so the `by-person` tray has a row to put it in.
    //
    // WHY THIS IS NOT `billedTo`, which is the obvious place to put it: that
    // column answers "who the claimed unit is billed to" (see its own comment
    // above), is clear on an unclaimed asset, and is what the `by-person` tray
    // groups units by. Writing the photographer's choice into it would make a
    // photo NOBODY
    // picked render as somebody's active pick, and there would be no way for
    // the tray to tell the two apart. Two different questions, two columns.
    //
    // WHY NOT `isSelected` FOR THE DELIVERY ITSELF, the other tempting shortcut:
    // flipping `isSelected` on an extra would make every existing delivery path
    // work unchanged — and would BILL THE CLIENT for it. `computeQuota`
    // (src/lib/quota.ts) derives `selectedEdited` from this exact boolean and
    // charges `extraPhotoPriceCopSnapshot` per photo over the package's
    // included count. An extra is free by construction, so `isSelected` stays
    // `false` and the client-facing grid asks "is it delivered?" instead.
    //
    // Meaningless while `isExtra` is `false` — the same "meaningless until"
    // relationship `selectionKind`/`selectedAt` above already have with
    // `isSelected`, and the reason no read site consults this column without
    // checking that flag first.
    //
    // Only ever SET when the gallery's tray is `by-person`; in `flat` mode
    // there are no person rows for an extra to land in, so the admin surface
    // does not offer the choice. Staying `null` there is correct, not missing
    // data: `pickerLabelFor` already renders a null attribution as the
    // unattributed label.
    //
    // `onDelete: "set null"`, same reasoning as `billedTo` above — a client
    // removed from the gallery must not be held hostage by a stale attribution,
    // and the delivery stays exactly as valid with this wiped to `null`.
    deliveredFor: text("delivered_for").references(() => users.id, { onDelete: "set null" }),
    isEdited: boolean("is_edited").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Epic #250, task #257 — `id` is already the PK, so this index adds no
  // uniqueness of its own. It exists ONLY so `asset_picks` can hold a
  // composite `(asset_id, gallery_id)` foreign key back to this table,
  // which proves a pick's `gallery_id` is its asset's gallery. Postgres
  // accepts a unique INDEX (not just a unique CONSTRAINT) as an FK target.
  (t) => [uniqueIndex("assets_id_gallery_id_idx").on(t.id, t.galleryId)],
);

// Task #287 — THE DURABLE CLEANUP OBLIGATION of a delivered reopen.
//
// A reopen physically deletes the gallery's uploaded finals and their display
// derivatives from R2 (owner decision: "si borremos de R2, no quiero
// huérfanos"). Bytes cannot be un-deleted by a SQL rollback, so the reset
// cannot delete before it commits; it captures the exact object keys here, in
// the SAME transaction, and a later gallery-locked pass drains them. Without
// this row a process death right after the reset would lose the list forever:
// the assets survive a reopen (unlike a gallery delete), but their ids are the
// only way to derive the deterministic keys, and the old objects may be
// unreachable by any other means.
//
// One row per gallery — the PK, which is also the only lookup (`gallery_id =`)
// the action, the retry and the detail page ever do. Deliberately NO asset FK:
// deleting an asset must never erase the obligation to remove its bytes (the
// captured key already names the object). Deliberately no status/attempt/lease
// columns either: this is one purpose-specific manifest, drained synchronously,
// not a general job queue.
//
// ON DELETE RESTRICT, unlike every other referrer of `galleries.id` (those
// cascade): a parent gallery delete would otherwise silently destroy the only
// record of what still needs deleting. `deleteGallery` refuses while a
// manifest is pending and this constraint is the defence in depth.
export const galleryFinalCleanup = pgTable("gallery_final_cleanup", {
  galleryId: uuid("gallery_id")
    .primaryKey()
    .references(() => galleries.id, { onDelete: "restrict" }),
  // The exact `galleries.unlocked_at` written by the reopening transaction.
  // The drainer refuses a manifest whose epoch no longer matches the locked
  // gallery: a newer reopen owns a newer obligation and this one is stale.
  reopenEpoch: timestamp("reopen_epoch", { withTimezone: true }).notNull(),
  // Fully namespaced R2 keys, exactly as enumerated before detachment.
  remainingKeys: text("remaining_keys").array().notNull(),
});

export type GalleryFinalCleanup = typeof galleryFinalCleanup.$inferSelect;

// Epic #250, task #257 — WHO WANTS WHAT. One row per (person, photo) request:
// choosing is asking, not owning (epic #250's founder decision 1). Several
// people may pick the same photo; removing your own pick can never touch
// anyone else's. `assets` still carries the RESOLVED, single-unit truth of
// money and delivery; this table is the identity/attribution source of truth.
//
// A pick is a member's intent while `submitted_at` is null (their cart).
// Submitting stamps it, but a submitted pick is not necessarily a claim:
// several members may join the same photo, and the claim can be re-resolved
// (S5/S6). Slices S3+ derive the gallery tray, counters and surcharge from
// these rows; `fake-db.ts` (S3) is what consumes it in tests.
export const assetPicks = pgTable(
  "asset_picks",
  {
    assetId: uuid("asset_id").notNull(),
    // Denormalized on purpose: every read is per gallery, and the test double
    // does not join (fake-db.ts:3-6). The composite FK below keeps it honest.
    galleryId: uuid("gallery_id").notNull(),
    userId: text("user_id").notNull(),
    kind: selectionKind("kind").notNull().default("edited"),
    pickedAt: timestamp("picked_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    // One pick per (person, photo); a double tap is idempotent.
    primaryKey({ columns: [t.assetId, t.userId] }),
    // Composite FKs, so column-level `.references()` cannot express them.
    // Explicit names: the auto-generated name for a composite FK
    // (`asset_picks_asset_id_gallery_id_assets_id_gallery_id_fk`) is
    // unreadable, and this name is what a client-facing 23503 prints.
    foreignKey({
      name: "asset_picks_asset_fk",
      columns: [t.assetId, t.galleryId],
      foreignColumns: [assets.id, assets.galleryId],
    }).onDelete("cascade"),
    // Every picker is or was a member. Membership rows are never hard-deleted
    // (removal is soft, task #97), so CASCADE here only ever fires on a
    // manual gallery delete -- which is also why both cascade paths are set:
    // a gallery delete must never depend on RI trigger order.
    foreignKey({
      name: "asset_picks_membership_fk",
      columns: [t.galleryId, t.userId],
      foreignColumns: [galleryClients.galleryId, galleryClients.userId],
    }).onDelete("cascade"),
    // Serves "my cart" (epic). The PK serves per-asset lookups.
    index("asset_picks_gallery_user_idx").on(t.galleryId, t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Flash galleries (epic #232, slice #233): photos GIVEN AWAY as finals, with no
// proofs, no selection, no package and no price.
//
// A SEPARATE AGGREGATE, deliberately NOT a `kind` on `galleries`. Every gate
// that guards `galleries`/`assets` protects PAID deliverables
// (`canReadFinalDeliverable` demands `isSelected || isExtra` and a delivered
// status; `packageId` and the commercial snapshots are notNull;
// `computeQuota` bills off `isSelected`). Carving flash exceptions into those
// would weaken the gate on paid work. A flash gallery shares nothing
// commercial, so it shares no table: infrastructure is reused (R2 helpers,
// the display pipeline, the client picker), the model is not.
// ---------------------------------------------------------------------------
export const flashGalleries = pgTable(
  "flash_galleries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    // Optional, unlike `galleries.sessionDate`: a gift has no session.
    sessionDate: date("session_date"),
    // Unguessable, same generator as `galleries.publicSlug`. The link
    // /flash/<slug> is the ONLY thing that makes a public flash gallery
    // reachable — it is unlisted by design (epic #232).
    publicSlug: text("public_slug").notNull(),
    // Anyone with the link may view it, no login. NOT exclusive with client
    // assignment: a gallery can be public AND assigned.
    isPublic: boolean("is_public").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("flash_galleries_public_slug_idx").on(t.publicSlug)],
);

// Same model as `galleryClients` (task #94/#97): composite PK, soft removal
// through `removedAt`, re-attach UPDATEs the same row back to NULL. EVERY
// reader answering "can this person see this flash gallery" MUST filter
// `removedAt IS NULL`. `userId` restricts on delete, `flashGalleryId` cascades.
export const flashGalleryClients = pgTable(
  "flash_gallery_clients",
  {
    flashGalleryId: uuid("flash_gallery_id")
      .notNull()
      .references(() => flashGalleries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.flashGalleryId, t.userId] })],
);

// One row per gifted photo. `finalKey` holds the bytes EXACTLY as uploaded
// (task #218's byte-for-byte rule); the browsing-sized, GPS-stripped WebP
// derivative (task #89's `processDisplay`) lives at a key computed from
// (flashGalleryId, id) by `flashDisplayKey`, so only its dimensions are stored.
export const flashAssets = pgTable("flash_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  flashGalleryId: uuid("flash_gallery_id")
    .notNull()
    .references(() => flashGalleries.id, { onDelete: "cascade" }),
  originalFilename: text("original_filename").notNull(),
  finalKey: text("final_key").notNull(),
  displayWidth: integer("display_width").notNull(),
  displayHeight: integer("display_height").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flashGalleriesRelations = relations(flashGalleries, ({ many }) => ({
  clients: many(flashGalleryClients),
  assets: many(flashAssets),
}));

export const flashGalleryClientsRelations = relations(flashGalleryClients, ({ one }) => ({
  flashGallery: one(flashGalleries, {
    fields: [flashGalleryClients.flashGalleryId],
    references: [flashGalleries.id],
  }),
  user: one(users, { fields: [flashGalleryClients.userId], references: [users.id] }),
}));

export const flashAssetsRelations = relations(flashAssets, ({ one }) => ({
  flashGallery: one(flashGalleries, {
    fields: [flashAssets.flashGalleryId],
    references: [flashGalleries.id],
  }),
}));

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
  selector: one(users, { fields: [assets.billedTo], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type Gallery = typeof galleries.$inferSelect;
export type GalleryClient = typeof galleryClients.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type AssetPick = typeof assetPicks.$inferSelect;
export type FlashGallery = typeof flashGalleries.$inferSelect;
export type FlashGalleryClient = typeof flashGalleryClients.$inferSelect;
export type FlashAsset = typeof flashAssets.$inferSelect;
