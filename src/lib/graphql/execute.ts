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
//  * It does NOT batch, cache or dedupe across calls. Two calls issue two
//    executions.
//
// ─── WHERE `TData` COMES FROM (task #32 changed this) ──────────────────────
// `document` is a `TypedDocumentNode<TData, TVariables>`, so both the result
// type and the variables type are read OFF THE DOCUMENT rather than named by
// the caller. Pass a document from `./generated` (built by `bun run codegen`
// from the same schema this function executes) and there is no result type to
// write down and no way to name one that does not belong to that document.
// That closes the gap this file's header used to disclose: until #32, `TData`
// was a bare type parameter the caller supplied, and the hand-written types in
// ./client-gallery-reads.ts were checked against the schema (step 2) but never
// against their own document.
//
// TWO THINGS THAT ARE STILL TRUE AND WORTH NOT OVERCLAIMING PAST:
//  * `result.data` is still CAST to `TData` at the end of this function.
//    graphql-js's `execute()` is typed as returning an untyped `ObjMap`, so
//    what the cast trusts is the executor honouring the schema — not the
//    caller's honesty, which is the part that changed.
//  * a document that is NOT a generated one still type-checks. The type
//    carrier on `TypedDocumentNode` (`__apiType?`) is OPTIONAL, so a plain
//    `parse("...")` result is structurally assignable and simply infers
//    `TData` as `unknown` (verified, not assumed — see #32's report). That is
//    wanted rather than tolerated: two tests beside this file pass raw parsed
//    documents deliberately, one to prove step 2 rejects an unknown field and
//    one to prove a failing resolver surfaces as a throw. But it does mean
//    "the document is typed" is something a call site earns by importing from
//    `./generated`, not something this signature enforces.
import "server-only";

import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { type DocumentNode, execute, validate } from "graphql";
import type { Session } from "next-auth";
import type { GraphQLContext } from "./context";
import { getSchema } from "./schema";

/** Documents already validated in this process. Keyed on the document OBJECT,
 * so a module-scope document constant is validated exactly once no matter how
 * many times its page renders, while a document built fresh per call would be
 * re-validated every time (correct, just not free). The generated documents
 * are module-scope constants in ./generated/graphql.ts, so every page sharing
 * one shares its memo entry too. Weak so it can never pin a document that its
 * own module has been discarded with. */
const validatedDocuments = new WeakSet<DocumentNode>();

/**
 * Runs `document` against this app's schema with `session` in the context, and
 * returns its `data`, typed by the document itself — see this file's header
 * for the full list of what that does and does not include.
 *
 * `session` is required rather than optional, and accepts `null` explicitly,
 * so that "this caller has no session" is always a decision somebody wrote
 * down rather than an argument somebody forgot.
 */
export async function executeServerDocument<TData, TVariables extends Record<string, unknown>>({
  document,
  variableValues,
  session,
}: {
  document: TypedDocumentNode<TData, TVariables>;
  variableValues?: TVariables;
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

  // Defensive, and no test in this repo reaches it. `data: null` means a
  // non-nullable field failed and the null propagated all the way to the root,
  // and the GraphQL spec requires the error that caused it to be in `errors` —
  // so the branch above has already thrown by then. (Task #32 made most of
  // this schema's fields non-null, including the `galleryList`/`galleries`
  // root lists, so that propagation is possible now where it was not before;
  // the ORDER of these two checks is what keeps it a thrown error either way.)
  // Asserted rather than cast past, because `data: null` reaching a page would
  // become `undefined` property reads several frames from the cause.
  if (result.data == null) {
    throw new Error("GraphQL execution returned no data and no errors");
  }

  return result.data as TData;
}
