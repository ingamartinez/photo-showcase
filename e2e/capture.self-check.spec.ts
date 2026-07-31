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
import { expect, test } from "@playwright/test";
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
