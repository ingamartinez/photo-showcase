// Task #165's capture helper — the entry point every downstream design-epic
// lane (#125 admin, #140 client; ~17 slices depend on this landing) is meant
// to reuse rather than reinvent. Deliberately simple: one function, one job.
//
//   import { test } from "@playwright/test";
//   import { ADMIN_STORAGE_STATE_PATH, VIEWPORT_NAMES } from "./lib/fixtures";
//   import { captureScreen } from "./capture";
//
//   test.use({ storageState: ADMIN_STORAGE_STATE_PATH });
//
//   for (const viewport of VIEWPORT_NAMES) {
//     test(`dashboard index at ${viewport}`, async ({ page }) => {
//       await captureScreen(page, { name: "dashboard-index", route: "/dashboard", viewport });
//     });
//   }
//
// The PNG lands in `e2e/screenshots/`, already gitignored
// (`/e2e/screenshots/` in .gitignore since this project's initial scaffold)
// -- attach it to the slice's kanban body by hand; it is never committed.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { SCREENSHOT_DIR, VIEWPORTS, type ViewportName } from "./lib/fixtures";

export interface CaptureOptions {
  /** Filename stem -- the viewport name is appended, e.g. "dashboard-index-mobile.png". */
  name: string;
  /** Route to navigate to, relative to `playwright.config.ts`'s `baseURL`. */
  route: string;
  viewport: ViewportName;
}

/**
 * Navigates an authenticated page to `route` at the given viewport, waits for
 * it to settle, and writes a full-page PNG under `e2e/screenshots/`. Returns
 * the absolute path written, in case a caller wants to log or attach it.
 */
export async function captureScreen(page: Page, options: CaptureOptions): Promise<string> {
  const { name, route, viewport } = options;

  await page.setViewportSize(VIEWPORTS[viewport]);
  // NOT `waitUntil: "networkidle"` -- verified empirically against
  // /galleries/[publicSlug]: that page opens a long-lived SSE connection for
  // the live collaborative selection tray (src/lib/selection-events.ts's
  // LISTEN/NOTIFY pub-sub, task #114/#116), which by design never goes idle.
  // `networkidle` waited out its own 30s test timeout every time on that
  // route. `"load"` plus a short settle window below is what Playwright's own
  // docs recommend instead for pages with any open streaming connection.
  await page.goto(route, { waitUntil: "load" });
  await page.waitForTimeout(300);

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const filePath = path.join(SCREENSHOT_DIR, `${name}-${viewport}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}
