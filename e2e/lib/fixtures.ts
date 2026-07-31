// Shared constants between global-setup.ts (which seeds these rows) and the
// capture specs (which navigate to routes that depend on them). Keeping the
// identifiers in one place means a spec can never drift from what was
// actually seeded.
import path from "node:path";

// Fixed, recognizable addresses — never real client data, and distinct
// enough from anything a photographer would plausibly type that they can't
// collide with genuine rows in the same dev database this harness runs
// against.
export const E2E_ADMIN_EMAIL = "e2e-admin@photo-showcase.test";
export const E2E_CLIENT_EMAIL = "e2e-client@photo-showcase.test";

// The one gallery this harness seeds, reused by every capture spec that needs
// an authenticated client view of `/galleries/[publicSlug]`. `proofing` is
// the status a real client most commonly sees: past `draft` (visible to
// clients) and short of `delivered` (which swaps in unwatermarked finals this
// harness never uploads).
//
// SEEDED WITH ZERO ASSETS -- see global-setup.ts's `ensureFixtureGallery` for
// the full note. A capture of this gallery shows the genuine empty state
// ("Tu fotógrafo todavía no subió fotos"), not a populated proof grid.
// Slices #145/#146 (proof grid redesign) need to seed their own `assets`
// rows before that page has anything worth screenshotting.
export const E2E_GALLERY_PUBLIC_SLUG = "e2e-visual-capture-gallery";
export const E2E_GALLERY_TITLE = "Sesión de prueba (harness de captura)";

// node_modules/@auth/core's `defaultCookies(useSecureCookies)` names the
// session cookie `authjs.session-token` unless `useSecureCookies` is true
// (verified against node_modules/@auth/core/lib/utils/cookie.js), which only
// happens over https. `bun run dev` always serves plain http on localhost, so
// this is the exact cookie name a real browser would receive from a real
// magic-link sign-in — seeding it directly does not require inventing a
// different cookie shape than production traffic gets.
export const AUTH_SESSION_COOKIE_NAME = "authjs.session-token";

// Already gitignored (`/playwright/.cache/`) since this project's initial
// scaffold — see .gitignore's "testing" section — so these never need a
// gitignore edit of their own.
const STORAGE_STATE_DIR = path.join(process.cwd(), "playwright", ".cache");
export const ADMIN_STORAGE_STATE_PATH = path.join(STORAGE_STATE_DIR, "admin-storage-state.json");
export const CLIENT_STORAGE_STATE_PATH = path.join(STORAGE_STATE_DIR, "client-storage-state.json");

// Task #165's own acceptance criterion: 390px (mobile) and desktop. 390 is
// iPhone 12/13/14's CSS width — the exact figure several downstream design
// slices (#142, #145) name explicitly, so this is not an arbitrary "a mobile
// size".
export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;
export const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

// Already gitignored (`/e2e/screenshots/`) since this project's initial
// scaffold, same as the storage-state directory above.
export const SCREENSHOT_DIR = path.join(process.cwd(), "e2e", "screenshots");
