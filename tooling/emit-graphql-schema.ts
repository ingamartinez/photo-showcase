// Writes this app's Pothos schema out as SDL to `schema.graphql` at the repo
// root — task #32, step one of `bun run codegen`.
//
// ═══ THIS FILE MUST NEVER MOVE UNDER `scripts/`. IT LIVED THERE ONCE AND ════
// ═══ BROKE A DEPLOY. ════════════════════════════════════════════════════════
//
// `scripts/` does not mean "a CLI entry point" in this repo. Since task #104 it
// means "ships to the droplet and must resolve there", enforced by construction
// in two places in .github/workflows/deploy.yml:
//   * the release tarball `rsync`s `scripts/` and `src/lib/` WHOLESALE, so
//     anything committed under `scripts/` reaches production whether or not it
//     has any business being there; and
//   * the step "Verify ops script import graphs resolve in the staged tarball"
//     enumerates every `scripts/*.ts` path named in package.json and runs
//     `bun build --target=bun` over it against the EXTRACTED tarball.
//
// This tool is dev-time only. It runs on a developer's machine and in CI, and
// has no reason to execute on the droplet at all — so being staged and verified
// as an ops script was never right. When it was at `scripts/emit-graphql-
// schema.ts` the gate rejected it for TWO independent reasons, and both are
// worth knowing before writing any other tool in this shape:
//
//  1. The release's `node_modules` is a HAND-CURATED OVERLAY of three packages
//     (`drizzle-orm`, `postgres`, `zod`) — not a full install, with no ancestor
//     `node_modules` to fall back on. `graphql` is a real production dependency
//     and still absent. "It is in `dependencies`" is NOT the condition for
//     resolving on the droplet; being in that overlay is.
//  2. The `plugin()` call below registers its `server-only` stub AT RUNTIME.
//     `bun build --target=bun` resolves the dynamic `import()` STATICALLY,
//     without executing a single line of top-level code, so the stub does not
//     exist during that resolution and `server-only` cannot be found. Any tool
//     that depends on a runtime-registered module stub is invisible to a static
//     bundler in exactly this way, and no amount of overlaying fixes it.
//
// `tooling/` is staged by nothing and enumerated by nothing. That is the whole
// point of the directory. If you are here to tidy this back into `scripts/`,
// the deploy gate will stop you — but it will cost a failed deploy to find out.
//
// ONE LATENT TRAP LEFT, named rather than left to be discovered: the module
// this imports, `src/lib/graphql/schema-artifact.ts`, DOES live under
// `src/lib/`, which is staged wholesale, and it imports bare `graphql`. That is
// harmless today because nothing under `scripts/` reaches it (verified with the
// gate itself, not by reading imports). The day an ops script imports anything
// from `src/lib/graphql/**`, the gate will fail on `graphql` and this paragraph
// is the explanation.
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
// import at the top of this file is fine — `schema-artifact.ts` deliberately
// carries no marker and reaches nothing that does.)
//
// NOTE that "dynamic" buys nothing against a STATIC bundler — `bun build`
// follows this edge and resolves `server-only` anyway, which is defect 2 in the
// header. It only helps at RUN time, which is the only time this tool runs.
const { getSchema } = await import("../src/lib/graphql/schema");

const outputPath = new URL(`../${SCHEMA_ARTIFACT_RELATIVE_PATH}`, import.meta.url);
const artifact = buildSchemaArtifact(getSchema());

await Bun.write(outputPath, artifact);

console.log(`Wrote ${Bun.fileURLToPath(outputPath)} (${artifact.length} bytes)`);
