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
  // CLI scripts (migrations, backfills) legitimately write to stdout/stderr.
  {
    files: ["scripts/**"],
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
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**"]),
]);

export default eslintConfig;
