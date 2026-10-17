// Task #257 (epic #250) — STATIC GUARD on the backfill migration.
//
// CI does not run migrations (task #105), and the migration's real semantics
// can only be proven against a restored production backup (plan §9). This
// file proves something narrower and worth stating plainly: the migration
// file's SHAPE. Five properties that a rebase, a renumber or a re-run of
// `drizzle-kit generate` can silently break, each of which fails in
// production — the only place this SQL ever runs.
//
// It reads the file from disk and splits it on `--> statement-breakpoint`,
// the same separator the migrator and every later reader use.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `process.cwd()` is the repo root under Vitest (its config lives there); the
// precedent is src/lib/graphql/schema-sdl.test.ts.
const MIGRATION_PATH = join(process.cwd(), "drizzle/0017_asset-picks-backfill.sql");
const JOURNAL_PATH = join(process.cwd(), "drizzle/meta/_journal.json");

const STATEMENT_SEPARATOR = "--> statement-breakpoint";
const statements = readFileSync(MIGRATION_PATH, "utf8").split(STATEMENT_SEPARATOR);

/** Index of the first statement matching `pattern`, or -1. */
function statementIndex(pattern: RegExp): number {
  return statements.findIndex((statement) => pattern.test(statement));
}

describe("0017_asset-picks-backfill.sql shape", () => {
  it("parses into more than one statement (guards every assertion below against an empty read)", () => {
    expect(statements.length).toBeGreaterThan(5);
    expect(statements.some((s) => /CREATE TABLE "asset_picks"/.test(s))).toBe(true);
  });

  // Risk guarded: anyone who re-runs `db:generate` after a rebase gets
  // drizzle-kit's order back (FK before unique index), and Postgres rejects
  // the FK. Nothing local catches it; the deploy does, in production.
  it("orders the unique index before both asset_picks foreign keys", () => {
    const uniqueIndexAt = statementIndex(/CREATE UNIQUE INDEX "assets_id_gallery_id_idx"/);
    const assetFkAt = statementIndex(/"asset_picks_asset_fk"/);
    const membershipFkAt = statementIndex(/"asset_picks_membership_fk"/);

    expect(uniqueIndexAt, "the assets(id, gallery_id) unique index").toBeGreaterThan(-1);
    expect(assetFkAt, "the asset FK").toBeGreaterThan(-1);
    expect(membershipFkAt, "the membership FK").toBeGreaterThan(-1);
    expect(uniqueIndexAt).toBeLessThan(assetFkAt);
    expect(uniqueIndexAt).toBeLessThan(membershipFkAt);
  });

  // Risk guarded: a settle-like status derivation writing `galleries` would
  // reopen `selected` galleries (plan §7). This scans every statement.
  it("never writes the galleries table", () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/UPDATE\s+"galleries"/i);
      expect(statement).not.toMatch(/INSERT\s+INTO\s+"galleries"/i);
    }
  });

  // Risk guarded: writing a gallery_clients row outside decision 20's scope
  // reopens a closed gallery; dropping the split between the lock pair and
  // `selection_submitted_at` erases the submit history decision 20 keeps.
  it("only writes gallery_clients as decision 20's proofing client unlock, preserving the submit history", () => {
    const writes = statements.filter((statement) => /UPDATE\s+"gallery_clients"/i.test(statement));
    expect(writes).toHaveLength(1);

    const [unlock] = writes;
    expect(unlock).toContain(`"status" = 'proofing'`);
    expect(unlock).toContain(`"selection_locked_by" = 'client'`);
    expect(unlock).not.toContain(`selection_submitted_at" =`);
  });

  // Risk guarded: a reorder that runs the refusal guard after the insert makes
  // the guard inspect post-backfill data and pass vacuously.
  it("runs the refusal guard before the first pick insert", () => {
    const guardAt = statementIndex(/DO \$\$/);
    const insertAt = statementIndex(/INSERT\s+INTO\s+"asset_picks"/i);

    expect(guardAt, "the DO $$ guard").toBeGreaterThan(-1);
    expect(insertAt, "the pick insert").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(insertAt);
  });

  // Risk guarded: `migrate()` only applies migrations whose timestamp is
  // greater than the last applied `created_at`. A non-monotonic journal after
  // a merge silently SKIPS 0017 in production.
  it("keeps the journal timestamps strictly increasing with idx", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };

    const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(
        ordered[i].when,
        `${ordered[i].tag} (idx ${ordered[i].idx}) must be newer than ${ordered[i - 1].tag} (idx ${ordered[i - 1].idx})`,
      ).toBeGreaterThan(ordered[i - 1].when);
    }
  });
});
