// `graphql-codegen` configuration — task #32, the client half of PLAN.md §7's
// learning goal. Run it with `bun run codegen`; `bun run codegen:check` fails
// if the committed output is stale.
//
// ─── THE OUTPUT IS COMMITTED, NOT GENERATED IN CI ──────────────────────────
// Decided by the owner on #32's card, and the reason is worth keeping next to
// the config: committed output means `bun run typecheck` catches a query that
// drifted from the schema in a FRESH CLONE, with no codegen step run first,
// and no CI job becomes load-bearing for type safety. A repo that generates
// types in CI has a typecheck which is only as honest as the job ordering
// around it. The cost is a regeneration step a human has to remember, and
// that cost is paid down by `bun run codegen:check` plus
// src/lib/graphql/schema-sdl.test.ts, which fails in the normal suite if the
// SDL this reads is behind the Pothos schema.
//
// ─── WHY THE `client` PRESET AND NOT `typed-document-node` ALONE ────────────
// This is the choice that makes #32's second acceptance criterion — "typecheck
// fails if a query drifts from the schema" — actually true, so it is not a
// taste call.
//
// The `typed-document-node` plugin emits a `SomeQueryDocument` constant per
// operation, and a caller imports THAT. The query text then lives only in
// codegen's input: edit the document in the source file, forget to
// regenerate, and nothing at all happens — the imported constant is still the
// old document, and `tsc` is perfectly happy. The drift is invisible.
//
// The `client` preset instead keeps the query text at the CALL SITE, inside
// `graphql(...)`, and generates an overload of `graphql()` per known document
// string. A document string that no overload matches falls through to a
// fallback returning `unknown`, so a drifted query stops being a
// `TypedDocumentNode` and every consumer of it fails to compile. That is a
// mechanism rather than a promise, and it is the one this slice was asked to
// prove by mutation.
//
// `fragmentMasking: false`: this schema has no fragments and no component
// hierarchy asking for colocated ones (every read is a single server-component
// document, see src/lib/graphql/client-gallery-reads.ts). Generating
// `fragment-masking.ts` and routing every result through `useFragment()` would
// be ceremony over nothing.
import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  // The SDL emitted by `scripts/emit-graphql-schema.ts`, NOT a running server
  // and NOT an introspection URL. Nothing here starts the app, opens a
  // database connection, or reads an application environment variable — the
  // same constraint every route module in this repo lives under, for the same
  // reason.
  schema: "schema.graphql",

  // Every source file, because `graphql(...)` calls are allowed to live
  // wherever the code that needs them lives.
  //
  // TWO EXCLUSIONS, both deliberate:
  //  * the generated directory itself, so codegen does not read its own
  //    previous output back as input;
  //  * test files. `query.gallery-list.test.ts` and
  //    `query.gallery-by-slug.test.ts` hold `/* GraphQL */` probe documents
  //    that are ANONYMOUS on purpose (they are executed straight through
  //    `graphql()` from the `graphql` package, never named or reused), and the
  //    client preset can only generate for named operations — it skips them
  //    with a warning. Naming them just to silence the warning would put
  //    test-only operations into `generated/graphql.ts`, which every client
  //    page imports.
  //    THE TRAP THIS CREATES, so the next person does not have to guess: a
  //    `graphql(...)` call written inside a `*.test.ts` file gets no overload
  //    and comes back `unknown`. That is a compile error at the call site, not
  //    a silent wrong type, but the cause is here and not there.
  documents: [
    "src/**/*.ts",
    "src/**/*.tsx",
    "!src/lib/graphql/generated/**",
    "!src/**/*.test.ts",
    "!src/**/*.test.tsx",
  ],

  // Fail rather than shrug if the document scan comes back empty: an empty
  // scan means the glob above stopped matching, and the failure mode is a
  // `graphql()` with no overloads, which is a wall of confusing type errors
  // far from its cause.
  ignoreNoDocuments: false,

  generates: {
    "src/lib/graphql/generated/": {
      preset: "client",
      presetConfig: {
        fragmentMasking: false,
      },
      config: {
        // Plain string-literal unions, not a TypeScript `enum`. Two reasons:
        // a TS `enum` is a runtime value, and nothing in this app wants one —
        // `GalleryStatus` already exists as a union derived from Drizzle's own
        // `pgEnum` (src/lib/db/schema.ts) and the generated type has to stay
        // assignable to it, both ways, where the pages hand a status to
        // `formatGalleryStatus()` and `<ProofGrid>`.
        enumsAsTypes: true,
        // `import type { ... }` for type-only imports, matching the rest of
        // the codebase and keeping `verbatimModuleSyntax`-shaped surprises out
        // of generated code.
        useTypeImports: true,
      },
    },
  },

  // Generated TypeScript is checked by `bun run format:check` like every other
  // file in this repo — deliberately NOT added to a `.prettierignore`. An
  // ignore entry is a hole in the format gate that only ever widens, and it
  // would also mean the one directory a human never edits is the one whose
  // diffs are hardest to read. Formatting on write costs a second and keeps
  // the gate whole.
  hooks: {
    afterOneFileWrite: ["prettier --write"],
  },
};

export default config;
