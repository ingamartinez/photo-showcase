// Writes this app's Pothos schema out as SDL to `schema.graphql` at the repo
// root — task #32, step one of `bun run codegen`.
//
// WHY AN SDL FILE EXISTS AT ALL, when the schema is code-first and the whole
// point of Pothos is not having a second `.graphql` file that can drift:
//  1. `graphql-codegen` needs a schema it can load from a config file. The
//     real schema lives behind src/lib/graphql/schema.ts, which carries
//     `import "server-only"` and pulls in `@/lib/db` — asking codegen's own
//     config loader to import that is a resolution problem (see the plugin
//     below) better solved once, here, than inside a third-party loader.
//  2. It makes a schema change VISIBLE in a review diff. A code-first schema
//     change is a diff in a `.ts` file whose GraphQL consequence a reviewer
//     has to derive; `schema.graphql` shows the consequence itself.
// It cannot drift silently, which is the usual objection to a second file:
// src/lib/graphql/schema-sdl.test.ts fails, in the ordinary `bun run test`
// suite, if the committed file is not byte-identical to what this would write.
//
// `server-only` IS NOT AN INSTALLED PACKAGE in this repo (Next's own bundler
// resolves the bare specifier itself — see vitest.config.ts's comment on the
// same problem, which it solves with a Vite alias). So under plain Bun,
// importing anything in src/lib/graphql/** fails to RESOLVE before it runs. A
// Bun virtual module supplies the same inert stub Vitest does, registered
// BEFORE the dynamic import below so it is in place when resolution happens.
// This is a build-time tool, never part of a request path; the marker is doing
// its real job — keeping this graph out of a client bundle — in `next build`,
// which nothing here touches.
import { plugin } from "bun";
import {
  buildSchemaArtifact,
  SCHEMA_ARTIFACT_RELATIVE_PATH,
} from "../src/lib/graphql/schema-artifact";

plugin({
  name: "server-only-stub",
  setup(build) {
    build.module("server-only", () => ({ contents: "export {};", loader: "js" }));
  },
});

// Dynamic, and after `plugin()` above: a static `import` is hoisted, so it
// would try to resolve `server-only` before the stub exists. (The static
// import at the top of this file is fine — `./schema-artifact` deliberately
// carries no marker and reaches nothing that does.)
const { getSchema } = await import("../src/lib/graphql/schema");

const outputPath = new URL(`../${SCHEMA_ARTIFACT_RELATIVE_PATH}`, import.meta.url);
const artifact = buildSchemaArtifact(getSchema());

await Bun.write(outputPath, artifact);

console.log(`Wrote ${Bun.fileURLToPath(outputPath)} (${artifact.length} bytes)`);
