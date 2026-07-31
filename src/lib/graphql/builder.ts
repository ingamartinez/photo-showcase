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
import "server-only";

import SchemaBuilder from "@pothos/core";
import type { GraphQLContext } from "./context";

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
}>({});
