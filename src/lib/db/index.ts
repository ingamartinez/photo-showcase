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
