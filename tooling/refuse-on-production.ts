// Guards the local visual-capture harness (task #165) against ever seeding a
// session into a database that could be production's.
//
// LIVES UNDER `tooling/`, NOT `e2e/lib/`, ON PURPOSE: `vitest.config.ts`
// excludes the whole `e2e/**` tree (task #165's own requirement, so `bun run
// test` never tries to boot a Playwright spec or its `globalSetup`) — a
// mutation-tested, load-bearing exclusion the #165 review confirmed and
// asked not to be touched. A `.test.ts` file placed anywhere under `e2e/`
// would therefore silently never run under `bun run test`, which is worse
// than no test at all for exactly the safety-critical function this file
// exports. `tooling/` is the correct home for the SAME reason
// `tooling/emit-graphql-schema.ts` lives here and not under `scripts/`: this
// is dev/test-time-only code (see that file's own header) that never needs
// to run, or even resolve, on the droplet — `scripts/` means "staged to
// production wholesale" since task #104, and this guard has no business
// being shipped there.
//
// THE BUG THIS FILE'S FIRST VERSION HAD, FOUND BY THE #165 REVIEW: a guard
// that only refused when `APP_ENV === "production"` FAILS OPEN exactly in
// the dangerous case — an admin SSH'd onto the droplet with a shell that
// never sourced `release.env` has `APP_ENV` UNSET, not `"production"` (see
// `scripts/lib/assert-app-env.ts`'s own header: "A script invoked by hand
// over SSH ... inherits none of that unless it is sourced explicitly
// first"). Every review run with `APP_ENV` unset sailed straight through the
// old check. This version closes that by refusing on anything OTHER than an
// explicit allowlisted value, not merely on the one explicit bad value.
//
// TWO INDEPENDENT CHECKS, not one, because an env variable alone is a label
// someone can forget to set (see above) or set wrong on purpose:
//
//  1. A REAL FILESYSTEM FACT about the machine, unconditionally checked
//     first: `/srv/photoshowcase` is the droplet's `APP_ROOT`
//     (`.github/workflows/deploy.yml`'s `APP_ROOT: /srv/photoshowcase`,
//     and `scripts/lib/assert-app-env.ts`'s header names the exact env
//     files under it). No developer laptop or CI runner has this path. If
//     it exists, this process almost certainly runs ON the droplet, and
//     that refuses REGARDLESS of what `APP_ENV` says — closing the case
//     where a future change accidentally sets `APP_ENV=development` (or
//     leaves it unset) in a droplet shell.
//  2. An AFFIRMATIVE allowlist on `APP_ENV`: refuses unless it is exactly
//     `"development"` or `"test"`. Unset, empty, `"production"`, or any
//     unrecognized value (a typo, a future environment name nobody has
//     taught this list yet) all refuse — fail CLOSED on ambiguity, the
//     opposite of the polarity the first version had.
//
// `package.json`'s `test:e2e` script sets `APP_ENV=test` itself (see that
// script), so the common path never depends on a developer's shell already
// having it exported — the harness declares its own environment rather than
// trusting whatever the caller's shell happens to contain.
import { existsSync } from "node:fs";

export const DROPLET_ROOT_MARKER = "/srv/photoshowcase";
const ALLOWED_APP_ENVS = new Set(["development", "test"]);

export interface RefuseOnProductionDeps {
  /**
   * Defaults to `process.env.APP_ENV` -- but only when this key is entirely
   * absent from `deps`. Injecting `{ appEnv: undefined }` explicitly is
   * honored as "unset" and must NOT fall through to the ambient
   * `process.env.APP_ENV` (task #169: a naive `deps.appEnv ?? process.env.APP_ENV`
   * makes an injected `undefined` indistinguishable from "not injected",
   * so a developer with `APP_ENV=development` exported in their shell gets a
   * false green -- or, for the tests asserting the unset case throws, a false
   * red).
   */
  appEnv?: string;
  /** Defaults to checking `DROPLET_ROOT_MARKER` on the real filesystem. Overridable for tests. */
  rootMarkerExists?: () => boolean;
}

export function refuseUnlessDevEnvironment(deps: RefuseOnProductionDeps = {}): void {
  const rootMarkerExists = deps.rootMarkerExists ?? (() => existsSync(DROPLET_ROOT_MARKER));

  if (rootMarkerExists()) {
    throw new Error(
      `${DROPLET_ROOT_MARKER} exists on this filesystem -- that is the droplet's own ` +
        "release root (see .github/workflows/deploy.yml's APP_ROOT), so this process is " +
        "almost certainly running on production. Refusing to seed a session regardless of " +
        "APP_ENV (task #165, task #107, AGENTS.md's 'This never touches production').",
    );
  }

  const appEnv = "appEnv" in deps ? deps.appEnv : process.env.APP_ENV;
  if (!appEnv || !ALLOWED_APP_ENVS.has(appEnv)) {
    throw new Error(
      `APP_ENV must be explicitly set to one of ${[...ALLOWED_APP_ENVS].join(", ")} to run ` +
        `this harness -- got ${JSON.stringify(appEnv)}. This harness seeds a session directly ` +
        "into whatever database the process it runs in connects to, with no magic link and " +
        "no audit trail (task #165). Refusing rather than guessing which environment was " +
        'meant is the point: an unset or misspelled APP_ENV must never be read as "safe".',
    );
  }
}
