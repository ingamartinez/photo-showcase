// Builds the exact text of `schema.graphql` — the committed SDL snapshot of
// this app's Pothos schema (task #32).
//
// WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE THE TOOL: two places need
// to agree byte-for-byte on what that file should contain — the writer
// (`tooling/emit-graphql-schema.ts`, run by `bun run codegen`) and the
// staleness guard (./schema-sdl.test.ts, run by `bun run test`). If the guard
// re-derived the expected text on its own it would be comparing the file
// against a second opinion, and the two opinions would drift the first time
// anyone edited the header. One function, one answer.
//
// IT LIVES UNDER src/lib/ AND THAT HAS A COST WORTH NAMING. src/lib/ is
// `rsync`ed into the release tarball WHOLESALE (.github/workflows/deploy.yml),
// so THIS module reaches the droplet, where the bare `graphql` it imports below
// cannot be resolved: the release's `node_modules` holds only what Next's
// standalone tracing left for the app's routes plus a three-package overlay
// (`drizzle-orm`, `postgres`, `zod`), and no route reaches `graphql` either.
//
// So the rule for an ops script under scripts/ is NOT "avoid src/lib/graphql/**"
// — it is "avoid any staged src/lib module that imports a bare package the
// release does not ship". This file is one. The three files under ./generated/
// are NOT, even though they name `@graphql-typed-document-node/core`, which is
// equally unshipped: their only external import is `import type`, and Bun erases
// that, so nothing has to resolve. Stating the rule this way rather than
// carving out `generated/**` keeps it true when a new generated file lands.
//
// Nothing under scripts/ reaches this module today, verified by running that
// workflow's own "Verify ops script import graphs" step locally rather than by
// reading import lines — and #32's re-review established that the step is a
// faithful proxy in BOTH directions (a probe script reaching here fails the
// gate AND fails for real in the extracted tarball; one reaching ./generated/
// passes both). It stays here anyway because ./schema-sdl.test.ts imports it,
// and a test under src/ importing from tooling/ would be the wrong direction.
//
// TAKES THE SCHEMA AS AN ARGUMENT rather than calling `getSchema()` itself,
// and that is load-bearing rather than stylistic: `./schema.ts` carries
// `import "server-only"`, which is NOT an installed package in this repo (see
// vitest.config.ts's own comment on the same problem). A plain `bun run` of
// the emitter therefore cannot statically import anything that reaches
// it — the tool registers an inert stub first and then imports `./schema.ts`
// dynamically. Keeping that dance in the tool means this module has no
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
 * Stable across runs, which is what makes a byte-comparison guard meaningful
 * instead of flaky — and the reason is worth naming correctly, because an
 * earlier version of this comment named the wrong component and drew a weaker
 * conclusion from it. `printSchema` emits whatever order it is handed;
 * `builder.toSchema()` is what imposes one, because Pothos defaults
 * `sortSchema` to `true`. Verified rather than inferred: with
 * `toSchema({ sortSchema: false })` this app's SDL leads with
 * `enum GalleryStatus` and prints `Asset`'s fields in the order ./types/asset.ts
 * registers them (`id, originalFilename, proofKey, …`), against the committed
 * file's alphabetical `Asset` first and `finalKey, id, isEdited, …`.
 *
 * That is a STRONGER stability guarantee than registration order would be, not
 * a weaker one: the artifact is order-INDEPENDENT, so moving a field or a type
 * declaration around in src/lib/graphql/types/** cannot produce a diff here at
 * all. The flip side is a real limit on what ./schema-sdl.test.ts can see —
 * see that file, where it is stated.
 */
export function buildSchemaArtifact(schema: GraphQLSchema): string {
  return `${HEADER}\n${printSchema(schema)}\n`;
}
