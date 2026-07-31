// Covers the visual-capture harness's production guard (task #165) -- see
// refuse-on-production.ts's own header for why this test lives under
// `tooling/` rather than `e2e/lib/` (short version: `vitest.config.ts`
// deliberately never looks inside `e2e/**`, so a test placed there would
// never run).
//
// The #165 review's finding, reproduced here as a permanent regression test
// rather than a one-off manual check: the FIRST version of this guard only
// refused when `APP_ENV === "production"`, which fails OPEN on an unset
// `APP_ENV` -- exactly the shape of an admin SSH'd onto the droplet with a
// shell that never sourced `release.env`. Every test below that expects a
// throw for an unset/unexpected `APP_ENV` is a direct regression test for
// that exact bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DROPLET_ROOT_MARKER, refuseUnlessDevEnvironment } from "./refuse-on-production";

describe("refuseUnlessDevEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("the droplet filesystem marker, checked before APP_ENV", () => {
    it(`throws when ${DROPLET_ROOT_MARKER} exists, regardless of a safe-looking APP_ENV`, () => {
      expect(() =>
        refuseUnlessDevEnvironment({ appEnv: "development", rootMarkerExists: () => true }),
      ).toThrow(new RegExp(DROPLET_ROOT_MARKER.replace(/\//g, "\\/")));
    });

    it("does not throw for that reason when the marker is absent and APP_ENV is allowlisted", () => {
      expect(() =>
        refuseUnlessDevEnvironment({ appEnv: "development", rootMarkerExists: () => false }),
      ).not.toThrow();
    });
  });

  describe("the APP_ENV allowlist -- fails CLOSED, not open, on anything unexpected", () => {
    const rootMarkerExists = () => false;

    it("throws when APP_ENV is entirely unset -- the exact shape of an un-sourced droplet shell that let the original bug through", () => {
      expect(() => refuseUnlessDevEnvironment({ appEnv: undefined, rootMarkerExists })).toThrow(
        /APP_ENV must be explicitly set/,
      );
    });

    it("throws when APP_ENV is the empty string", () => {
      expect(() => refuseUnlessDevEnvironment({ appEnv: "", rootMarkerExists })).toThrow(
        /APP_ENV must be explicitly set/,
      );
    });

    it("throws when APP_ENV is production", () => {
      expect(() => refuseUnlessDevEnvironment({ appEnv: "production", rootMarkerExists })).toThrow(
        /APP_ENV must be explicitly set/,
      );
    });

    it("throws for an unrecognized value -- a typo or a future environment name must refuse, not pass through", () => {
      expect(() => refuseUnlessDevEnvironment({ appEnv: "staging", rootMarkerExists })).toThrow(
        /APP_ENV must be explicitly set/,
      );
    });

    it("does not throw for APP_ENV=development", () => {
      expect(() =>
        refuseUnlessDevEnvironment({ appEnv: "development", rootMarkerExists }),
      ).not.toThrow();
    });

    it("does not throw for APP_ENV=test -- what package.json's test:e2e script sets", () => {
      expect(() => refuseUnlessDevEnvironment({ appEnv: "test", rootMarkerExists })).not.toThrow();
    });
  });

  it("reads process.env.APP_ENV and the real filesystem when no deps are injected", () => {
    // No injected deps at all: exercises the actual default wiring
    // (`process.env.APP_ENV`, `existsSync(DROPLET_ROOT_MARKER)`) rather than
    // only the injectable seams above. `vi.stubEnv` forces APP_ENV to an
    // unallowlisted value for the duration of this test -- same precedent as
    // `scripts/lib/assert-app-env.test.ts` -- so this assertion holds
    // regardless of whatever a developer's own shell happens to export (see
    // task #169: `deps.appEnv ?? process.env.APP_ENV` used to make an
    // injected `undefined` indistinguishable from "not injected", which made
    // THIS test and the one above it turn red on any machine with
    // APP_ENV=development already exported).
    vi.stubEnv("APP_ENV", "staging");
    expect(() => refuseUnlessDevEnvironment()).toThrow();
  });
});
