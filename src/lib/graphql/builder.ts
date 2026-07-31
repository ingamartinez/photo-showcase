// The single Pothos `SchemaBuilder` instance for this app (task #30,
// PLAN.md §7) — code-first, so every GraphQL type is a plain TypeScript
// object shape plus a `.implement()` call, not a parallel `.graphql` SDL file
// that could drift from the resolvers behind it.
//
// `Context` is `GraphQLContext` from `./context.ts` — every resolver in this
// schema receives `{ session: Session | null }` as its third argument, the
// same `Session` shape `src/lib/gallery-access.ts`'s `isGalleryOwner` and
// `src/lib/auth-guards.ts`'s guards already take.
//
// Deliberately has NO `builder.queryType({})` call here: the root `Query`
// type is declared exactly once, in `./types/query.ts`, with every field it
// exposes inline. Calling `queryType()` a second time anywhere in this module
// graph would be a Pothos error, so there is exactly one file that is allowed
// to own the root type — see that file's own header comment.
//
// ─── FIELDS ARE NON-NULL BY DEFAULT (task #32) ─────────────────────────────
// `DefaultFieldNullability: false` / `defaultFieldNullability: false`.
// Pothos v4's own default is the OPPOSITE — every field nullable unless said
// otherwise — and this schema shipped on that default by accident rather than
// by choice. Two pieces of evidence that it was an accident, not a decision:
// `./types/asset.ts`, `./types/gallery.ts` and `./types/gallery-client.ts`
// each write an explicit `nullable: true` on the three fields that genuinely
// can be null (`finalKey`, `selectionSubmittedAt`, `name`), which is a marker
// with no meaning at all if everything is already nullable; and
// `printSchema()` emitted `id: ID` and `title: String` for columns Postgres
// declares `NOT NULL`.
//
// WHY IT MATTERED ENOUGH TO CHANGE HERE, in a codegen slice: a schema that
// says every field is optional forces every consumer to guard a null the
// resolver cannot produce. Nobody paid that cost while the result types were
// hand-written, because the hand-written types (./client-gallery-reads.ts)
// simply declared the truth — `id: string`, not `id?: string | null` — and
// nothing checked them against the schema's own nullability. Generating those
// types is what turned that mismatch from invisible into a compile error, and
// there were only two ways to resolve it: teach the pages ~15 null checks for
// values that are never null, or make the schema state what the resolvers
// actually guarantee. This is the second.
//
// The safety net is Pothos's own type checker, not a promise made here: with
// this default flipped, any field whose backing TypeScript property admits
// `null`/`undefined` fails to compile unless it carries `nullable: true`. So
// "which fields are really nullable" is now answered by `tsc`, field by
// field, instead of by a blanket default. The root `gallery`/`galleryBySlug`
// fields keep their explicit `nullable: true` — see ./types/query.ts, where
// returning `null` IS the refusal.
import "server-only";

import SchemaBuilder from "@pothos/core";
import type { GraphQLContext } from "./context";

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  DefaultFieldNullability: false;
}>({ defaultFieldNullability: false });
