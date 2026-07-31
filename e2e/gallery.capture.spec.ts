// Proves the harness end to end for the client side (task #165's own
// acceptance criterion: "una captura de una galería autenticado como cliente
// se genera sin intervención manual"). Downstream #140 slices reuse the same
// `captureScreen` helper against whatever client-facing route they redesign.
import { expect, test } from "@playwright/test";
import { captureScreen } from "./capture";
import { CLIENT_STORAGE_STATE_PATH, E2E_GALLERY_PUBLIC_SLUG, VIEWPORT_NAMES } from "./lib/fixtures";

test.use({ storageState: CLIENT_STORAGE_STATE_PATH });

for (const viewport of VIEWPORT_NAMES) {
  test(`client gallery renders and captures at ${viewport}`, async ({ page }) => {
    await captureScreen(page, {
      name: "client-gallery",
      route: `/galleries/${E2E_GALLERY_PUBLIC_SLUG}`,
      viewport,
    });

    // The seeded client session must actually own the seeded gallery -- a
    // redirect to /login (unauthenticated) or a 404/403 (wrong ownership)
    // would mean the capture above is not the page it claims to be.
    await expect(page).toHaveURL(new RegExp(`/galleries/${E2E_GALLERY_PUBLIC_SLUG}$`));
  });
}
