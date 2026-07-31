// Shared APP_ENV guard for one-shot ops scripts that mint or write a real R2
// key (task #81).
//
// The mechanism this guards against: `APP_ENV` reaches the RUNNING APP
// through systemd's EnvironmentFile (`/srv/photoshowcase/env/photoshowcase.env`
// + `/srv/photoshowcase/app/current/release.env`, the latter written by
// `.github/workflows/deploy.yml`'s "Extract release + write release.env"
// step). A script invoked by hand over SSH — or by the deploy pipeline's own
// `sudo -n -u photoshowcase bun scripts/…` steps, which run OUTSIDE the
// systemd unit — inherits none of that unless it is sourced explicitly
// first.
//
// `src/lib/r2.ts`'s `namespacedKey()` fails CLOSED when `APP_ENV` is unset:
// it silently prefixes every key with `dev/` rather than throwing (see that
// file's own header, and task #38). That default is exactly right for the
// RUNNING APP — a fresh clone, a misconfigured host, a future CI job all
// land in the safe, separable `dev/` slice of the bucket instead of the
// production one.
//
// It is exactly WRONG for a one-shot maintenance script whose entire job is
// to write into PRODUCTION. Such a script — task #26's finals backfill was
// the anticipated first one; `scripts/backfill-display-derivatives.ts`
// (task #89) is the first one that actually shipped — would, left
// unguarded, silently write every object into the `dev/` namespace, print
// success, and leave production's real keys untouched: a total no-op that
// looks identical to a successful run.
//
// This deliberately does NOT make the builders themselves (`proofKey`,
// `finalKey`, `displayKey` in src/lib/r2.ts) throw on unset `APP_ENV` —
// task #81's card asked for that option to be considered and, if rejected,
// for the rejection to be explicit. It is rejected here: `namespacedKey()`
// has no way to tell "the Next.js server process" apart from "a one-shot
// script" — both are just `process.env.APP_ENV`. Making the builders throw
// would reverse #38's fail-closed default for the RUNNING APP too, turning
// an ordinary `bun dev` with no `APP_ENV` line in `.env.local` (safe today:
// writes land in `dev/`) into a hard crash. That is strictly worse for the
// common case, to close a gap that only exists for ops scripts.
//
// So the guard lives here instead, one level up, as something a SCRIPT opts
// into by calling it — not something the builders enforce on every caller.
// It does not require `APP_ENV=production` specifically: running a script
// against the dev namespace on purpose (e.g. while developing it locally) is
// fine. It only requires that whoever runs it said which environment they
// mean, so an operator who forgot to source `release.env` finds out
// immediately — a loud crash before anything is written — instead of
// discovering it later as a production key that silently never happened.
//
// scripts/ops-r2-guard.test.ts runs a BEST-EFFORT LINT — not a guarantee —
// against every script under scripts/: if a file statically imports any of
// `putObject`, `deleteObject`, `proofKey`, `finalKey`, `displayKey`
// (src/lib/r2.ts's write-capable exports), under any local name, via a
// relative path or the `@/` tsconfig alias, that same file is required to
// also call this function. It fails `bun run test` — and therefore CI — if
// not. That is the "cannot miss it" half of task #81's acceptance
// criterion, TO THE EXTENT a static text scan can deliver it: forgetting
// the call is CAUGHT MORE OFTEN than a comment nobody happened to read, not
// caught with certainty.
//
// It is not a guarantee, and after two review rounds finding real holes in
// it, this file stops implying otherwise. See scripts/ops-r2-guard.test.ts's
// own header for the full, precise, currently-known list of what that lint
// can and cannot see — a dynamic `import()` or `require()` call defeats it
// outright, for instance. What ACTUALLY protects a script that calls this
// function is the throw below, at runtime, regardless of how the call
// reached it. The lint only raises the odds that the call is there at all.
//
// This also does not verify that a set `APP_ENV` is spelled correctly — a
// typo like `"Production"` or `"prod"` passes this function's own check
// (something WAS set) and still silently lands under `dev/`
// (`namespacedKey` requires an exact `"production"` match). This closes the
// UNSET case, not the misspelled one.
export function assertAppEnvIsSet(): void {
  if (!process.env.APP_ENV) {
    throw new Error(
      "APP_ENV is not set. Refusing to run: src/lib/r2.ts's namespacedKey() " +
        "silently prefixes every key with dev/ when APP_ENV is unset, so this " +
        "script would write into the dev namespace while reporting success, " +
        "and production would stay untouched (see task #81). Source the env " +
        "files this process needs first, e.g. from the release dir:\n" +
        "  set -a\n" +
        "  . /srv/photoshowcase/env/photoshowcase.env\n" +
        "  . /srv/photoshowcase/app/current/release.env\n" +
        "  set +a\n" +
        "then re-run this script.",
    );
  }
}
