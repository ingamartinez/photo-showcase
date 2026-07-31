import { describe, expect, it } from "vitest";
import { eqColumnAndValue } from "./eq-column-and-value";

// Minimal stand-ins for the two drizzle-orm SQL chunk shapes this helper
// duck-types — a real `eq()` condition's `queryChunks` mixes several chunk
// kinds together, but only these two carry what this helper needs: the
// Column chunk (identified by having BOTH `name` and `table`) and the value
// chunk (identified by having BOTH `value` and `encoder`). Shaped by hand
// here rather than imported from drizzle-orm so this suite tests the
// helper's OWN parsing logic against a fixed, known input instead of
// re-verifying drizzle-orm's internals on every run.
function columnChunk(dbColumnName: string, table: unknown) {
  return { name: dbColumnName, table };
}

function valueChunk(value: unknown) {
  return { value, encoder: {} };
}

function fakeEqCondition(dbColumnName: string, table: unknown, value: unknown) {
  return { queryChunks: [columnChunk(dbColumnName, table), valueChunk(value)] };
}

describe("eqColumnAndValue", () => {
  it("resolves the JS property key, not the raw DB column name, when they differ", () => {
    // The exact shape of task #53's bug: a table whose JS key ("galleryId")
    // and DB column name ("gallery_id") do not match.
    const table = { galleryId: { name: "gallery_id" } };

    const result = eqColumnAndValue(fakeEqCondition("gallery_id", table, "gallery-1"));

    expect(result).toEqual({ column: "galleryId", value: "gallery-1" });
  });

  it("still resolves correctly when the JS key and DB name happen to coincide", () => {
    // The case that let the original bug pass unnoticed: "id" is the JS key
    // AND the DB column name, so even the wrong (pre-#53) implementation
    // returned the right answer here by accident.
    const table = { id: { name: "id" } };

    const result = eqColumnAndValue(fakeEqCondition("id", table, "asset-1"));

    expect(result).toEqual({ column: "id", value: "asset-1" });
  });

  it("throws when the condition carries no column/table chunk at all", () => {
    expect(() => eqColumnAndValue({ queryChunks: [valueChunk("x")] })).toThrow(
      /not an eq\(\) condition/,
    );
  });

  it("throws when queryChunks itself is missing", () => {
    expect(() => eqColumnAndValue({})).toThrow(/not an eq\(\) condition/);
  });

  // The loud-failure mode task #53 asks for: a resolvable eq() condition
  // whose DB column name has NO matching entry on the given table object —
  // e.g. a fixture mistakenly filtered against the wrong table's export.
  // Before this helper existed, this exact shape silently fell through to
  // `column: undefined` and an empty (not failing) result set.
  it("throws a specific, actionable error when the DB column can't be mapped to a JS key on the given table", () => {
    const wrongTable = { title: { name: "title" } };

    expect(() => eqColumnAndValue(fakeEqCondition("gallery_id", wrongTable, "gallery-1"))).toThrow(
      /DB column "gallery_id" has no matching JS key/,
    );
  });
});
