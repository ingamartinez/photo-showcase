// Proves the harness end to end for the client side (task #165's own
// acceptance criterion: "una captura de una galería autenticado como cliente
// se genera sin intervención manual"). Downstream #140 slices reuse the same
// `captureScreen` helper against whatever client-facing route they redesign.
import { expect, test } from "@playwright/test";
import { captureScreen } from "./capture";
import { CLIENT_STORAGE_STATE_PATH, E2E_GALLERY_PUBLIC_SLUG, VIEWPORT_NAMES } from "./lib/fixtures";

test.use({ storageState: CLIENT_STORAGE_STATE_PATH });

// `formatClientGalleryCardState("proofing").label` in `src/lib/galleries.ts`
// -- task #181 moved this page's status badge off `formatGalleryStatus`
// (the studio's own internal workflow word, "En pruebas") onto the SAME
// client-facing mapping the `/galleries` index already renders, so the
// client never sees the studio's own vocabulary here either. Hardcoded
// rather than imported: that module carries `import "server-only"` and opens
// a Postgres connection, neither of which belongs inside a Playwright spec.
// If the copy ever drifts this spec fails loudly, which is the right outcome
// -- the whole point is that a capture must prove WHICH VARIANT it caught.
const PROOFING_STATUS_LABEL = "Te toca elegir";

for (const viewport of VIEWPORT_NAMES) {
  test(`client gallery renders and captures at ${viewport}`, async ({ page }) => {
    await captureScreen(page, {
      name: "client-gallery",
      route: `/galleries/${E2E_GALLERY_PUBLIC_SLUG}`,
      viewport,
      // THE #179 GUARD, and the reason `expectSelector` exists at all. A
      // gallery left at `selected` renders the LOCKED variant of this exact
      // route, with a 200, at the exact url that was asked for -- and it
      // still looks like a plausible proofing screen. Neither the status
      // check (#169) nor the destination check (#178) can see that; the
      // rendered status label can, because `selected` renders "Alejo está
      // editando" here instead (task #181).
      expectSelector: `text="${PROOFING_STATUS_LABEL}"`,
    });

    // Deliberately kept even though `captureScreen` now performs the
    // equivalent checks itself: this spec's job is to prove the HARNESS
    // works, so it must still fail loudly if those internal guards are ever
    // weakened or removed.
    await expect(page).toHaveURL(new RegExp(`/galleries/${E2E_GALLERY_PUBLIC_SLUG}$`));
    await expect(page.getByText(PROOFING_STATUS_LABEL)).toBeVisible();
  });
}
