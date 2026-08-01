// Proves the harness for the client gallery INDEX (`/galleries`, task #143 /
// #180) — nothing captured this route before, at any width, and that gap is
// precisely how #180's own review had to catch a contrast regression by hand
// (real Chromium, a blown-out photo, pixel sampling) instead of a screenshot
// already existing to look at.
//
// SCOPE, DELIBERATELY LIMITED TO THE FALLBACK CARD: this harness's fixture
// gallery has no cover (`galleries.coverAssetId` is nullable, and there is no
// admin surface yet that writes it — see #191). Seeding one here, the way
// #145 seeded proof assets for a populated grid, would need an extra write
// this task's own review explicitly did NOT ask for: "It can only exercise
// the fallback card until a cover can actually be set, and that is fine —
// pin what exists." So this pins task #143's original bordered, text-forward
// card — the state EVERY gallery is in until #191 ships an admin surface to
// pick one — not the photo-card variant.
import { expect, test } from "@playwright/test";
import { captureScreen } from "./capture";
import { CLIENT_STORAGE_STATE_PATH, E2E_GALLERY_TITLE, VIEWPORT_NAMES } from "./lib/fixtures";

test.use({ storageState: CLIENT_STORAGE_STATE_PATH });

// `formatClientGalleryCardState("proofing").label` in `src/lib/galleries.ts`
// — same client-facing word task #181 moved the gallery DETAIL page onto,
// reused here rather than retyped a second time. Hardcoded rather than
// imported for the same reason `gallery.capture.spec.ts` hardcodes its own
// copy of this string: that module carries `import "server-only"` and opens
// a Postgres connection, neither of which belongs inside a Playwright spec.
const PROOFING_STATE_LABEL = "Te toca elegir";

for (const viewport of VIEWPORT_NAMES) {
  test(`client gallery index renders and captures at ${viewport}`, async ({ page }) => {
    await captureScreen(page, {
      name: "gallery-index",
      route: "/galleries",
      viewport,
      // The fixture gallery's own title, inside the fallback card — proves
      // the finished list (not the empty state, not a login redirect)
      // actually rendered.
      expectSelector: `text="${E2E_GALLERY_TITLE}"`,
    });

    await expect(page).toHaveURL(/\/galleries$/);
    await expect(page.getByText(PROOFING_STATE_LABEL)).toBeVisible();
    // The fallback card, not the photo card: no cover exists on this
    // fixture gallery (see this file's own header comment), so an <img>
    // appearing here would mean either a regression that renders a broken
    // cover box, or a future change to the fixture that this spec's scope
    // comment above needs to be revisited alongside.
    await expect(page.locator("main img")).toHaveCount(0);
  });
}
