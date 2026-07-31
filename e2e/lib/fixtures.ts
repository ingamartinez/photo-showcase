// Shared constants between global-setup.ts (which seeds these rows) and the
// capture specs (which navigate to routes that depend on them). Keeping the
// identifiers in one place means a spec can never drift from what was
// actually seeded.
import path from "node:path";
import {
  captureHarnessPort,
  fixtureAdminEmail,
  fixtureClientEmail,
  fixtureGalleryPublicSlug,
  fixtureGalleryTitle,
  worktreeTag,
} from "../../tooling/e2e-worktree";
import type { FixtureGalleryStatus } from "../../tooling/e2e-fixture-gallery";

// The worktree this run belongs to. `bun run test:e2e` executes from the
// package root, which is this worktree's root -- the same anchor the
// screenshot and storage-state paths at the bottom of this file have always
// used, so if this were wrong nothing here would work anyway.
const WORKTREE_ROOT = process.cwd();

/** Short hex tag identifying this worktree; appears in every derived name below. */
export const E2E_WORKTREE_TAG = worktreeTag(WORKTREE_ROOT);

/** The port `playwright.config.ts` binds this worktree's dev server to. */
export const E2E_PORT = captureHarnessPort(WORKTREE_ROOT, process.env.E2E_PORT);

// Fixed, recognizable, obviously-fake addresses -- never real client data.
//
// PER WORKTREE SINCE TASK #177, and that is the whole point. They used to be
// two fixed addresses shared by every lane, and `global-setup.ts`'s
// `reseedSession` DELETEs every session belonging to the user it re-seeds. Two
// lanes running `test:e2e` at once therefore invalidated each other's live
// `storageState` mid-run: #145 lost its session that way and captured a login
// page for one viewport and the real gallery for the other. Scoping the
// identity to the worktree makes that DELETE touch only this run's own rows,
// WITHOUT serialising the lanes -- which #177 explicitly rules out as "a
// rollback wearing a fix's clothes".
export const E2E_ADMIN_EMAIL = fixtureAdminEmail(WORKTREE_ROOT);
export const E2E_CLIENT_EMAIL = fixtureClientEmail(WORKTREE_ROOT);

// The one gallery this harness seeds, reused by every capture spec that needs
// an authenticated client view of `/galleries/[publicSlug]`. Per worktree for
// the same reason as the identities above: a sibling lane submitting ITS
// selection used to flip THIS run's gallery to `selected`, and the route then
// renders the locked variant, which still looks like a plausible proofing
// screen (task #179).
//
// SEEDED WITH ZERO ASSETS -- see global-setup.ts's `ensureFixtureGallery` call
// for the full note. A capture of this gallery shows the genuine empty state
// ("Tu fotógrafo todavía no subió fotos"), not a populated proof grid.
// Slices #145/#146 (proof grid redesign) need to seed their own `assets`
// rows before that page has anything worth screenshotting.
export const E2E_GALLERY_PUBLIC_SLUG = fixtureGalleryPublicSlug(WORKTREE_ROOT);
export const E2E_GALLERY_TITLE = fixtureGalleryTitle(WORKTREE_ROOT);

// `proofing` is the status a real client most commonly sees: past `draft`
// (invisible to clients) and short of `delivered` (which swaps in
// unwatermarked finals this harness never uploads). Stated as a constant
// rather than left implicit because `global-setup.ts` now ENFORCES it on every
// run instead of only on insert (task #179) -- a slice that needs a different
// variant (the locked `selected` screen, say) changes this call site rather
// than hand-editing a row and hoping it survives the next run.
export const E2E_GALLERY_STATUS: FixtureGalleryStatus = "proofing";

// node_modules/@auth/core's `defaultCookies(useSecureCookies)` names the
// session cookie `authjs.session-token` unless `useSecureCookies` is true
// (verified against node_modules/@auth/core/lib/utils/cookie.js), which only
// happens over https. `next dev` always serves plain http on localhost, so
// this is the exact cookie name a real browser would receive from a real
// magic-link sign-in — seeding it directly does not require inventing a
// different cookie shape than production traffic gets.
export const AUTH_SESSION_COOKIE_NAME = "authjs.session-token";

// Already gitignored (`/playwright/.cache/`) since this project's initial
// scaffold — see .gitignore's "testing" section — so these never need a
// gitignore edit of their own. They are per-worktree for free: `process.cwd()`
// is this worktree.
const STORAGE_STATE_DIR = path.join(WORKTREE_ROOT, "playwright", ".cache");
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
export const SCREENSHOT_DIR = path.join(WORKTREE_ROOT, "e2e", "screenshots");
