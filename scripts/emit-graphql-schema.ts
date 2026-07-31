// Writes this app's Pothos schema out as SDL to `schema.graphql` at the repo
// root — task #32, step one of `bun run codegen`.
//
// WHY AN SDL FILE EXISTS AT ALL, when the schema is code-first and the whole
// point of Pothos is not having a second `.graphql` file that can drift:
//  1. `graphql-codegen` needs a schema it can load from a config file. The
//     real schema lives behind `src/lib/graphql/schema.ts`, which carries
//     `import "server-only"` and pulls in `@/lib/db` — asking codegen's own
//     config loader to import that is a resolution problem (see the plugin
//     below) solved once here instead of inside a third-party loader.
//  2. It makes a schema change VISIBLE in a review diff. A code-first schema
//     change is a diff in a `.ts` file whose GraphQL consequence a reviewer
//     has to derive; `schema.graphql` shows the consequence itself.
// It cannot drift silently, which is the usual objection to a second file:
// `src/lib/graphql/schema-sdl.test.ts` fails if the committed SDL is not
// byte-identical to `printSchema(getSchema())`.
//
// `server-only` IS NOT AN INSTALLED PACKAGE in this repo (Next's own bundler
// resolves the bare specifier itself — see vitest.config.ts's own comment on
// the same problem, which it solves with a Vite alias). So under plain Bun,
// importing anything in `src/lib/graphql/**` fails to resolve before it runs.
// A Bun virtual module supplies the same inert stub Vitest does, registered
// BEFORE the dynamic import below so it is in place when resolution happens.
// This is a build-time tool, never part of a request path; the marker is
// doing its real job (keeping this graph out of a client bundle) in
// `next build`, which is untouched by anything here.
import { plugin } from "bun";
import { printSchema } from "graphql";

plugin({
  name: "server-only-stub",
  setup(build) {
    build.module("server-only", () => ({ contents: "export {};", loader: "js" }));
  },
});

// Dynamic, and after `plugin()` above: a static `import` is hoisted and would
// resolve `server-only` before the stub is registered.
const { getSchema } = await import("../src/lib/graphql/schema");

const OUTPUT_PATH = new URL("../schema.graphql", import.meta.url);

// `printSchema` sorts nothing by itself — Pothos's own builder emits types in
// a stable order (registration order, then alphabetical within a type), which
// is what makes a byte-comparison test on this file meaningful rather than
// flaky.
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

// The trailing newline is not cosmetic: `schema.graphql` is checked by
// `bun run format:check` like every other file in this repo (deliberately not
// added to a `.prettierignore` — see codegen.ts on why generated output stays
// inside the format gate), and Prettier requires one.
const sdl = `${HEADER}\n${printSchema(getSchema())}\n`;

await Bun.write(OUTPUT_PATH, sdl);

console.log(`Wrote ${Bun.fileURLToPath(OUTPUT_PATH)} (${sdl.length} bytes)`);
