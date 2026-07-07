// Production migration runner. Invoked from the CD workflow as:
//   sudo -n -u photoshowcase bun scripts/migrate-prod.ts
//
// Expects:
//   - cwd at the release dir (reads ./drizzle/ for migration SQL)
//   - Postgres reachable via peer auth over /var/run/postgresql (no password)
//   - PGDATABASE env set (defaults to `photoshowcase` via src/lib/db parity)
//
// Phase-0-safe: until the first migration is generated there is no ./drizzle
// journal, so this exits cleanly instead of throwing. The domain schema and
// its migrations arrive in Phase 2 (see PLAN.md §6).

import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/lib/db";

const target = process.env.PGDATABASE ?? "photoshowcase";

if (!existsSync("./drizzle/meta/_journal.json")) {
  console.log(`[migrate-prod] no migrations found (target=${target}) — nothing to apply`);
  await db.$client.end();
  process.exit(0);
}

console.log(`[migrate-prod] applying migrations from ./drizzle (target=${target})`);
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate-prod] migrations applied");

await db.$client.end();
