// The guard `e2e/capture.ts` runs before it is allowed to write a PNG.
//
// HISTORY, BECAUSE IT EXPLAINS THE SHAPE. Task #165's harness wrote whatever
// the browser happened to be showing. #169 found it had blessed 17 screenshots
// of 403 pages and added a status check -- `response.ok()` -- which is
// necessary because Next renders `forbidden()`/`notFound()` AT THE REQUESTED
// URL, so no URL assertion in a calling spec can see them.
//
// #178 is the mirror image, and the status check is blind to it: a REDIRECT
// returns 200, just somewhere else. #145 lost its fixture session mid-run
// (a sibling worktree's `globalSetup` deleted it -- see task #177) and got a
// clean 200 on `/login`. One viewport captured the gallery, the next captured
// the login wall, and the harness said nothing. What saved that lane was a
// copy assertion its own agent thought to write AFTER capturing; the next
// agent may not think of it.
//
// So there are two independent questions, and this module asks both:
//   1. did the server answer successfully?      -> status
//   2. did we end up WHERE WE ASKED TO GO?      -> pathname
//
// THE TRAP, NAMED IN #178 ITSELF: do not answer (2) by comparing `page.url()`
// to the requested string. Legitimate routes carry query params, fragments and
// trailing slashes, and `baseURL` makes the requested route relative while
// `page.url()` is absolute. The comparison has to be on the PATHNAME, and the
// expectation has to be statable explicitly for the routes that legitimately
// redirect.

/** Any origin works: only the pathname survives normalization. */
const RELATIVE_URL_BASE = "http://e2e.invalid";

/**
 * Reduces a route or a full URL to the one thing worth comparing: its
 * pathname, without a trailing slash. `/dashboard`, `/dashboard/`,
 * `/dashboard?tab=all`, `/dashboard#top` and
 * `http://localhost:24123/dashboard/` all reduce to `/dashboard`.
 */
export function normalizeRoutePathname(routeOrUrl: string): string {
  const { pathname } = new URL(routeOrUrl, RELATIVE_URL_BASE);
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export interface NavigationOutcome {
  /** The route the caller asked `captureScreen` for, relative to `baseURL`. */
  route: string;
  /** `page.url()` AFTER navigation settled -- the destination, redirects included. */
  finalUrl: string;
  /** `response.status()`, or `null` when `page.goto` produced no response at all. */
  status: number | null;
  /** `response.statusText()`, purely to make the thrown message readable. */
  statusText?: string;
  /**
   * Only for a route that legitimately lands somewhere other than where it was
   * asked for (a redirect the caller MEANT). Stating it is the point: an
   * expectation written down is checked, an expectation left implicit is not.
   */
  expectPathname?: string;
}

/**
 * Throws unless the navigation both succeeded AND ended at the expected
 * pathname. Returns nothing; the only contract is "did not throw".
 */
export function assertNavigationArrived(outcome: NavigationOutcome): void {
  const { route, finalUrl, status, statusText, expectPathname } = outcome;

  if (status === null) {
    throw new Error(
      `Refusing to capture ${route}: navigation returned no response. ` +
        "A screenshot of whatever the browser happened to be showing is not evidence of anything.",
    );
  }

  if (status < 200 || status > 299) {
    throw new Error(
      `Refusing to capture ${route}: navigation returned ` +
        `${status}${statusText ? ` ${statusText}` : ""}. ` +
        "A non-2xx response (e.g. a 403 from forbidden() for an unauthorized session, or a " +
        "404 from notFound()) renders at the SAME url the caller expected, so this check -- " +
        "not a URL assertion in the calling spec -- is what catches it before a screenshot of " +
        "an error page gets written and reported as a pass.",
    );
  }

  const expected = normalizeRoutePathname(expectPathname ?? route);
  const actual = normalizeRoutePathname(finalUrl);
  if (actual !== expected) {
    throw new Error(
      `Refusing to capture ${route}: navigation ended at "${actual}", not "${expected}" ` +
        `(final url ${finalUrl}). A redirect answers 200 at a DIFFERENT url, so the status ` +
        "check above cannot see it -- an expired or sibling-deleted session lands on /login " +
        "and screenshots the login wall instead of the screen the caller asked for (task " +
        "#178). If this route is MEANT to redirect, say so with `expectPathname`.",
    );
  }
}
