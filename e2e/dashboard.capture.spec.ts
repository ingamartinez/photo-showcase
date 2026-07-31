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
    await captureScreen(page, {
      name: "dashboard-index",
      route: "/dashboard",
      viewport,
      // Third guard, on top of the status (#169) and destination (#178)
      // checks `captureScreen` runs for free: a link only the dashboard INDEX
      // renders. `src/app/dashboard/layout.tsx` has no nav links of its own
      // (checked), and the stat tiles that carry this one are rendered in
      // both the empty and the populated state of `src/app/dashboard/
      // page.tsx`, so this is not a bet on how much data the dev database
      // happens to hold.
      expectSelector: 'main a[href="/dashboard/clients"]',
    });

    // Deliberately kept even though `captureScreen` now performs the
    // equivalent check itself: this spec's job is to prove the HARNESS
    // works, so it must still fail loudly if that internal guard is ever
    // weakened or removed.
    await expect(page).toHaveURL(/\/dashboard$/);
  });
}
