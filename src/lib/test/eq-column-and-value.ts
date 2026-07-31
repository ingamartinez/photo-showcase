// Test-only helper. Never imported by production code — only by the fake
// `@/lib/db` doubles inside *.test.ts files that need to duck-type drizzle-
// orm's `eq()` condition, because drizzle-orm 0.45 exposes no other stable
// API to introspect a query builder chain outside of a real database.
//
// Task #53: most test files in this repo intentionally duplicate their fake
// `db` double per file rather than share it (see src/lib/asset-access.test.ts's
// own comment on that convention) — this ONE piece is the exception, because
// duplicating it is exactly what produced a silent bug. An earlier copy of
// this helper (src/app/dashboard/galleries/actions.test.ts, before this task)
// read the DB column name straight off the `eq()` condition and indexed
// fixture rows with it directly. That is the DB name (e.g. "gallery_id"),
// not the JS property key (e.g. "galleryId") the fixtures are keyed by — it
// only ever worked because every `eq()` in that file happened to compare a
// column named "id", where the two names coincide. A future copy-paste onto
// a mismatched column (e.g. `assets.galleryId`) would have filtered every
// row out and silently asserted nothing, with the test still reporting green.
//
// Resolving through the table object's OWN entries below, rather than
// hardcoding a snake_case<->camelCase transform, keeps this correct for
// every column — including ones where the JS key and DB name differ — not
// just the ones where they happen to match.
//
// Task #119, on whether this exception stays singular: it doesn't, but the
// convention isn't retired either. This module was already imported by two
// call sites before this task (both fixed by #53); #119 added three more
// (src/lib/packages.test.ts, src/lib/clients.test.ts,
// src/app/dashboard/clients/actions.test.ts) — every one of them a file that
// carried the SAME latent bug shape described above, still passing only
// because its JS keys happened to match its DB column names. The other six
// files with a locally-corrected `eqColumnAndValue` (e.g.
// src/lib/asset-access.test.ts) carry no such risk — they already resolve
// through the table object, same as this one does — so #119 deliberately
// left them duplicated rather than migrating them for consistency alone.
// The rule this module is exercising, then, is narrower than "share this
// helper everywhere": migrate a file's local copy here ONLY when that copy
// is demonstrably capable of the silent-pass bug this file exists to
// prevent. A locally-corrected copy is not a reason to touch a file; a
// locally-BUGGY one is.
export function eqColumnAndValue(condition: unknown): { column: string; value: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  let dbColumnName: string | undefined;
  let table: unknown;
  let value: unknown;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnName = (chunk as { name: string }).name;
        table = (chunk as { table: unknown }).table;
      }
      if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
    }
  }
  if (!dbColumnName || !table) {
    throw new Error("eqColumnAndValue: not an eq() condition");
  }

  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];

  // Fail loudly here, in the ONE place this resolution happens, rather than
  // letting an unresolved column fall through as `undefined` and get
  // silently filtered into an empty (but not erroring) result set at the
  // call site — which is exactly the shape task #53's bug took. A caller
  // passing the wrong table export (e.g. importing `galleries` but querying
  // against `assets` rows) is a test-authoring mistake that should fail the
  // very test it's inside of, not quietly assert nothing.
  if (!jsKey) {
    throw new Error(
      `eqColumnAndValue: DB column "${dbColumnName}" has no matching JS key on the given ` +
        "table object — check the fixture is filtering against the SAME table export the " +
        "eq() condition was built from.",
    );
  }

  return { column: jsKey, value };
}
