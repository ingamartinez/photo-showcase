// Executes this app's GraphQL schema IN PROCESS, for server components — task
// #31, and the first such call site in this codebase. `/api/graphql`
// (src/app/api/graphql/route.ts) stays exactly as it is: it is the transport
// the BROWSER uses, and task #32's Apollo Client will hit it. This module is
// the transport-free path for code that already runs inside the server.
//
// WHY NOT JUST FETCH `/api/graphql` FROM THE SERVER COMPONENT: a server
// component fetching its own route during SSR has to re-create, by hand, the
// one thing it already has — the caller's session. There is no ambient cookie
// jar on an outgoing `fetch`, so the page would have to read its own request
// cookies and forward them, and any mistake there fails OPEN or CLOSED
// silently depending on which direction it fails. Executing in process builds
// the context EXPLICITLY from a `Session` the caller already resolved through
// `requireSession()`, so there is nothing to forward and nothing to get wrong.
// It also skips an intra-process HTTP round trip per render.
//
// ─── WHAT THIS FUNCTION DOES ───────────────────────────────────────────────
//  1. Builds (once, cached — see ./schema.ts) the same `GraphQLSchema` the
//     Yoga route serves. The SAME schema object, not a second one: there is no
//     way for the in-process path and the HTTP path to disagree about which
//     fields exist or which resolvers back them.
//  2. `validate()`s the document against that schema the FIRST time it sees
//     each document object, then remembers it (see `validatedDocuments`
//     below). graphql-js's `execute()` does NOT validate on its own, and an
//     unvalidated document asking for a field the schema does not have does
//     not error — the field is silently skipped and comes back `undefined`.
//     That is the worst possible failure mode for a page reading `data.x.y`,
//     so it is turned into a thrown error here.
//  3. `execute()`s it with `contextValue: { session }` — the exact
//     `GraphQLContext` shape ./context.ts defines and every resolver already
//     expects.
//  4. Throws if execution produced any GraphQL error, rather than handing back
//     a half-populated `data`. A resolver in this schema is not supposed to
//     throw at all (refusals collapse to `null`/`[]`, see ./types/query.ts),
//     so an error here is a bug, and a page that renders around it would hide
//     it.
//
// ─── WHAT THIS FUNCTION DOES NOT DO — read this before adding a caller ─────
//  * It does NOT authorize anything. The `session` argument becomes
//    `ctx.session` verbatim, including `null`. Every resolver still runs its
//    own ownership check through the same helpers the REST routes call — that
//    is the epic's central rule (task #6) and this module deliberately adds no
//    gate of its own that a future resolver could mistake for one.
//  * It does NOT run any Yoga plugin, because it does not go through Yoga. In
//    particular the disable-introspection plugin (task #30's third acceptance
//    criterion) is NOT in this path: an introspection document passed here
//    WOULD be answered, in production too. That is acceptable only because
//    every caller is server code executing a document written in this
//    repository — never a document that arrived from a client. Do not add a
//    caller that takes its document, or any part of it, from a request.
//  * It does NOT type-check the result against the document. `TData` is
//    supplied by the caller and cast into. Until task #32's codegen exists,
//    those types are hand-written: step 2 above proves the DOCUMENT matches
//    the SCHEMA, and nothing yet proves the hand-written TypeScript matches
//    the document. Keep the result types beside their documents (see
//    ./client-gallery-reads.ts) so the two stay readable together.
//  * It does NOT batch, cache or dedupe across calls. Two calls issue two
//    executions.
import "server-only";

import { type DocumentNode, execute, validate } from "graphql";
import type { Session } from "next-auth";
import type { GraphQLContext } from "./context";
import { getSchema } from "./schema";

/** Documents already validated in this process. Keyed on the document OBJECT,
 * so a module-scope `parse(...)` constant is validated exactly once no matter
 * how many times its page renders, while a document built fresh per call would
 * be re-validated every time (correct, just not free). Weak so it can never
 * pin a document that its own module has been discarded with. */
const validatedDocuments = new WeakSet<DocumentNode>();

/**
 * Runs `document` against this app's schema with `session` in the context, and
 * returns its `data` — see this file's header for the full list of what that
 * does and does not include.
 *
 * `session` is required rather than optional, and accepts `null` explicitly,
 * so that "this caller has no session" is always a decision somebody wrote
 * down rather than an argument somebody forgot.
 */
export async function executeServerDocument<TData>({
  document,
  variableValues,
  session,
}: {
  document: DocumentNode;
  variableValues?: Record<string, unknown>;
  session: Session | null;
}): Promise<TData> {
  const schema = getSchema();

  if (!validatedDocuments.has(document)) {
    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
      throw new Error(
        `GraphQL document does not match the schema: ${validationErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    validatedDocuments.add(document);
  }

  const contextValue: GraphQLContext = { session };
  const result = await execute({ schema, document, variableValues, contextValue });

  if (result.errors && result.errors.length > 0) {
    throw new Error(
      `GraphQL execution failed: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }

  // Unreachable while the schema's root fields are all nullable-or-list and
  // its resolvers never throw (both true today, both checked by the tests
  // beside this file) — asserted rather than cast past, because `data: null`
  // with no `errors` would otherwise become `undefined` property reads inside
  // a page.
  if (result.data == null) {
    throw new Error("GraphQL execution returned no data and no errors");
  }

  return result.data as TData;
}
