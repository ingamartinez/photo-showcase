// Task #165: the visual-capture harness seeds a session row DIRECTLY into
// whatever database `src/lib/db` connects to (see global-setup.ts), bypassing
// the magic-link flow entirely. That is exactly the kind of standing bypass
// task #82 rejected if it lived in `src/` — keeping it inside the test
// harness is only half of that guarantee. The other half is that the
// connection it writes to can never be production's, which is what this
// guard exists to enforce before a single row is touched.
//
// This mirrors the existing `APP_ENV` convention (see
// scripts/lib/assert-app-env.ts and src/lib/r2.ts's `namespacedKey`) rather
// than inventing a new signal: `APP_ENV=production` is the one value this
// codebase already treats as "this process means production", set only by
// systemd's EnvironmentFile on the droplet (scripts/lib/assert-app-env.ts's
// own header traces the exact mechanism). A local `bun run dev` / `bun run
// test:e2e` invocation never sets it.
//
// Deliberately narrower than task #107's proposed `refuseOnProduction()`
// (still backlog at the time this was written): that helper is meant for
// legitimate ops scripts that might need an explicit override flag to
// target production on purpose. There is no such legitimate case here — a
// visual-regression harness has no reason to ever touch production data — so
// this takes no override argument and cannot be talked out of refusing.
export function refuseUnlessDevEnvironment(): void {
  if (process.env.APP_ENV === "production") {
    throw new Error(
      "APP_ENV=production. Refusing to seed a session: this harness must " +
        "only ever run against a local development database (task #165, " +
        "task #107, AGENTS.md's 'This never touches production'). If you are " +
        "seeing this while SSH'd into the droplet, stop now — continuing " +
        "would insert a row directly into the production users/sessions " +
        "tables, with no magic link and no audit trail.",
    );
  }
}
