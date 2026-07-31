// Builds the GraphQL schema exactly once, on first use, and caches it —
// task #30.
//
// `builder.toSchema()` itself never reads an environment variable or touches
// the database (Pothos just walks the type refs registered by the imports
// below and produces a `GraphQLSchema` object), so calling it eagerly at
// module scope would not, on its own, fail a CI build with no application
// environment. This module still defers the call to `getSchema()`'s first
// invocation rather than doing it at the top level, for the same reason
// `src/auth.ts` made its own NextAuth config a FUNCTION instead of a plain
// object (see that file's own header comment): `next build` imports every
// route module while collecting page data, and the one thing worth never
// re-litigating per-route is whether importing a module is safe to do with
// zero application environment. Keeping schema construction behind a
// function call is what makes that true by construction here too, not by
// this module happening not to need env today.
//
// Importing `./types/query` for its side effect (registering `Query`'s
// fields via `builder.queryType()`) is required before `toSchema()` runs —
// Pothos's builder is populated by these `builder.*Type()` calls executing,
// not by anything `schema.ts` does directly.
import "server-only";

import type { GraphQLSchema } from "graphql";
import { builder } from "./builder";
import "./types/query";

let schema: GraphQLSchema | undefined;

/** The app's one GraphQL schema, built on first call and cached for every
 * request after that. */
export function getSchema(): GraphQLSchema {
  return (schema ??= builder.toSchema());
}
