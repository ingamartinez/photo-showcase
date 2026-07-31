// Regression test for the #165 review's blocking finding: `captureScreen`
// used to write, and its caller reported as a PASS, a full-page screenshot
// of a 403 page -- because a URL-only assertion in the calling spec cannot
// tell "landed on the intended url" apart from "an error rendered AT that
// same url" (Next's `forbidden()`/`notFound()` do exactly that; they never
// redirect). This exercises `captureScreen` directly, against routes this
// spec controls entirely via `page.route()`, so it needs neither the seeded
// sessions nor a real page from the app -- only the helper's own contract.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { captureScreen } from "./capture";
import { SCREENSHOT_DIR } from "./lib/fixtures";

test.describe("captureScreen refuses to write a screenshot of a non-2xx response", () => {
  test("throws on a 403 instead of capturing it", async ({ page }) => {
    await page.route("**/blocked-403", (route) =>
      route.fulfill({
        status: 403,
        contentType: "text/html",
        body: "<h1>403 — This page could not be accessed.</h1>",
      }),
    );

    const filePath = path.join(SCREENSHOT_DIR, "self-check-403-desktop.png");
    // Self-isolating: a stale PNG left behind by an earlier run (e.g. someone
    // manually breaking the guard to poke at it) must not make THIS clean run
    // fail for the wrong reason -- the assertion below has to prove capture
    // never wrote the file just now, not merely that the file doesn't exist
    // for whatever reason.
    await rm(filePath, { force: true });

    await expect(
      captureScreen(page, { name: "self-check-403", route: "/blocked-403", viewport: "desktop" }),
    ).rejects.toThrow(/returned 403/);

    // The exact bug this guards against: the PNG must never land on disk for
    // a refused capture, or a caller scanning the screenshots directory
    // afterwards would still find (and could still attach) the error page.
    expect(existsSync(filePath)).toBe(false);
  });

  test("throws on a 404 instead of capturing it", async ({ page }) => {
    await page.route("**/missing-404", (route) =>
      route.fulfill({ status: 404, contentType: "text/html", body: "<h1>Not found</h1>" }),
    );

    await expect(
      captureScreen(page, { name: "self-check-404", route: "/missing-404", viewport: "mobile" }),
    ).rejects.toThrow(/returned 404/);
  });

  test("captures normally for an ordinary 200 page", async ({ page }) => {
    await page.route("**/ok-200", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<h1>ok</h1>" }),
    );

    const filePath = await captureScreen(page, {
      name: "self-check-200",
      route: "/ok-200",
      viewport: "desktop",
      waitFor: async () => {}, // no <img>s on this stub page to wait for
    });

    expect(existsSync(filePath)).toBe(true);
    await rm(filePath, { force: true });
  });
});

// Task #178, exercised through the real browser rather than only through
// `tooling/e2e-navigation-arrival.test.ts`'s pure unit tests: those prove the
// DECISION, this proves `captureScreen` actually feeds it the post-redirect
// url. The two together are what the guard is.
test.describe("captureScreen refuses to write a screenshot taken after a redirect", () => {
  const stubLoginWall = async (page: Page) => {
    await page.route("**/needs-session", (route) =>
      route.fulfill({
        status: 302,
        headers: { location: "/login?callbackUrl=%2Fneeds-session" },
        body: "",
      }),
    );
    await page.route("**/login**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Entrá a tu galería</h1>",
      }),
    );
  };

  test("throws on a 200 served at /login instead of the requested route", async ({ page }) => {
    await stubLoginWall(page);

    const filePath = path.join(SCREENSHOT_DIR, "self-check-redirect-desktop.png");
    await rm(filePath, { force: true });

    await expect(
      captureScreen(page, {
        name: "self-check-redirect",
        route: "/needs-session",
        viewport: "desktop",
        waitFor: async () => {},
      }),
      // The exact shape of the #145 incident: a session deleted by a sibling
      // worktree's globalSetup, a clean 200, and a screenshot of the login
      // wall that the old status-only guard was perfectly happy with.
    ).rejects.toThrow(/ended at "\/login", not "\/needs-session"/);

    expect(existsSync(filePath)).toBe(false);
  });

  test("captures the login wall anyway when the caller DECLARES it expects to land there", async ({
    page,
  }) => {
    await stubLoginWall(page);

    const filePath = await captureScreen(page, {
      name: "self-check-redirect-declared",
      route: "/needs-session",
      viewport: "desktop",
      expectPathname: "/login",
      waitFor: async () => {},
    });

    expect(existsSync(filePath)).toBe(true);
    await rm(filePath, { force: true });
  });
});

// Task #179's half of the same family: right url, right status, WRONG SCREEN.
// Nothing about the response can tell those apart -- only the DOM can.
test.describe("captureScreen refuses to write when expectSelector never appears", () => {
  test("throws instead of capturing a 200 that is the wrong variant of the right route", async ({
    page,
  }) => {
    await page.route("**/locked-variant", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<span class="label">Selección enviada</span>',
      }),
    );

    const filePath = path.join(SCREENSHOT_DIR, "self-check-selector-desktop.png");
    await rm(filePath, { force: true });

    await expect(
      captureScreen(page, {
        name: "self-check-selector",
        route: "/locked-variant",
        viewport: "desktop",
        expectSelector: 'text="En pruebas"',
        waitFor: async () => {},
      }),
    ).rejects.toThrow(/nothing matching .*En pruebas.* appeared/);

    expect(existsSync(filePath)).toBe(false);
  });

  test("captures when the selector is there", async ({ page }) => {
    await page.route("**/proofing-variant", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<span class="label">En pruebas</span>',
      }),
    );

    const filePath = await captureScreen(page, {
      name: "self-check-selector-ok",
      route: "/proofing-variant",
      viewport: "desktop",
      expectSelector: 'text="En pruebas"',
      waitFor: async () => {},
    });

    expect(existsSync(filePath)).toBe(true);
    await rm(filePath, { force: true });
  });
});
