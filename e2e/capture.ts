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
import { assertNavigationArrived } from "../tooling/e2e-navigation-arrival";
import { SCREENSHOT_DIR, VIEWPORTS, type ViewportName } from "./lib/fixtures";

export interface CaptureOptions {
  /** Filename stem -- the viewport name is appended, e.g. "dashboard-index-mobile.png". */
  name: string;
  /** Route to navigate to, relative to `playwright.config.ts`'s `baseURL`. */
  route: string;
  viewport: ViewportName;
  /**
   * Where the navigation is EXPECTED to end up, if that is not `route`'s own
   * pathname. Only needed for a route that legitimately redirects; leave it
   * unset and the guard requires arrival at the route that was asked for.
   * Compared on pathname, so query params, fragments and trailing slashes are
   * all irrelevant. See `tooling/e2e-navigation-arrival.ts`.
   */
  expectPathname?: string;
  /**
   * A selector that exists ONLY on the screen being captured, asserted after
   * navigation and before the PNG is written.
   *
   * STRONGLY RECOMMENDED, and it is a different guarantee from the two checks
   * `captureScreen` runs for free. Status catches an error page rendered at
   * the requested url (#169); destination catches a redirect that answers 200
   * somewhere else (#178). Neither can catch a page that is genuinely the
   * right route and genuinely 200 but is showing a variant the caller did not
   * mean -- the locked `selected` gallery instead of the `proofing` one is the
   * live example (#179), and it looks like a perfectly plausible proofing
   * screen. Only a positive assertion about the DOM separates those.
   */
  expectSelector?: string;
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

// Deliberately well under Playwright's 30s default test timeout, so a missing
// `expectSelector` reports THIS error rather than the runner's own generic
// "test timeout exceeded", which says nothing about what went wrong.
const EXPECT_TIMEOUT_MS = 10_000;

const DEFAULT_WAIT_FOR = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
};

/**
 * Navigates an authenticated page to `route` at the given viewport, waits for
 * it to settle, and writes a full-page PNG under `e2e/screenshots/`. Returns
 * the absolute path written, in case a caller wants to log or attach it.
 *
 * THROWS INSTEAD OF WRITING ANYTHING unless all of the following hold. Each
 * one exists because the harness once blessed a wrong screenshot without it,
 * and in every case the artifact and the report looked identical to a correct
 * one:
 *
 *  1. The navigation returned a 2xx (#169: 17 captures of 403 pages). A
 *     URL-only assertion in the calling spec cannot catch this -- Next renders
 *     `forbidden()`/`notFound()` at the exact url that was requested, so the
 *     page never navigates away from where the spec expected it to land.
 *  2. The navigation ENDED at the expected pathname (#178: a redirect to
 *     `/login` answers 200, just somewhere else, so check 1 says nothing).
 *  3. `expectSelector`, when the caller supplies one, is present -- the only
 *     one of the three that can tell two variants of the same 200 route apart.
 *
 * See `tooling/e2e-navigation-arrival.ts` for 1 and 2, which are unit-tested
 * there because `vitest.config.ts` never looks inside `e2e/**`.
 */
export async function captureScreen(page: Page, options: CaptureOptions): Promise<string> {
  const {
    name,
    route,
    viewport,
    expectPathname,
    expectSelector,
    waitFor = DEFAULT_WAIT_FOR,
  } = options;

  await page.setViewportSize(VIEWPORTS[viewport]);
  // NOT `waitUntil: "networkidle"` -- verified empirically against
  // /galleries/[publicSlug]: that page opens a long-lived SSE connection for
  // the live collaborative selection tray (src/lib/selection-events.ts's
  // LISTEN/NOTIFY pub-sub, task #114/#116), which by design never goes idle.
  // `networkidle` waited out its own 30s test timeout every time on that
  // route. `"load"` plus the readiness gate below is what Playwright's own
  // docs recommend instead for pages with any open streaming connection.
  const response = await page.goto(route, { waitUntil: "load" });
  // `page.url()`, not `response.url()`: for a redirect chain Playwright's
  // response is the FINAL response, but reading the destination off the page
  // is what a reader of this code expects "where did we end up" to mean, and
  // it also covers a client-side navigation that happened during `load`.
  assertNavigationArrived({
    route,
    finalUrl: page.url(),
    status: response ? response.status() : null,
    statusText: response?.statusText(),
    expectPathname,
  });

  // The real readiness gate (default: every <img> finished loading). The
  // fixed delay below is a FLOOR for final paint/animation settling on top
  // of that, never the sole strategy -- see this option's own doc comment on
  // why a bare sleep cannot stand in for it.
  await waitFor(page);

  // Third guard, and the only one that can tell two variants of the same 200
  // route apart. Run AFTER `waitFor` so a caller can gate on something the
  // page renders late, and BEFORE the screenshot so a miss refuses to write
  // rather than writing and letting the spec complain afterwards.
  if (expectSelector !== undefined) {
    try {
      await page.waitForSelector(expectSelector, { state: "attached", timeout: EXPECT_TIMEOUT_MS });
    } catch {
      // Playwright's own timeout message names the selector but says nothing
      // about why anyone cared, and this failure will be read by whoever is
      // holding a screenshot they were about to attach to a slice.
      throw new Error(
        `Refusing to capture ${route}: the page answered 2xx at the expected pathname, but ` +
          `nothing matching ${JSON.stringify(expectSelector)} appeared within ${EXPECT_TIMEOUT_MS}ms. ` +
          "That is the same route rendering a different thing than the caller meant -- e.g. the " +
          "LOCKED variant of a gallery instead of the proofing one, which still looks like a " +
          "plausible proofing screen (task #179).",
      );
    }
  }

  await page.waitForTimeout(300);

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const filePath = path.join(SCREENSHOT_DIR, `${name}-${viewport}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}
