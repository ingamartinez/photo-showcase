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
  /**
   * Extra readiness gate, run after navigation succeeds and before the
   * screenshot. Defaults to waiting for every `<img>` present on the page to
   * finish loading (`[...document.images].every((img) => img.complete)`).
   *
   * WHAT THIS DEFAULT ACTUALLY GUARANTEES, measured (task #169): for an
   * `<img>` already present in the INITIAL HTML, it adds NOTHING -- `page.goto`
   * below already uses `waitUntil: "load"`, which itself blocks on every
   * image the initial HTML declares (2364ms with this default vs. 2347ms with
   * a no-op `waitFor`, against a 2s-delayed image). The default earns its keep
   * only for a LATE navigation where `"load"` already fired and something is
   * still settling.
   *
   * THE CASE THIS DEFAULT DOES NOT COVER: an `<img>` that does not exist yet
   * when this gate runs -- e.g. one a client component injects into the DOM
   * some time AFTER `load` (a skeleton-then-swap pattern, a tab that mounts
   * lazily, etc). `[...document.images]` is empty at that point, so
   * `.every()` is vacuously `true` and the capture fires before the image
   * exists (measured: 345ms, i.e. it did not wait at all). This default has
   * no way to know an image is *coming*; it only ever inspects images that
   * already exist in the DOM.
   *
   * Today every screen this harness captures renders its `<img>`s eagerly,
   * server-side, in the initial HTML (`src/components/asset-tile.tsx`'s proof
   * thumbnails included), so the vacuous-empty-list case does not currently
   * bite. It WILL bite the moment a redesign renders a tile after an initial
   * paint. A caller whose route can inject images after `load` -- #145/#146's
   * proofing grid redesign is the flagged case -- MUST pass its own `waitFor`
   * (e.g. `page.waitForSelector` on a rendered tile) rather than rely on this
   * default; do not assume the default protects you just because it did the
   * last time. Pass a no-op (`async () => {}`) to opt out entirely for a
   * route with nothing to wait for.
   */
  waitFor?: (page: Page) => Promise<void>;
}

const DEFAULT_WAIT_FOR = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
};

/**
 * Navigates an authenticated page to `route` at the given viewport, waits for
 * it to settle, and writes a full-page PNG under `e2e/screenshots/`. Returns
 * the absolute path written, in case a caller wants to log or attach it.
 *
 * Throws instead of writing anything if the navigation itself did not return
 * a 2xx response -- task #165's own review found this harness had been
 * capturing, and reporting as a PASS, a full-page screenshot of a 403 (an
 * authenticated-but-unauthorized session). A URL-only assertion in a calling
 * spec cannot catch that: Next renders `forbidden()`/`notFound()` at the
 * exact url that was requested, so the page never navigates away from where
 * the spec expected it to land. Checking the actual HTTP response status is
 * the one signal that is not fooled by that.
 */
export async function captureScreen(page: Page, options: CaptureOptions): Promise<string> {
  const { name, route, viewport, waitFor = DEFAULT_WAIT_FOR } = options;

  await page.setViewportSize(VIEWPORTS[viewport]);
  // NOT `waitUntil: "networkidle"` -- verified empirically against
  // /galleries/[publicSlug]: that page opens a long-lived SSE connection for
  // the live collaborative selection tray (src/lib/selection-events.ts's
  // LISTEN/NOTIFY pub-sub, task #114/#116), which by design never goes idle.
  // `networkidle` waited out its own 30s test timeout every time on that
  // route. `"load"` plus the readiness gate below is what Playwright's own
  // docs recommend instead for pages with any open streaming connection.
  const response = await page.goto(route, { waitUntil: "load" });
  if (!response || !response.ok()) {
    throw new Error(
      `Refusing to capture ${route}: navigation returned ` +
        `${response ? `${response.status()} ${response.statusText()}` : "no response"}. ` +
        "A non-2xx response (e.g. a 403 from forbidden() for an unauthorized session, or a " +
        "404 from notFound()) renders at the SAME url the caller expected, so this check -- " +
        "not a URL assertion in the calling spec -- is what catches it before a screenshot of " +
        "an error page gets written and reported as a pass.",
    );
  }

  // The real readiness gate (default: every <img> finished loading). The
  // fixed delay below is a FLOOR for final paint/animation settling on top
  // of that, never the sole strategy -- see this option's own doc comment on
  // why a bare sleep cannot stand in for it.
  await waitFor(page);
  await page.waitForTimeout(300);

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const filePath = path.join(SCREENSHOT_DIR, `${name}-${viewport}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}
