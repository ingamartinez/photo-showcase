import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Mirrors the "@/*" -> "./src/*" path mapping in tsconfig.json so unit tests
// can use the same import alias as the rest of the app.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),

      // Task #31. `server-only` is NOT an installed package in this repo
      // (`fd -HI '^server-only$' node_modules -t d` finds nothing) — Next's
      // own bundler resolves the bare specifier itself, so under Vitest it
      // resolves to nothing at all. Node-environment suites have always
      // papered over that with `vi.mock("server-only", () => ({}))`, and that
      // works because Vitest's SSR transform leaves an unresolvable bare
      // import for the module runner (where the mocker can intercept it).
      //
      // A JSDOM-environment suite cannot do the same: it is transformed in
      // web mode, where `vite:import-analysis` must resolve every import at
      // TRANSFORM time — before any `vi.mock` factory exists to intercept
      // anything. So `vi.mock("server-only", ...)` in a `.chrome.test.tsx`
      // file fails with `Failed to resolve import "server-only" from ...`,
      // which is precisely why every existing chrome suite mocks
      // `@/lib/galleries`, `@/lib/r2`, `@/lib/gallery-access` and
      // `@/lib/gallery-selection` WHOLESALE instead: cutting the import edge
      // was the only way to avoid the marker.
      //
      // That stopped being workable when the client gallery pages started
      // executing the GraphQL schema in process (task #31): `src/lib/graphql/
      // *` is server-only top to bottom, and mocking it wholesale from the
      // chrome suites would mean re-implementing the resolvers' own
      // authorization gates inside a test fake — a fake that can drift from
      // the gates it imitates, which is the one thing this epic (task #6)
      // exists to prevent.
      //
      // WHAT THIS BUYS: `import "server-only"` resolves, inertly, in every
      // environment, so a chrome suite can import server code and mock only
      // the specific modules it means to.
      //
      // WHAT THIS COSTS, stated plainly rather than left to be discovered:
      // until now a JSDOM suite that forgot to mock a MARKER-CARRYING module
      // failed LOUDLY at import time. It no longer does. `@/lib/galleries`,
      // `@/lib/gallery-access` and `@/lib/gallery-selection` are the newly
      // importable ones that matter here — each carries `import "server-only"`
      // and each queries Postgres — so a chrome suite that forgets to mock one
      // now reaches the developer's real local database instead of failing to
      // resolve. Note what is NOT part of this cost: `@/lib/db` itself carries
      // no marker and was always importable from a JSDOM suite, alias or not
      // (and importing it opens no connection either way — postgres.js
      // connects lazily, see src/lib/db/index.ts). The marker was never the
      // mechanism that enforced the server boundary in the first place —
      // `next build` is, and CI runs it — but it was a useful accident, and
      // this alias spends it.
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
  },
  test: {
    // Vitest's default is 5000ms, which is tuned for unit tests that do no
    // real work. Several suites here deliberately do: `src/lib/images.test.ts`
    // and `src/app/api/assets/[assetId]/final/route.download.test.ts` run the
    // REAL sharp pipelines over multi-megapixel fixtures, because the
    // acceptance criteria they exist for are all of the form "verify the
    // actual bytes" (tasks #14, #26, #28, #89) — a mocked sharp could not
    // prove a watermark is present, or absent.
    //
    // That default was a latent trap, not a live failure, until task #89's CI
    // run hit it: `ubuntu-latest` measured ~5x slower than a dev machine on
    // this workload (a 2.5s local test took 12.8s and 14.1s there, twice,
    // deterministically), so a test can pass on every laptop in the project
    // and fail only in CI. Raising this globally rather than annotating the
    // ~8 sharp-heavy tests individually is deliberate: a per-test timeout is
    // a rule that has to be remembered, and it WILL be forgotten on the ninth
    // one. The next person to add a real-bytes test should not have to know
    // this exists.
    //
    // 30s is chosen against the measured worst case, not by taste: after the
    // fixture fix that landed with this change the slowest test in the suite
    // is ~1.66s locally (it was ~2.5s before), so this leaves headroom for
    // a runner several times slower again than the one observed. The real
    // backstop for a genuinely hung test remains the CI job's own
    // `timeout-minutes: 10` (.github/workflows/ci.yml) — the cost of this
    // setting is only that such a test takes 30s to report instead of 5s.
    //
    // `hookTimeout` is deliberately NOT raised. It was checked rather than
    // assumed: every expensive fixture in this repo is built inside an `it`
    // body (e.g. `seedGalleryAndAsset` in the download suite is called from
    // the tests, not from its `beforeEach`, whose own work is mock resets).
    // A hook that starts needing more than 5s is a signal worth keeping.
    testTimeout: 30_000,

    // Task #117: the agent harness that runs this board creates parallel
    // slices in git worktrees under .claude/worktrees/agent-<id>/, INSIDE
    // this repo. Vitest's default `exclude` is only
    // ["**/node_modules/**", "**/.git/**"] (verified against the installed
    // v4 `configDefaults` -- it does not skip dot-directories the way
    // TypeScript's own file matcher does), so a bare `bun run test` in the
    // main checkout would otherwise collect every sibling agent's test
    // files too, including code that is mid-implementation and legitimately
    // broken. That produces a result that depends on what OTHER agents
    // happen to have on disk, which is worse than a crash: it is a wrong
    // number that looks equally plausible whether it passed by accident or
    // failed for a reason that has nothing to do with the slice under test.
    //
    // `.claude/**` (not just `.claude/worktrees/**`) is deliberately the
    // broader match: it is what eslint.config.mjs already excludes for the
    // same reason, and matching it here means this stays correct if the
    // harness ever nests worktrees one level deeper under .claude/. The
    // sibling worktrees the repo's own convention creates on purpose
    // (/Users/alejo/projects/.photo-worktrees/lane-*) live OUTSIDE the repo
    // root and are never reachable by these glob patterns in the first
    // place, so they need no entry here.
    //
    // `configDefaults.exclude` is spread in explicitly rather than assuming
    // it stays untouched: setting `exclude` at all REPLACES vitest's
    // built-in default rather than appending to it, so omitting the spread
    // would silently stop skipping node_modules and .git too.
    //
    // `e2e/**` (task #165): Playwright's own spec files under `e2e/` match
    // vitest's default `include` glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`)
    // just as readily as a vitest suite does -- both runners use the same
    // `*.spec.ts` convention. Without this exclusion, `bun run test` would
    // try to execute `e2e/dashboard.capture.spec.ts` through vitest, which
    // knows nothing about `@playwright/test`'s `test()`/`expect()` and would
    // fail outright, and worse, would trigger `e2e/global-setup.ts` never
    // (globalSetup is Playwright-specific, vitest wouldn't call it) leaving
    // the specs to seed nothing and simply throw on missing storage-state
    // files. `bun run test` and `bun run test:e2e` must stay two entirely
    // separate suites -- see this task's own hard rule.
    exclude: [...configDefaults.exclude, ".claude/**", "e2e/**"],

    // Task #136: root-causes and fixes the "Cannot use GraphQLObjectType
    // ... from another module or realm" error that #30 hit when it tried to
    // `import { graphql, printSchema } from "graphql"` DIRECTLY in a Vitest
    // file, and which never got root-caused there — #30 worked around it by
    // testing only through the real Yoga route handler (route.test.ts), with
    // `@/lib/galleries` and `@/lib/gallery-access` mocked. That test file is
    // unaffected by anything below and was deliberately left as-is.
    //
    // ROOT CAUSE (confirmed, not guessed): there is genuinely only one
    // `graphql` package under node_modules — `fd -HI '^graphql$' node_modules
    // -t d` returns exactly one hit — so this is NOT the classic "two
    // versions installed" case graphql-js's own error message assumes. The
    // real cause is a resolution-path split for the SAME package:
    // `graphql`'s package.json has no `exports` map, only `"main": "index"`
    // (-> index.js, CommonJS) and `"module": "index.mjs"` (a
    // bundler-only, non-standard field). A package with no `exports` map
    // resolved through Node/Bun's OWN native ESM/CJS resolver never looks at
    // `"module"` and always lands on `index.js`. The SAME package resolved
    // through Vite's bundler-style resolver (used for whichever imports
    // Vitest decides to run through its own transform pipeline, i.e. treats
    // as "inlined" rather than "external") prefers `"module"` and lands on
    // `index.mjs` instead. Two different files means two different
    // `GraphQLObjectType` classes, and graphql-js's own `instanceOf` check
    // (node_modules/graphql/jsutils/instanceOf.mjs) is explicitly written to
    // throw rather than silently misbehave when it sees that split.
    //
    // Before this task, EVERY consumer of `graphql` in this app's module
    // graph was "external" (Vitest's default for node_modules packages: hand
    // off to the real runtime's native resolver) EXCEPT a test file that
    // imports `graphql` directly itself, which Vitest always transforms
    // through its own pipeline because it's source, not node_modules. That
    // single test file alone was enough to create the split — no route or
    // resolver code needed to change for this error to appear.
    //
    // THE UNTRIED LEAD NAMED IN #136 (`server.deps.inline: ["graphql"]`)
    // WAS TRIED FIRST, ALONE, AND DID NOT FIX IT: forcing only `graphql`
    // itself through Vite's resolver just moves the split one level down —
    // now the test file's `graphql` (Vite-resolved, index.mjs) disagrees
    // with `@pothos/core`'s OWN internal `import ... from "graphql"`
    // (still external, native-resolved, index.js) instead. Verified by
    // reproducing both failure modes directly (see this task's report).
    //
    // THE FULL FIX has to put every package that constructs or inspects a
    // `graphql` class instance through the SAME resolver, so they all agree
    // on ONE file. That closure was found empirically, by adding packages
    // one at a time until `src/app/api/graphql/route.test.ts` (which
    // exercises the full graphql-yoga request pipeline, not just schema
    // construction) went from "graphql/@pothos/core alone fixes schema
    // building but BREAKS route.test.ts" to green.
    //
    // WHAT IS ACTUALLY PROVEN LOAD-BEARING, against the FULL suite (see the
    // methodology note below for why "full suite" is not a throwaway
    // qualifier here): `graphql`, `@pothos/core`,
    // `@graphql-yoga/plugin-disable-introspection`, and
    // `@graphql-tools/executor`. Removing any one of these four reproduces a
    // real failure somewhere in the full run — `graphql` alone breaks
    // route.test.ts (11 failures) despite doing nothing to the two files
    // that exercise `graphql` directly, because route.test.ts's own
    // introspection query hits it through a completely different call path.
    //
    // `graphql-yoga`, `@graphql-tools/schema`, and `@graphql-tools/utils`
    // are NOT individually proven necessary — the four-package list above
    // passes the full suite (93 files / 1019 tests) on its own. These three
    // are kept anyway, DELIBERATELY, as headroom rather than being trimmed:
    // they sit in the exact same graphql-yoga request-execution fan-out as
    // `@graphql-tools/executor` (see graphql-yoga's own `dependencies` in
    // its package.json), so a future graphql-yoga version bump shifting
    // which of its internal deps touches a `graphql` class identity is a
    // real, foreseeable way for this problem to resurface in a slightly
    // different shape. The cost of carrying them is close to zero (no new
    // install, this only changes which already-resolved file Vitest loads
    // for a package already in the dependency tree); the cost of trimming
    // and being wrong about it is a cold restart of this exact
    // investigation. If you are here because CI went red on a graphql-yoga
    // upgrade, `schema.test.ts` failing with graphql-js's own "another
    // module or realm" error is the trip-wire this whole comment exists to
    // explain, not a new bug.
    //
    // METHODOLOGY NOTE, IMPORTANT: minimality claims about this list are
    // only valid when checked against the FULL suite, never against
    // `schema.test.ts` and `route.test.ts` run in isolation. Running just
    // those two files gives a MISLEADING result for `graphql` itself:
    // removing it from `inline` and running only those two files still
    // passes (module-cache and run-order effects hide the split), while the
    // full suite catches the real breakage in route.test.ts. Anyone
    // revisiting this list to trim it further must re-run `bun run test`
    // (the whole suite) after every change, not just the graphql files.
    //
    // BLAST RADIUS, CHECKED: this only changes which file Vitest loads for
    // these specific packages, not what any other test resolves. Full suite
    // run before this change: 92 files / 1017 tests passing. After: still 92
    // files / 1017 tests passing, same suite, same result — this list does
    // not add, remove, or alter any existing test's outcome. See
    // src/lib/graphql/schema.test.ts for the resolver-level test this
    // unlocks, and #31/#32: this is now a solved, bounded problem, not a
    // fresh one to debug.
    server: {
      deps: {
        inline: [
          "graphql",
          "graphql-yoga",
          "@graphql-yoga/plugin-disable-introspection",
          "@pothos/core",
          "@graphql-tools/executor",
          "@graphql-tools/schema",
          "@graphql-tools/utils",
        ],
      },
    },
  },
});
