// Empirical proof for two of task #114's acceptance criteria that this repo's
// unit tests cannot exercise (every route/module test in this codebase runs
// against a MOCKED `@/lib/db` — see src/lib/selection-events.test.ts's own
// header comment): that the app's ONE Postgres LISTEN connection (src/lib/
// selection-events.ts) survives (a) the app's own connection-pool
// `idle_timeout` (20s, src/lib/db/index.ts) and (b) an abrupt loss of the
// underlying TCP connection, recovering on its own. Run manually, against a
// REAL, reachable Postgres (local dev, same env vars `src/lib/db/index.ts`
// reads):
//   bun run verify:selection:listen
//
// WHY THIS EXISTS, RATHER THAN TRUSTING THE DOCS OR THE SOURCE READING ALONE:
// task #114's own trap #3 says explicitly not to assume postgres.js's
// `sql.listen()` is exempt from `idle_timeout` "because the documentation
// implies a dedicated connection" — prove it. Reading
// `node_modules/postgres/src/index.js` (see src/lib/db/index.ts's own header
// comment on `pubsub`, and src/lib/selection-events.ts's) already shows HOW
// this is supposed to work: the first `.listen()` call lazily creates a
// SEPARATE internal client with `idle_timeout: null`, and that client's own
// `onclose` handler re-subscribes every channel automatically. This script
// exercises that behavior against a REAL server rather than resting on
// reading the library's source, which is evidence of intent, not proof of
// runtime behavior.
//
// WHAT THIS SCRIPT DOES NOT DO, AND WHY: it does NOT restart the actual
// Postgres server process. This machine's local dev Postgres is very likely
// shared with other concurrent work (other kanban agents' own worktrees,
// this developer's own other sessions) — restarting the whole server would
// be a genuinely disruptive, shared-infrastructure action for a proof that
// does not need it. What actually matters for this proof is "the TCP
// connection between this app and Postgres closes unexpectedly and
// postgres.js recovers" — a Postgres restart is ONE way to cause that, but
// so is `pg_terminate_backend(pid)` aimed at the EXACT backend pid this
// script's own LISTEN connection opened (identified via a distinctive
// `application_name`, verified against `pg_stat_activity` before touching
// anything), which severs only that one connection and leaves every other
// session on this Postgres instance — including any other agent's — entirely
// untouched. This is the SAFE, surgical way to prove "survives an abrupt
// connection loss" without the collateral risk of restarting shared
// infrastructure. A real `systemctl restart postgresql` (or equivalent) on
// the DROPLET is still the more complete proof for that specific event and
// is explicitly out of reach from this environment — recorded as such,
// deliberately, rather than glossed over. See task #114's own acceptance
// criteria for the parts of this task that could not be verified from here
// AT ALL (the droplet/Caddy keepalive check, and the two-real-browsers
// confirmation) — this script's own two proofs are NOT in that category:
// both are verifiable locally, and this script is what does it.
//
// A FRESH, throwaway `postgres()` client — same reasoning as
// scripts/measure-selection-transport.ts's own `measureListenConnectionCost`:
// this script needs to fully `.end()` everything it opens so the process can
// exit, and must not share (or accidentally close) the app's own long-lived
// `src/lib/db` singleton.
import postgres from "postgres";

const APPLICATION_NAME = "verify_selection_listen_notify_probe";
const CHANNEL = "verify_selection_listen_notify_probe_channel";
// Longer than src/lib/db/index.ts's own `idle_timeout: 20` (seconds) — the
// exact thing phase 2 needs to outlast to mean anything.
const IDLE_TIMEOUT_WAIT_MS = 25_000;

function connectionOptions(overrides: Partial<postgres.Options<Record<string, never>>> = {}) {
  const defaultSocket = process.platform === "darwin" ? "/tmp" : "/var/run/postgresql";
  return {
    host: process.env.PGHOST ?? defaultSocket,
    database: process.env.PGDATABASE ?? "photoshowcase",
    username: process.env.PGUSER ?? process.env.USER,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    password: process.env.PGPASSWORD,
    prepare: false,
    connect_timeout: 5,
    ...overrides,
  };
}

