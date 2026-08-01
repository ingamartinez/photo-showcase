import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeQuota } from "./quota";

// Estándar package terms (PLAN.md §3), used across every case below so the
// only thing that varies per test is the counts. `originalPhotoPriceCopSnapshot`
// is task #205's addition — 2_000, the owner's chosen default
// (scripts/seed-packages.ts / schema.ts).
const SNAPSHOT = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  originalPhotoPriceCopSnapshot: 2_000,
};

describe("computeQuota", () => {
  // Acceptance criterion 1 — with zero originals, computeQuota must produce
  // EXACTLY what it did before task #205: same `extras`, same `surchargeCop`.
  // This is the non-regression guarantee for every gallery in production,
  // none of which has ever had an "original" pick (task #206 is what would
  // first let one exist).
  describe("zero originals — byte-identical to the pre-#205 formula (criterion 1)", () => {
    it("zero selected: no extras, no surcharge", () => {
      expect(computeQuota(0, 0, SNAPSHOT)).toEqual({
        selected: 0,
        selectedEdited: 0,
        selectedOriginal: 0,
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        originalPhotoPriceCopSnapshot: 2_000,
        extras: 0,
        originals: 0,
        extrasSurchargeCop: 0,
        originalsSurchargeCop: 0,
        surchargeCop: 0,
      });
    });

    it("exactly the included count: still no extras, no surcharge", () => {
      expect(computeQuota(13, 0, SNAPSHOT)).toEqual({
        selected: 13,
        selectedEdited: 13,
        selectedOriginal: 0,
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        originalPhotoPriceCopSnapshot: 2_000,
        extras: 0,
        originals: 0,
        extrasSurchargeCop: 0,
        originalsSurchargeCop: 0,
        surchargeCop: 0,
      });
    });

    it("one over the included count: exactly one extra, one extra's worth of surcharge", () => {
      expect(computeQuota(14, 0, SNAPSHOT)).toEqual({
        selected: 14,
        selectedEdited: 14,
        selectedOriginal: 0,
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        originalPhotoPriceCopSnapshot: 2_000,
        extras: 1,
        originals: 0,
        extrasSurchargeCop: 5_000,
        originalsSurchargeCop: 0,
        surchargeCop: 5_000,
      });
    });

    it("far over the included count: extras and surcharge scale linearly, never blocked", () => {
      expect(computeQuota(30, 0, SNAPSHOT)).toEqual({
        selected: 30,
        selectedEdited: 30,
        selectedOriginal: 0,
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        originalPhotoPriceCopSnapshot: 2_000,
        extras: 17,
        originals: 0,
        extrasSurchargeCop: 85_000,
        originalsSurchargeCop: 0,
        surchargeCop: 85_000,
      });
    });

    // Defensive: `selectedEdited` should never be lower than 0 in practice,
    // but extras must never go negative even if it somehow were — "going
    // over the quota is upsell", not "going under produces a credit".
    it("never reports negative extras when selectedEdited is under the included count", () => {
      const result = computeQuota(-1, 0, SNAPSHOT);
      expect(result.extras).toBe(0);
      expect(result.surchargeCop).toBe(0);
    });
  });

  // Acceptance criterion 2 — originals add to the surcharge ON TOP of the
  // edited extras, and never consume the included-photos quota.
  describe("with originals (criterion 2)", () => {
    it("originals under the included count still surcharge in full — the quota never covers them", () => {
      // 5 edited, well under the 13 included -> 0 edited extras. 3 originals,
      // charged regardless of the quota having room to spare.
      const result = computeQuota(5, 3, SNAPSHOT);
      expect(result.extras).toBe(0);
      expect(result.originals).toBe(3);
      expect(result.surchargeCop).toBe(3 * 2_000);
      expect(result.selected).toBe(8);
    });

    it("originals surcharge sums on top of an already-existing edited surcharge", () => {
      // 15 edited -> 2 over the 13 included -> 10_000 edited surcharge.
      // 4 originals -> 8_000 more, additive, not a replacement.
      const result = computeQuota(15, 4, SNAPSHOT);
      expect(result.extras).toBe(2);
      expect(result.originals).toBe(4);
      expect(result.surchargeCop).toBe(2 * 5_000 + 4 * 2_000);
    });

    // Task #206's own addition: `extrasSurchargeCop`/`originalsSurchargeCop`,
    // the pre-multiplied halves `surchargeCop` is built from — added so
    // `selection-counter.tsx`/`submit-selection-panel.tsx` can show a
    // two-tariff breakdown without ever multiplying anything themselves.
    it("splits the surcharge into its edited-only and originals-only halves, which sum to the total", () => {
      const result = computeQuota(15, 4, SNAPSHOT);
      expect(result.extrasSurchargeCop).toBe(2 * 5_000);
      expect(result.originalsSurchargeCop).toBe(4 * 2_000);
      expect(result.extrasSurchargeCop + result.originalsSurchargeCop).toBe(result.surchargeCop);
    });
  });

  // Acceptance criterion 3 — THE test that actually distinguishes a correct
  // implementation: BOTH summands non-zero, with numbers chosen so neither
  // term is a multiple of the other and the total cannot be produced by an
  // implementation that ignores either term. Deliberately NOT the task
  // body's own worked example (10 edited + 5 originals @ 2_000 = 15 edited @
  // no-extras coincidence at 13 included) — that example is called out by
  // name in the kanban task as a numeric coincidence that would pass even if
  // originals were silently ignored (10 edited under 13 included -> 0 edited
  // extras either way) or, at 20 included, if edited-extras were ignored.
  // This fixture uses DIFFERENT included/price numbers specifically so
  // dropping either term changes the total.
  it("mixed case: edited extras AND originals both non-zero, and both required to reach the total (criterion 3)", () => {
    const snapshot = {
      includedPhotosSnapshot: 7,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
    };
    // 9 edited -> 2 over the 7 included -> 2 * 5_000 = 10_000 edited surcharge.
    // 3 originals -> 3 * 2_000 = 6_000 more.
    // Total 16_000 — reachable ONLY by summing both terms: an implementation
    // that ignored originals would report 10_000, one that ignored edited
    // extras would report 6_000, and one that let originals draw from the
    // quota (rejected by the owner) would report yet a different number.
    const result = computeQuota(9, 3, snapshot);
    expect(result.extras).toBe(2);
    expect(result.originals).toBe(3);
    expect(result.surchargeCop).toBe(16_000);
    expect(result.selected).toBe(12);
    expect(result.extrasSurchargeCop).toBe(10_000);
    expect(result.originalsSurchargeCop).toBe(6_000);
  });

  // Acceptance criterion 8 — this module must never import `@/lib/db` or
  // `packages`, so it stays callable with plain numbers, no mock, no async
  // setup, from both a Server Component and a Route Handler.
  //
  // REVIEW FINDING, FIXED (task #205, round 2): the test this replaced —
  // "is a pure function: same inputs, same output" — called `computeQuota`
  // twice and `toEqual`'d the results. Any function returning a fresh object
  // literal passes that unconditionally; it could not have caught an added
  // `@/lib/db`/`packages` import, which is what this criterion actually
  // asks. A real static-import guard, reading this module's own SOURCE TEXT
  // rather than calling it, is the only thing that actually tests "imports
  // nothing" — this is the one criterion in the whole slice a runtime call
  // genuinely cannot observe.
  // Task #209: the original regex (`/^\s*import\b/`) only ever looked at the
  // START of a line, so it caught a static `import … from` but sailed
  // straight past a dynamic `await import(...)` or a `require(...)` call
  // buried inside the function body — either would give this module the
  // exact I/O access criterion 8 forbids while leaving the guard green. This
  // widened pattern also matches `import(`/`require(` anywhere on a line, not
  // just at column 0. It does NOT strip comments or strings first (the repo
  // has been burned by comment-stripping regexes hiding real code behind a
  // stray `//` inside a URL) — it scans the raw source text, so it can only
  // ever be too strict (flagging a legitimate `import type` or the literal
  // word "import(" inside a comment), never too permissive.
  it("never imports @/lib/db or @/lib/db/schema — computeQuota takes plain numbers, does no I/O", () => {
    const source = readFileSync(new URL("./quota.ts", import.meta.url), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b|\bimport\s*\(|\brequire\s*\(/.test(line));

    expect(importLines).toEqual([]);
  });
});
