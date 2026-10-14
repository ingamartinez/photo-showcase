// Public-site capture for the visual redesign's finish review. The home
// page is the one surface the harness never captured before, and the finish
// reviewer needs a real desktop and mobile render of it.
import { test } from "@playwright/test";
import { captureScreen } from "./capture";
import { VIEWPORT_NAMES } from "./lib/fixtures";

for (const viewport of VIEWPORT_NAMES) {
  test(`public home renders and captures at ${viewport}`, async ({ page }) => {
    await captureScreen(page, {
      name: "home",
      route: "/",
      viewport,
      // The hero's primary action — only the home page renders it, and its
      // presence proves the split-mirror hero (not an error shell) rendered.
      expectSelector: 'a[href="/#work"]',
      // NOT the default "every <img> is complete": the home page lazy-loads
      // grid images below the fold, so on a phone most of them never start
      // and the default gate would wait out the test timeout. The hero image
      // is `priority` and above the fold — that is the one this capture
      // actually needs painted.
      waitFor: async (p) => {
        await p.waitForFunction(() => {
          const hero = document.querySelector("section img");
          return hero instanceof HTMLImageElement && hero.complete;
        });
      },
    });
  });
}
