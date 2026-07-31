// Per-worktree identity for the local visual-capture harness (task #177).
//
// THE BUG THIS FILE EXISTS TO REMOVE. The agent harness that runs this board
// creates several git worktrees at once, one per lane, and every lane runs
// `bun run test:e2e` against the SAME developer machine and the SAME dev
// database. Before this file, every one of those runs shared:
//
//   * one TCP port (:3300, hard-coded in `playwright.config.ts`), reused by
//     Playwright without ever checking WHOSE dev server was already bound to
//     it -- so a lane could screenshot a sibling's branch and report it as its
//     own. Two independent lanes (#143, #130) found this separately, #130 by
//     inspecting each listening PID's `cwd` before trusting a screenshot.
//   * one pair of fixture identities (`e2e-admin@…` / `e2e-client@…`), whose
//     sessions `e2e/global-setup.ts` DELETEs and re-INSERTs on every run -- so
//     a sibling's `globalSetup` invalidated the `storageState` this run was
//     holding, mid-run. #145 lost its session that way and captured a login
//     page for one viewport and the real gallery for the other.
//   * one fixture gallery row, whose `status` therefore oscillated between
//     `proofing` and `selected` depending on which sibling ran last (#179).
//
// All three are the same shape of failure: a well-formed artifact that is
// WRONG, whose report looks identical to a correct one. The fix is not a lock
// and not serialisation -- lanes are SUPPOSED to run at once, and a solution
// that serialises them is a rollback wearing a fix's clothes (task #177's own
// stated trap). The fix is to give each worktree its own port and its own
// fixture rows, derived deterministically from the one thing that is already
// unique per lane: the absolute path of its worktree.
//
// DETERMINISTIC, NOT RANDOM, ON PURPOSE: the same worktree must derive the
// same port and the same fixture identities on every run, or a re-run would
// orphan the previous run's rows and never find its own server again.
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Length of the hex tag appended to every per-worktree identifier. 8 hex
 * characters is 32 bits: with the handful of worktrees this board ever has
 * open at once, a collision is not a practical concern, and a short tag keeps
 * the derived e-mail addresses and slugs readable in `psql` output.
 */
export const WORKTREE_TAG_LENGTH = 8;

/**
 * Port window the capture harness allocates from. Chosen against real
 * constraints, not by taste:
 *
 *  * ABOVE the app's own conventional ports (:3300 for `bun run dev`, :3301
 *    which lanes have used by hand), so a derived port never collides with a
 *    dev server someone started manually.
 *  * BELOW Linux's default ephemeral range (32768-60999) and macOS's
 *    (49152-65535), so the kernel never hands one of these out to an
 *    unrelated outbound socket while the harness expects it to be free.
 */
export const CAPTURE_PORT_RANGE_START = 24_000;
export const CAPTURE_PORT_RANGE_SIZE = 4_000;

const FIXTURE_EMAIL_DOMAIN = "photo-showcase.test";

function worktreeDigest(worktreeRoot: string): Buffer {
  // `path.resolve` so a caller passing a relative path, or a path with a
  // trailing slash, derives the same tag as one passing the absolute form --
  // otherwise the same worktree could seed two sets of fixture rows depending
  // on how it was invoked.
  return createHash("sha256").update(path.resolve(worktreeRoot)).digest();
}

/** Short, stable hex tag identifying one worktree by its absolute path. */
export function worktreeTag(worktreeRoot: string): string {
  return worktreeDigest(worktreeRoot).toString("hex").slice(0, WORKTREE_TAG_LENGTH);
}

/**
 * The TCP port this worktree's capture run owns.
 *
 * `portOverride` (wired to `E2E_PORT` in `playwright.config.ts`) exists for
 * the one case derivation cannot serve: a developer who needs a known,
 * typeable port to point a browser at by hand. It is validated rather than
 * trusted -- a typo that produced `NaN` would otherwise become
 * `http://localhost:NaN`, which fails much later and much less clearly.
 */
export function captureHarnessPort(worktreeRoot: string, portOverride?: string): number {
  if (portOverride !== undefined && portOverride !== "") {
    const parsed = Number(portOverride);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
      throw new Error(
        `E2E_PORT must be an integer between 1024 and 65535 -- got ${JSON.stringify(portOverride)}. ` +
          "Unset it to let the harness derive a port unique to this worktree (task #177).",
      );
    }
    return parsed;
  }

  return (
    CAPTURE_PORT_RANGE_START +
    (worktreeDigest(worktreeRoot).readUInt32BE(0) % CAPTURE_PORT_RANGE_SIZE)
  );
}

/**
 * Fixture identities and rows, one set per worktree.
 *
 * These are what make `reseedSession`'s `DELETE FROM sessions WHERE user_id =
 * …` safe again: it still deletes every session for the user it is about to
 * re-seed, but that user now belongs to this worktree alone, so it can no
 * longer invalidate a sibling run's live `storageState`.
 */
export function fixtureAdminEmail(worktreeRoot: string): string {
  return `e2e-admin-${worktreeTag(worktreeRoot)}@${FIXTURE_EMAIL_DOMAIN}`;
}

export function fixtureClientEmail(worktreeRoot: string): string {
  return `e2e-client-${worktreeTag(worktreeRoot)}@${FIXTURE_EMAIL_DOMAIN}`;
}

export function fixtureGalleryPublicSlug(worktreeRoot: string): string {
  return `e2e-visual-capture-gallery-${worktreeTag(worktreeRoot)}`;
}

/**
 * One-line summary a capture run prints on startup.
 *
 * Everything this harness uses is now derived rather than fixed, which is the
 * fix -- but it also means a lane can no longer guess its own port or its own
 * gallery slug, and it needs both (to open the page by hand, to seed extra
 * rows against the right gallery). Printing them is what keeps the derivation
 * from being opaque.
 */
export function formatCaptureHarnessBanner(worktreeRoot: string, portOverride?: string): string {
  const port = captureHarnessPort(worktreeRoot, portOverride);
  return (
    `[e2e] worktree ${worktreeTag(worktreeRoot)} -> http://localhost:${port} | ` +
    `admin ${fixtureAdminEmail(worktreeRoot)} | client ${fixtureClientEmail(worktreeRoot)} | ` +
    `gallery /galleries/${fixtureGalleryPublicSlug(worktreeRoot)}`
  );
}

export function fixtureGalleryTitle(worktreeRoot: string): string {
  // Spanish, like every other user-facing string in this app: this title is
  // rendered by `/dashboard/galleries` and by the client gallery header, so it
  // shows up inside the screenshots this harness takes. The tag is included so
  // a developer looking at a dev database full of fixture rows can tell which
  // worktree seeded which one.
  return `Sesión de prueba (harness de captura ${worktreeTag(worktreeRoot)})`;
}
