// Task #178. The headline case is `redirects to /login`: it is the one that
// actually happened (#145), it returns a perfectly legitimate 200, and the
// screenshot it produces looks like a plausible page to anyone who was not
// there. Everything else here exists so the fix for it cannot be a naive
// string comparison -- #178 named that trap explicitly, and the trailing
// slash / query param / fragment cases below are what would break if someone
// "simplified" this to `finalUrl === route`.
import { describe, expect, it } from "vitest";
import { assertNavigationArrived, normalizeRoutePathname } from "./e2e-navigation-arrival";

const BASE = "http://localhost:24123";

describe("normalizeRoutePathname", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/dashboard/", "/dashboard"],
    ["/dashboard?tab=all", "/dashboard"],
    ["/dashboard#top", "/dashboard"],
    [`${BASE}/dashboard`, "/dashboard"],
    [`${BASE}/dashboard/?tab=all#top`, "/dashboard"],
    ["/", "/"],
    [`${BASE}/`, "/"],
    [
      "/galleries/e2e-visual-capture-gallery-a1b2c3d4",
      "/galleries/e2e-visual-capture-gallery-a1b2c3d4",
    ],
  ])("reduces %j to %j", (input, expected) => {
    expect(normalizeRoutePathname(input)).toBe(expected);
  });

  it("does not collapse a nested path into its parent", () => {
    expect(normalizeRoutePathname("/dashboard/galleries")).not.toBe(
      normalizeRoutePathname("/dashboard"),
    );
  });
});

describe("assertNavigationArrived", () => {
  describe("the redirect the status check is blind to (#178)", () => {
    it("throws when a 200 arrived at /login instead of the requested /dashboard -- THE bug: #145 captured the login wall for one viewport and the real screen for the other, and the harness said nothing", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/login?callbackUrl=%2Fdashboard`,
          status: 200,
          statusText: "OK",
        }),
      ).toThrow(/ended at "\/login", not "\/dashboard"/);
    });

    it("throws when a client gallery redirected to /login mid-run", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/galleries/e2e-visual-capture-gallery-a1b2c3d4",
          finalUrl: `${BASE}/login`,
          status: 200,
        }),
      ).toThrow(/Refusing to capture \/galleries\/e2e-visual-capture-gallery-a1b2c3d4/);
    });

    it("throws when a 200 landed on the marketing home page instead of the requested screen", () => {
      expect(() =>
        assertNavigationArrived({ route: "/dashboard", finalUrl: `${BASE}/`, status: 200 }),
      ).toThrow(/ended at "\/", not "\/dashboard"/);
    });

    it("names the real final url in the message, so whoever reads the failure can see where it went", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/login?callbackUrl=%2Fdashboard`,
          status: 200,
        }),
      ).toThrow(/final url http:\/\/localhost:24123\/login\?callbackUrl=%2Fdashboard/);
    });
  });

  describe("legitimate arrivals it must NOT reject (the #178 trap: no exact-string comparison)", () => {
    it("accepts a trailing slash on the final url", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/dashboard/`,
          status: 200,
        }),
      ).not.toThrow();
    });

    it("accepts query params the app appended on arrival", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard/galleries",
          finalUrl: `${BASE}/dashboard/galleries?status=proofing`,
          status: 200,
        }),
      ).not.toThrow();
    });

    it("accepts a route the caller wrote WITH query params", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard/galleries?status=proofing",
          finalUrl: `${BASE}/dashboard/galleries`,
          status: 200,
        }),
      ).not.toThrow();
    });

    it("accepts a fragment the page added", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/dashboard#seleccion`,
          status: 200,
        }),
      ).not.toThrow();
    });

    it("accepts any 2xx, not only 200", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/dashboard`,
          status: 204,
        }),
      ).not.toThrow();
    });
  });

  describe("expectPathname, for a route that is MEANT to redirect", () => {
    it("accepts the declared destination", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/galleries/some-slug",
          finalUrl: `${BASE}/login`,
          status: 200,
          expectPathname: "/login",
        }),
      ).not.toThrow();
    });

    it("still rejects a destination that is not the declared one -- declaring an expectation must not switch the guard off", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/galleries/some-slug",
          finalUrl: `${BASE}/login`,
          status: 200,
          expectPathname: "/dashboard",
        }),
      ).toThrow(/ended at "\/login", not "\/dashboard"/);
    });
  });

  describe("the status guard #169 added, kept intact", () => {
    it("throws on a 403 rendered at the requested url", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/dashboard`,
          status: 403,
          statusText: "Forbidden",
        }),
      ).toThrow(/returned 403 Forbidden/);
    });

    it("throws on a 404 rendered at the requested url", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/dashboard`,
          status: 404,
          statusText: "Not Found",
        }),
      ).toThrow(/returned 404 Not Found/);
    });

    it("throws when there was no response at all", () => {
      expect(() =>
        assertNavigationArrived({
          route: "/dashboard",
          finalUrl: `${BASE}/dashboard`,
          status: null,
        }),
      ).toThrow(/returned no response/);
    });

    it("reports the status, not the destination, when BOTH are wrong -- the status is the more specific diagnosis", () => {
      expect(() =>
        assertNavigationArrived({ route: "/dashboard", finalUrl: `${BASE}/login`, status: 500 }),
      ).toThrow(/returned 500/);
    });
  });
});
