// POST/GET /api/graphql — GraphQL Yoga mounted on a Next.js Route Handler,
// serving the Pothos schema built in src/lib/graphql/schema.ts (task #30,
// PLAN.md §7).
//
// SCOPE: reads only — galleries and assets for the signed-in user (see
// src/lib/graphql/types/query.ts). Binary uploads stay on REST, exactly as
// PLAN.md §7 and this task's own "watch out" require; nothing in this schema
// accepts a file, and nothing hands back more than an R2 object KEY (never a
// presigned URL) — see src/lib/graphql/types/asset.ts's own header comment.
// Mutations, and moving the DASHBOARD's existing REST reads onto this
// endpoint, are explicitly NOT this slice (task #31/#32) — this file exists
// to prove the server and the auth context are correct, on a small,
// deliberately narrow graph.
//
// LAZY CONSTRUCTION, ON PURPOSE: `next build` imports every route module
// while collecting page data, and CI builds with no application environment
// at all. `getYoga()` below is not called until the first real request
// reaches `GET`/`POST` — nothing at this file's module scope reads an env
// var, opens a database connection of its own, or calls `auth()`. (`@/lib/db`
// IS imported transitively, through `getSchema()` → `./types/query` →
// `@/lib/galleries`/`@/lib/gallery-access` — but that module already
// constructs its `postgres()` client lazily/non-throwing at import time, the
// same way every existing route that imports it does; see src/lib/db/index.ts.
// What this file specifically must never do is add a SECOND env-reading
// construction path — the Yoga server itself, and the schema it wraps — both
// deferred behind a function call.)
import { createYoga, type YogaServerInstance } from "graphql-yoga";
// Imported under a non-`use*` alias: this is an Envelop/Yoga PLUGIN factory,
// not a React Hook, but its real export name (`useDisableIntrospection`)
// matches `eslint-plugin-react-hooks`'s naming heuristic closely enough that
// `bun run lint` flags the call site as "React Hook called outside a
// component" if imported verbatim.
import { useDisableIntrospection as disableIntrospectionPlugin } from "@graphql-yoga/plugin-disable-introspection";
import type { NextRequest } from "next/server";
import { createGraphQLContext, type GraphQLContext } from "@/lib/graphql/context";
import { getSchema } from "@/lib/graphql/schema";

export const runtime = "nodejs";

// A session-scoped read must never be served from a cache — same reasoning
// as the selection route's own `force-dynamic` (src/app/api/galleries/
// [galleryId]/selection/route.ts): a 30-second CDN or router cache here could
// hand one client back a snapshot of ANOTHER client's response.
export const dynamic = "force-dynamic";

type Yoga = YogaServerInstance<Record<string, never>, GraphQLContext>;

let yoga: Yoga | undefined;

/** Constructs the Yoga server on first call, then reuses it — see the file
 * header for why this must not happen at module scope. */
function getYoga(): Yoga {
  if (!yoga) {
    yoga = createYoga<Record<string, never>, GraphQLContext>({
      schema: getSchema(),
      graphqlEndpoint: "/api/graphql",
      // Session comes from the request itself (via NextAuth's own request-
      // scoped `auth()`, see src/lib/graphql/context.ts) — nothing here needs
      // the raw Next.js server context, so the second `handleRequest`
      // argument below is always `{}`.
      context: createGraphQLContext,
      // Task #30's acceptance criterion: introspection is disabled in
      // production. `process.env.NODE_ENV` is read inside this callback —
      // invoked per-request by the plugin, not at module or `getYoga()`-call
      // scope — so this still never runs during `next build`'s page-data
      // collection, and is always the real runtime value once a request
      // actually arrives. Development and CI test runs keep introspection on
      // (`NODE_ENV` is `"test"` under Vitest), which is what lets
      // `schema.test.ts` query `__schema` directly to prove this switch
      // itself works.
      plugins: [
        disableIntrospectionPlugin({
          isDisabled: () => process.env.NODE_ENV === "production",
        }),
      ],
      // GraphiQL is harmless to leave enabled outside production — it only
      // renders when a browser (not a `fetch()` client) opens the endpoint —
      // but there is no reason to ship it to the real deployment either.
      graphiql: process.env.NODE_ENV !== "production",
    });
  }
  return yoga;
}

export async function GET(request: NextRequest): Promise<Response> {
  return getYoga().handleRequest(request, {});
}

export async function POST(request: NextRequest): Promise<Response> {
  return getYoga().handleRequest(request, {});
}
