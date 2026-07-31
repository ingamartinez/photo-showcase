// Builds the exact text of `schema.graphql` — the committed SDL snapshot of
// this app's Pothos schema (task #32).
//
// WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE THE SCRIPT: two places need
// to agree byte-for-byte on what that file should contain — the writer
// (`scripts/emit-graphql-schema.ts`, run by `bun run codegen`) and the
// staleness guard (./schema-sdl.test.ts, run by `bun run test`). If the guard
// re-derived the expected text on its own it would be comparing the file
// against a second opinion, and the two opinions would drift the first time
// anyone edited the header. One function, one answer.
//
// TAKES THE SCHEMA AS AN ARGUMENT rather than calling `getSchema()` itself,
// and that is load-bearing rather than stylistic: `./schema.ts` carries
// `import "server-only"`, which is NOT an installed package in this repo (see
// vitest.config.ts's own comment on the same problem). A plain `bun run` of
// the emitter script therefore cannot statically import anything that reaches
// it — the script registers an inert stub first and then imports `./schema.ts`
// dynamically. Keeping that dance in the script means this module has no
// server-only import of its own, which is also why it is the one file in
// src/lib/graphql/ without the marker: it reads no database, no session and no
// environment, and it is only ever called by a build-time tool and a test.
import { type GraphQLSchema, printSchema } from "graphql";

/** Prepended to `schema.graphql`. GraphQL's `#` comments, so the file is still
 * a valid SDL document and codegen can read it unmodified. */
const HEADER = `# GENERATED FILE — do not edit by hand.
#
# Produced by \`bun run codegen\` from the Pothos schema in
# src/lib/graphql/**. Committed on purpose (task #32): the generated
# TypeScript beside it is committed too, so \`bun run typecheck\` catches a
# query that drifted from the schema in a fresh clone with no codegen step
# run first.
#
# src/lib/graphql/schema-sdl.test.ts fails if this file is stale.
`;

/** Where the snapshot lives, relative to the repo root. One definition, shared
 * by the writer and the guard, so neither can point at a file the other does
 * not. */
export const SCHEMA_ARTIFACT_RELATIVE_PATH = "schema.graphql";

/**
 * The full contents `schema.graphql` should have for `schema`.
 *
 * The trailing newline is not cosmetic: this file is checked by
 * `bun run format:check` like every other file in the repo (deliberately not
 * excluded — see codegen.ts on why generated output stays inside both gates),
 * and Prettier requires one.
 *
 * Stable across runs because `printSchema` walks the schema in Pothos's own
 * registration order rather than sorting or hashing anything, which is what
 * makes a byte-comparison guard meaningful instead of flaky.
 */
export function buildSchemaArtifact(schema: GraphQLSchema): string {
  return `${HEADER}\n${printSchema(schema)}\n`;
}
