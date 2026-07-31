import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Homebrew Postgres on macOS puts its socket at /tmp; Linux uses /var/run/postgresql.
// Local dev and the droplet both connect over the unix socket via peer auth.
const defaultSocket = process.platform === "darwin" ? "/tmp" : "/var/run/postgresql";
const client = postgres({
  host: process.env.PGHOST ?? defaultSocket,
  database: process.env.PGDATABASE ?? "photoshowcase",
  username: process.env.PGUSER ?? process.env.USER,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  password: process.env.PGPASSWORD,
  max: 10,
  idle_timeout: 20,
  prepare: false,
});

export const db = drizzle(client, { schema });
export type DB = typeof db;

// Task #114 — the LISTEN/NOTIFY pub-sub primitives, deliberately exposed as a
// narrow pair of bound functions rather than the raw `client` itself. `db`
// stays the one and only way the rest of the app touches rows (queries,
// writes, transactions all go through Drizzle); `pubsub` exists ONLY for
// `src/lib/selection-events.ts`, which needs `sql.listen`/`sql.notify` and
// nothing else postgres.js's client exposes (`.unsafe`, `.begin`,
// `.largeObject`, ...). Widening this to `export const rawClient = client`
// would hand every future importer the whole driver surface for the sake of
// two methods one module needs.
//
// `client.listen()` is safe to call from a pooled client configured with
// `max: 10, idle_timeout: 20` (this file's own settings, above) — verified by
// reading postgres.js's own source (`node_modules/postgres/src/index.js`),
// not assumed from the docs (task #114's own trap #3): the FIRST call to
// `.listen()` lazily spins up a SEPARATE, dedicated internal client
// (`Postgres({ ...options, max: 1, idle_timeout: null, max_lifetime: null,
// ... })`), entirely independent of the pool `client` above. That dedicated
// client's own `onclose` handler re-issues `LISTEN` for every channel (and
// re-invokes every listener's `onlisten`) automatically the next time it
// reconnects, so a dropped connection (a network blip, a Postgres restart)
// recovers on its own. `scripts/verify-selection-listen-notify.ts` proves
// this empirically against a real local Postgres — see that script's own
// header comment for what it does and what it found.
export const pubsub = {
  listen: client.listen.bind(client),
  notify: client.notify.bind(client),
};
