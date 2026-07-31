// Proves the harness end to end for the admin side (task #165's own
// acceptance criterion: "una captura de /dashboard autenticado como admin se
// genera sin intervención manual"). Downstream #125 slices reuse the same
// `captureScreen` helper against whatever route they redesign.
import { expect, test } from "@playwright/test";
import { captureScreen } from "./capture";
import { ADMIN_STORAGE_STATE_PATH, VIEWPORT_NAMES } from "./lib/fixtures";

test.use({ storageState: ADMIN_STORAGE_STATE_PATH });

for (const viewport of VIEWPORT_NAMES) {
  test(`admin dashboard renders and captures at ${viewport}`, async ({ page }) => {
    await captureScreen(page, { name: "dashboard-index", route: "/dashboard", viewport });

    // The seeded admin session must actually be authenticated -- a redirect
    // back to /login would mean the capture above is a screenshot of the
    // login wall, not the dashboard.
    await expect(page).toHaveURL(/\/dashboard$/);
  });
}
