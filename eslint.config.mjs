import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      "no-console": "error",
      // Identifiers prefixed with "_" are intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // CLI entry points legitimately write to stdout/stderr. Two directories, and
  // the distinction between them is load-bearing rather than cosmetic:
  //  * `scripts/` — OPS scripts (migrations, backfills, seeds). Since task #104
  //    everything here is staged to the droplet WHOLESALE by
  //    .github/workflows/deploy.yml and its import graph is verified against the
  //    release tarball. Putting a dev-only tool here means shipping it.
  //  * `tooling/` — DEV-time tools, staged by nothing (task #32). See
  //    tooling/emit-graphql-schema.ts's header for the deploy failure that
  //    established the split.
  {
    files: ["scripts/**", "tooling/**"],
    rules: {
      "no-console": "off",
    },
  },
  // Task #54: `requireApiSession()` (src/lib/auth-guards.ts) returns
  // `Session | NextResponse` rather than throwing, and a Route Handler that
  // calls it directly is trusted to correctly capture, narrow, AND return
  // the union every single time — three separate things TypeScript's own
  // `strict: true` does not enforce here, because every real handler in this
  // codebase only ever uses the session for its `.role`, checked AFTER
  // narrowing, so the un-narrowed union is never actually dereferenced in a
  // way `tsc` would flag. `withApiSession(handler)` (added by #54) makes the
  // whole class of mistake unrepresentable by construction: the check runs
  // before the handler exists to be called, and the handler receives a
  // plain `Session`. This rule is what makes going around that wrapper —
  // reintroducing the raw union into a route file — fail lint instead of
  // waiting for a reviewer to notice. `withApiSession` itself stays
  // importable everywhere; only the lower-level `requireApiSession` is
  // blocked, and only from `route.ts` files, where the wrapper is the
  // required entry point.
  {
    files: ["src/app/api/**/route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/auth-guards",
              importNames: ["requireApiSession"],
              message:
                "Route handlers must use withApiSession(handler) instead of calling requireApiSession() directly — see the file header on src/lib/auth-guards.ts (task #54) for why the direct call is a footgun the wrapper closes by construction.",
            },
          ],
        },
      ],
    },
  },
  // Task #32: `src/lib/graphql/generated/**` is written by `bun run codegen`.
  //
  // IT IS DELIBERATELY *NOT* IN `globalIgnores` BELOW. Generated or not, that
  // directory is TypeScript every client page imports, and an ignore entry is
  // a hole in the lint gate that only ever widens — the same reasoning
  // codegen.ts records for keeping it inside `format:check`. Everything ESLint
  // has to say about it is still said.
  //
  // What is turned off is one thing and nothing else: the report for an
  // `/* eslint-disable */` that turned out to disable nothing. The client
  // preset writes that directive into EVERY file it emits, unconditionally,
  // and in `graphql.ts` it currently suppresses no actual finding — so ESLint
  // 9's default `reportUnusedDisableDirectives` warns on a line no human wrote
  // and no human may edit. (In `gql.ts` the same directive IS load-bearing: it
  // covers a `(documents as any)[source]` lookup.) Leaving the warning in place
  // would mean `bun run lint` is permanently noisy, which is how a real
  // warning gets scrolled past.
  {
    files: ["src/lib/graphql/generated/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**"]),
]);

export default eslintConfig;