function waitForNotify(timeoutMs: number): {
  promise: Promise<string>;
  onNotify: (payload: string) => void;
} {
  let onNotify: (payload: string) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no NOTIFY received within ${timeoutMs}ms`)),
      timeoutMs,
    );
    onNotify = (payload: string) => {
      clearTimeout(timer);
      resolve(payload);
    };
  });
  return { promise, onNotify };
}

async function main(): Promise<void> {
  console.log(
    `Platform: ${process.platform}. Connecting to the Postgres src/lib/db/index.ts's own env vars point at...\n`,
  );

  // THE CONNECTION UNDER TEST — same shape as src/lib/db/index.ts's own
  // `client` (max/idle_timeout included, so this genuinely exercises "does
  // the pool's idle_timeout reach the dedicated listen connection", not a
  // connection this script conveniently configured to avoid the question),
  // tagged with a distinctive `application_name` so the rest of this script
  // can find its EXACT backend pid later without guessing.
  const app = postgres(
    connectionOptions({
      max: 10,
      idle_timeout: 20,
      connection: { application_name: APPLICATION_NAME },
    }),
  );
  // A SEPARATE connection, standing in for "another app instance, or this
  // same one issuing a NOTIFY from a normal query" — sending a NOTIFY from
  // the SAME client that is LISTENing is legal in Postgres but would not
  // prove anything about cross-connection delivery, which is the actual
  // claim this app's design rests on.
  const other = postgres(connectionOptions());

  let failed = false;

  try {
    console.log("--- Phase 1: basic delivery ---");
    const first = waitForNotify(5_000);
    await app.listen(CHANNEL, first.onNotify, () => {
      console.log("  onlisten fired (initial subscribe).");
    });
    await other.notify(CHANNEL, "phase-1");
    const payload1 = await first.promise;
    console.log(`  received NOTIFY payload: ${JSON.stringify(payload1)} — OK\n`);

    console.log(
      `--- Phase 2: survives the pool's own idle_timeout (20s) — waiting ${IDLE_TIMEOUT_WAIT_MS / 1000}s with no other traffic on \`app\` ---`,
    );
    await new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_WAIT_MS));
    const second = waitForNotify(5_000);
    // Re-subscribing here reuses the SAME channel entry (postgres.js's own
    // `listen.channels[name]`, see src/lib/selection-events.ts's own header
    // comment) rather than opening a second connection — this just swaps in
    // a fresh listener to await, it does not touch the underlying socket.
    await app.listen(CHANNEL, second.onNotify);
    await other.notify(CHANNEL, "phase-2");
    const payload2 = await second.promise;
    console.log(
      `  received NOTIFY payload AFTER the idle wait: ${JSON.stringify(payload2)} — the\n` +
        "  dedicated LISTEN connection was NOT reaped by idle_timeout: 20. OK\n",
    );

    console.log("--- Phase 3: recovers after the underlying connection is abruptly severed ---");
    const admin = postgres(connectionOptions());
    try {
      const [row] = await admin<{ pid: number }[]>`
        select pid from pg_stat_activity
        where application_name = ${APPLICATION_NAME}
          and pid != pg_backend_pid()
        order by backend_start desc
        limit 1
      `;
      if (!row) {
        throw new Error(
          `could not find a pg_stat_activity row for application_name = ${APPLICATION_NAME} — ` +
            "cannot safely identify which backend to terminate, aborting phase 3 without touching anything",
        );
      }
      console.log(`  found the probe's own dedicated LISTEN backend: pid ${row.pid}.`);

      const third = waitForNotify(15_000);
      // `onlisten` fires again on the AUTOMATIC resubscribe postgres.js
      // performs once it notices the connection closed and reconnects — see
      // src/lib/db/index.ts's own comment on this exact mechanism.
      let resubscribed = false;
      await app.listen(CHANNEL, third.onNotify, () => {
        if (resubscribed) {
          console.log("  onlisten fired AGAIN — the connection reconnected and resubscribed.");
        }
        resubscribed = true;
      });

      console.log(`  terminating pid ${row.pid} (pg_terminate_backend) — ONLY this one backend...`);
      await admin`select pg_terminate_backend(${row.pid})`;

      // Give postgres.js's own reconnect+backoff a moment to notice the
      // connection closed before sending the NOTIFY that proves recovery —
      // sending it too early would just prove nothing (either connection
      // could still be mid-teardown).
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      await other.notify(CHANNEL, "phase-3");
      const payload3 = await third.promise;
      console.log(
        `  received NOTIFY payload AFTER the connection was severed: ${JSON.stringify(payload3)}\n` +
          "  — postgres.js reconnected and resubscribed on its own. OK\n",
      );
    } finally {
      await admin.end({ timeout: 0 });
    }
  } catch (error) {
    failed = true;
    console.error("VERIFICATION FAILED:", error);
  } finally {
    await app.end({ timeout: 0 });
    await other.end({ timeout: 0 });
  }

  if (failed) {
    console.log(
      "\nOne or more phases above did not complete as expected — see the error. This is\n" +
        "informative either way: task #114's own trap #3 says prove this, not assume it.",
    );
    process.exit(1);
  }

  console.log(
    "All three phases passed: basic delivery, idle_timeout survival, and recovery from an\n" +
      "abruptly severed connection, all against a REAL local Postgres. NOT covered by this\n" +
      "run: an actual Postgres SERVER restart (deliberately not performed here — see this\n" +
      "file's own header comment on why), and anything about the DROPLET's own Caddy/Bun\n" +
      "idle-timeout behavior, which needs the droplet itself (task #57's own scope).",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
