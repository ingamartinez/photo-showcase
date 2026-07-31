// Regression tests for task #177: the visual-capture harness used to be racy
// between parallel worktrees because every lane shared one port and one set of
// fixture rows. See `e2e-worktree.ts`'s header for the two independently
// reported failures this prevents, and `refuse-on-production.ts`'s header for
// why a test of harness code lives under `tooling/` and not under `e2e/`
// (short version: `vitest.config.ts` deliberately never looks inside `e2e/**`,
// so a test placed there would silently never run).
import { describe, expect, it } from "vitest";
import {
  CAPTURE_PORT_RANGE_SIZE,
  CAPTURE_PORT_RANGE_START,
  WORKTREE_TAG_LENGTH,
  captureHarnessPort,
  fixtureAdminEmail,
  fixtureClientEmail,
  fixtureGalleryPublicSlug,
  fixtureGalleryTitle,
  worktreeTag,
} from "./e2e-worktree";

// The exact layout the agent harness produces: sibling lane worktrees nested
// INSIDE the main checkout, differing only in the last path segment. Anything
// that derives per-worktree state has to separate these, and the nesting is
// what makes a lazy `startsWith` comparison wrong (see the port test below).
const MAIN_CHECKOUT = "/Users/alejo/projects/photo-showcase";
const LANE_A = `${MAIN_CHECKOUT}/.claude/worktrees/agent-a6dbe7c5de58efc92`;
const LANE_B = `${MAIN_CHECKOUT}/.claude/worktrees/agent-b1122334455667788`;

describe("worktreeTag", () => {
  it("is stable across calls for the same worktree -- a re-run must find its own rows, not orphan them", () => {
    expect(worktreeTag(LANE_A)).toBe(worktreeTag(LANE_A));
  });

  it("differs between two sibling lane worktrees", () => {
    expect(worktreeTag(LANE_A)).not.toBe(worktreeTag(LANE_B));
  });

  it("differs between a lane worktree and the main checkout it is nested inside", () => {
    expect(worktreeTag(LANE_A)).not.toBe(worktreeTag(MAIN_CHECKOUT));
  });

  it("normalizes a trailing slash, so the same worktree never seeds two sets of fixture rows", () => {
    expect(worktreeTag(`${LANE_A}/`)).toBe(worktreeTag(LANE_A));
  });

  it(`is ${WORKTREE_TAG_LENGTH} lowercase hex characters`, () => {
    expect(worktreeTag(LANE_A)).toMatch(new RegExp(`^[0-9a-f]{${WORKTREE_TAG_LENGTH}}$`));
  });
});

describe("captureHarnessPort", () => {
  it("gives two sibling lane worktrees two different ports -- THE #177 race: a shared port let Playwright reuse a sibling's dev server and screenshot the wrong branch", () => {
    expect(captureHarnessPort(LANE_A)).not.toBe(captureHarnessPort(LANE_B));
  });

  it("gives a lane worktree a different port from the main checkout it is nested inside", () => {
    expect(captureHarnessPort(LANE_A)).not.toBe(captureHarnessPort(MAIN_CHECKOUT));
  });

  it("is stable across calls for the same worktree", () => {
    expect(captureHarnessPort(LANE_A)).toBe(captureHarnessPort(LANE_A));
  });

  it("stays inside the declared window -- above the hand-used dev ports, below every ephemeral range", () => {
    for (const root of [MAIN_CHECKOUT, LANE_A, LANE_B]) {
      const port = captureHarnessPort(root);
      expect(port).toBeGreaterThanOrEqual(CAPTURE_PORT_RANGE_START);
      expect(port).toBeLessThan(CAPTURE_PORT_RANGE_START + CAPTURE_PORT_RANGE_SIZE);
      expect(port).not.toBe(3300);
      expect(port).not.toBe(3301);
    }
  });

  it("spreads across the window rather than clustering on one value", () => {
    const ports = new Set(
      Array.from({ length: 200 }, (_, index) =>
        captureHarnessPort(`${MAIN_CHECKOUT}/.claude/worktrees/agent-${index}`),
      ),
    );
    // 200 draws from a 4000-wide window: the birthday-collision expectation is
    // a handful of duplicates, never a cluster. 190 is comfortably below that
    // and comfortably above anything a constant-returning implementation
    // could reach.
    expect(ports.size).toBeGreaterThan(190);
  });

  it("honors an explicit E2E_PORT override", () => {
    expect(captureHarnessPort(LANE_A, "31000")).toBe(31000);
  });

  it("ignores an empty override rather than treating it as a request for port 0", () => {
    expect(captureHarnessPort(LANE_A, "")).toBe(captureHarnessPort(LANE_A));
  });

  it.each(["nope", "3300.5", "80", "70000", "-1"])(
    "refuses the unusable override %j instead of building http://localhost:NaN",
    (override) => {
      expect(() => captureHarnessPort(LANE_A, override)).toThrow(/E2E_PORT must be an integer/);
    },
  );
});

describe("per-worktree fixture identities", () => {
  it("gives two sibling lanes two different client users -- THE #177 race: reseedSession DELETEs every session of the user it re-seeds, which invalidated a sibling's live storageState mid-run", () => {
    expect(fixtureClientEmail(LANE_A)).not.toBe(fixtureClientEmail(LANE_B));
  });

  it("gives two sibling lanes two different admin users", () => {
    expect(fixtureAdminEmail(LANE_A)).not.toBe(fixtureAdminEmail(LANE_B));
  });

  it("gives two sibling lanes two different fixture galleries -- so one lane's submitted selection can never flip the status another lane is capturing (#179)", () => {
    expect(fixtureGalleryPublicSlug(LANE_A)).not.toBe(fixtureGalleryPublicSlug(LANE_B));
  });

  it("keeps admin and client apart within the same worktree", () => {
    expect(fixtureAdminEmail(LANE_A)).not.toBe(fixtureClientEmail(LANE_A));
  });

  it("is stable across calls, so a re-run reuses its own rows", () => {
    expect(fixtureClientEmail(LANE_A)).toBe(fixtureClientEmail(LANE_A));
    expect(fixtureGalleryPublicSlug(LANE_A)).toBe(fixtureGalleryPublicSlug(LANE_A));
  });

  it("keeps the recognizable, obviously-fake shape the old fixed identities had", () => {
    expect(fixtureAdminEmail(LANE_A)).toMatch(
      new RegExp(`^e2e-admin-[0-9a-f]{${WORKTREE_TAG_LENGTH}}@photo-showcase\\.test$`),
    );
    expect(fixtureClientEmail(LANE_A)).toMatch(
      new RegExp(`^e2e-client-[0-9a-f]{${WORKTREE_TAG_LENGTH}}@photo-showcase\\.test$`),
    );
    expect(fixtureGalleryPublicSlug(LANE_A)).toMatch(
      new RegExp(`^e2e-visual-capture-gallery-[0-9a-f]{${WORKTREE_TAG_LENGTH}}$`),
    );
  });

  it("labels the fixture gallery with its worktree tag, so a dev database full of them is readable", () => {
    expect(fixtureGalleryTitle(LANE_A)).toContain(worktreeTag(LANE_A));
    expect(fixtureGalleryTitle(LANE_A)).not.toBe(fixtureGalleryTitle(LANE_B));
  });
});
