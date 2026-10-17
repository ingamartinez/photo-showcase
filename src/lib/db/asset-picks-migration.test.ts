// Task #257 (epic #250) — STATIC GUARD on the backfill migration.
//
// CI does not run migrations (task #105), and the migration's real semantics
// can only be proven against a restored production backup (plan §9). This
// file proves something narrower and worth stating plainly: the migration
// file's SHAPE. The properties below are what a rebase, a renumber or a
// re-run of `drizzle-kit generate` can silently break, each of which fails in
// production — the only place this SQL ever runs.
//
// It reads the files from disk and splits the migration on
// `--> statement-breakpoint`, the same separator the migrator and every later
// reader use.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `process.cwd()` is the repo root under Vitest (its config lives there); the
// precedent is src/lib/graphql/schema-sdl.test.ts.
const MIGRATION_PATH = join(process.cwd(), "drizzle/0017_asset-picks-backfill.sql");
const JOURNAL_PATH = join(process.cwd(), "drizzle/meta/_journal.json");
const DOWN_PATH = join(process.cwd(), "scripts/asset-picks-backfill-down.sql");

const STATEMENT_SEPARATOR = "--> statement-breakpoint";
const statements = readFileSync(MIGRATION_PATH, "utf8").split(STATEMENT_SEPARATOR);

/** Index of the first statement matching `pattern`, or -1. */
function statementIndex(pattern: RegExp): number {
  return statements.findIndex((statement) => pattern.test(statement));
}

/** Every statement matching `pattern`. */
function statementsMatching(pattern: RegExp): string[] {
  return statements.filter((statement) => pattern.test(statement));
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

  // Risk guarded: the five backfill statements run in this exact order
  // (plan §7). The guard must inspect pre-backfill data; the insert must copy
  // `kind` before 4.3 resets it; the carts must be released before `billed_at`
  // is stamped or they keep one; decision 20 must read the lock state before
  // it clears it. A swap of any two fails only in production.
  it("orders guard < insert < cart release < billed_at < decision 20", () => {
    const guardAt = statementIndex(/DO \$\$/);
    const insertAt = statementIndex(/INSERT\s+INTO\s+"asset_picks"/i);
    const releaseAt = statementIndex(/"is_selected"\s*=\s*false/);
    const billedAtAt = statementIndex(/"billed_at"\s*=\s*COALESCE/i);
    const decision20At = statementIndex(/UPDATE\s+"gallery_clients"/i);

    expect(guardAt, "the DO $$ guard").toBeGreaterThan(-1);
    expect(insertAt, "the pick insert").toBeGreaterThan(guardAt);
    expect(releaseAt, "the cart release (4.3)").toBeGreaterThan(insertAt);
    expect(billedAtAt, "the billed_at stamp (4.4)").toBeGreaterThan(releaseAt);
    expect(decision20At, "decision 20's unlock (4.5)").toBeGreaterThan(billedAtAt);
  });

  // Risk guarded: relaxing the cart release. It must unclaim the photo,
  // reset `selection_kind` (the pick row keeps the real intent), and refuse to
  // touch a photo someone else already submitted. Dropping any of the three
  // is invisible to every other static check.
  it("releases carts, resets the asset kind, and spares a photo with a submitted pick", () => {
    const releaseAt = statementIndex(/"is_selected"\s*=\s*false/);
    expect(releaseAt, "the cart release (4.3)").toBeGreaterThan(-1);

    const release = statements[releaseAt];
    expect(release).toMatch(/"is_selected"\s*=\s*false/);
    expect(release).toMatch(/"selection_kind"\s*=\s*'edited'/);
    expect(release).toMatch(/NOT\s+EXISTS[\s\S]*?"submitted_at"\s+IS\s+NOT\s+NULL/i);
  });

  // Risk guarded: a stray UPDATE/DELETE on `asset_picks` rewrites or destroys
  // the intent the pick row exists to preserve. The backfill owns the table's
  // contents through exactly one INSERT, and nothing else.
  it("touches asset_picks through exactly one INSERT and no UPDATE or DELETE", () => {
    expect(statementsMatching(/INSERT\s+INTO\s+"asset_picks"/i)).toHaveLength(1);
    expect(statementsMatching(/UPDATE\s+"asset_picks"/i)).toHaveLength(0);
    expect(statementsMatching(/DELETE\s+FROM\s+"asset_picks"/i)).toHaveLength(0);
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
  // reopens a closed gallery; widening its WHERE (an OR, an IN, a missing
  // removed_at filter, a second status) reaches rows the decision did not
  // authorise. Asserted on the WHERE clause, not a substring that any
  // widening keeps.
  it("writes gallery_clients only as decision 20's proofing client unlock", () => {
    const writes = statementsMatching(/UPDATE\s+"gallery_clients"/i);
    expect(writes).toHaveLength(1);

    const [unlock] = writes;
    expect(unlock).not.toContain(`"selection_submitted_at" =`);

    const whereAt = unlock.search(/\bWHERE\b/i);
    expect(whereAt, "decision 20 has a WHERE clause").toBeGreaterThan(-1);
    const where = unlock.slice(whereAt);

    expect(where).toMatch(/"status"\s*=\s*'proofing'/i);
    expect(where).toMatch(/"selection_locked_by"\s*=\s*'client'/i);
    expect(where).toMatch(/"removed_at"\s+IS\s+NULL/i);
    expect(where).not.toMatch(/\bOR\b/i);
    expect(where).not.toMatch(/\bIN\s*\(/i);
    expect(where.match(/"status"/g) ?? []).toHaveLength(1);
  });

  // Risk guarded: a reorder that runs the refusal guard after the insert makes
  // the guard inspect post-backfill data and pass vacuously; reducing the
  // guard to a NOTICE turns a refused deploy into a silent one.
  it("runs the refusal guard before the first pick insert, as an EXCEPTION", () => {
    const guardAt = statementIndex(/DO \$\$/);
    const insertAt = statementIndex(/INSERT\s+INTO\s+"asset_picks"/i);

    expect(guardAt, "the DO $$ guard").toBeGreaterThan(-1);
    expect(insertAt, "the pick insert").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(insertAt);

    const guard = statements[guardAt];
    expect(guard).toMatch(/RAISE\s+EXCEPTION/i);
    expect(guard).not.toMatch(/RAISE\s+(NOTICE|WARNING|INFO)/i);
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

  // Risk guarded: plan §11 regenerates 0017 if `main` gains a migration, which
  // gives it a new `when`. A stale literal makes the down script's DELETE hit
  // zero rows: it reports success while the journal still claims 0017 is
  // applied and the schema is gone.
  it("targets exactly the 0017 journal timestamp in the down script", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0017_asset-picks-backfill");
    expect(entry, "the 0017 journal entry").toBeDefined();

    const matches = [...readFileSync(DOWN_PATH, "utf8").matchAll(/"created_at"\s*=\s*(\d+)/g)];
    expect(matches, "exactly one literal when in the down script").toHaveLength(1);
    expect(Number(matches[0][1])).toBe(entry!.when);
  });
});
