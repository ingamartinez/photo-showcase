# Visual-capture harness (task #165)

Local-only Playwright harness that seeds an authenticated admin session and
an authenticated client session directly into the dev database, then gives
any spec a `captureScreen(page, { name, route, viewport })` helper to write a
full-page PNG. Built so the two design epics (#125 admin, #140 client) can
attach a real screenshot to a slice body before closing it — see
`AGENTS.md`'s "What the shipping agent cannot verify" and kanban task #165
for the full "why".

## Running it

```bash
bun run test:e2e
```

That's it — `package.json`'s `test:e2e` script sets `APP_ENV=test` itself, so
you do not need to export anything for the environment guard
(`tooling/refuse-on-production.ts`) to let the harness run.

**Several lanes can run this at the same time.** That was not true before task
#177 and it is the single most important thing to know about this harness; see
"Everything is per worktree" below.

The first line the run prints tells you what it derived for your worktree:

```
[e2e] worktree 9ec8ea4a -> http://localhost:27306 | admin e2e-admin-9ec8ea4a@photo-showcase.test | client e2e-client-9ec8ea4a@photo-showcase.test | gallery /galleries/e2e-visual-capture-gallery-9ec8ea4a
```

Those values are yours alone. Copy the URL from there if you want to open the
page by hand; do not assume `:3300`.

## What you DO need in your shell/`.env.local` first

`bun run test:e2e` boots its own dev server as its `webServer` (see
`playwright.config.ts` and `tooling/e2e-capture-config.ts`), and that server
needs Auth.js to construct without throwing. Four values, **all safely fake for
local use** — nobody has to copy a real `.env.local` into a fresh worktree just
to run this harness:

```bash
AUTH_SECRET="any-string-at-least-32-characters-long"
AUTH_URL="http://localhost:3300"
RESEND_API_KEY="re_fake"
EMAIL_FROM="dev@example.com"
```

`AUTH_URL` only has to be a valid URL here: nothing this harness captures reads
it (it feeds magic-link e-mails and the login flow's cookie `secure` flag —
`src/lib/auth-cookies.ts`), and the seeded session cookie is host-only on
`localhost`, which cookies scope without regard to port. So it does **not** need
to match the port the harness derived for you.

Verified: **no `R2_*` variables are required for the specs committed here.** The
fixture gallery this harness seeds has zero assets (see `e2e/global-setup.ts`'s
note on the fixture gallery), so nothing on `/dashboard` or the fixture gallery
route ever calls `r2Env()`.

The moment your spec seeds an asset, that stops being true — but the values can
still be **fake**. See "Seeding extra rows for a capture" below.

You also need a local Postgres running with the `photoshowcase` dev database
migrated and at least one active `packages` row (`bun run db:seed:packages`
if that's empty) — same prerequisite as any other script under `scripts/`
that touches the dev DB (`scripts/create-admin.ts`, etc).

## Everything is per worktree (task #177)

The agent harness that runs this board opens several git worktrees at once, one
per lane, all against the same machine and the same dev database. Three things
used to be shared between them, and each one produced a **well-formed
screenshot of the wrong thing**:

| shared thing              | what went wrong                                                                                                            | now                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| the port (`:3300`)        | `reuseExistingServer: true` attached to whichever sibling's dev server was already bound, and captured **another branch**  | port derived from the worktree path; reuse turned **off**         |
| the fixture user identity | `reseedSession` DELETEs every session of the user it re-seeds, invalidating a **concurrent** lane's `storageState` mid-run | `e2e-admin-<tag>@…` / `e2e-client-<tag>@…`, one pair per worktree |
| the fixture gallery       | a sibling submitting its selection flipped the gallery to `selected`, so the route rendered the **locked** variant         | `e2e-visual-capture-gallery-<tag>`, one per worktree              |

The tag is the first 8 hex characters of `sha256(<absolute worktree path>)`, so
it is stable across re-runs of the same worktree and different between any two.
See `tooling/e2e-worktree.ts`, which `bun run test` covers directly.

Note what was **not** done: no lock, no queue, no `workers: 1`. Lanes are meant
to run at the same time — #177 names serialisation explicitly as "a rollback
wearing a fix's clothes".

Consequences worth knowing:

- **Playwright starts its own dev server every run** and fails loudly
  (`http://localhost:<port> is already used`) if that port is taken, instead of
  silently capturing a stranger's page. Do not "fix" that by setting
  `reuseExistingServer: true` — that IS the bug. If you genuinely need a fixed
  port (to point a browser at it by hand, say), export `E2E_PORT=31234`.
- **Every worktree leaves two users and one gallery behind** in the dev
  database. They are obviously fake and tagged, but they do pile up, and the
  admin gallery index shows all of them. To sweep the ones whose lane is gone:

  ```sql
  -- Check first; every row here is a fixture row, but check anyway.
  SELECT public_slug, status, title FROM galleries WHERE public_slug LIKE 'e2e-visual-capture-gallery-%';
  SELECT email FROM users WHERE email LIKE 'e2e-admin-%@photo-showcase.test'
      OR email LIKE 'e2e-client-%@photo-showcase.test';
  ```

  Delete only tags that do not belong to a worktree still on disk — a lane
  running right now is authenticated with exactly those rows.

## What it seeds

`e2e/global-setup.ts` runs once per `playwright test` invocation, before any
spec or worker starts:

- An admin user + session (`e2e-admin-<tag>@photo-showcase.test`).
- A client user + session (`e2e-client-<tag>@photo-showcase.test`).
- One fixture gallery (`e2e-visual-capture-gallery-<tag>`, the client attached
  to it) — **with zero assets**, and **forced to `E2E_GALLERY_STATUS`
  (`proofing`) on every run**, whether or not it already existed. That last part
  is task #179: before it, the status was set only on INSERT, so a gallery left
  at `selected` by an earlier run made the route render the locked variant
  forever.

Storage states land in `playwright/.cache/{admin,client}-storage-state.json`
(gitignored). Screenshots land in `e2e/screenshots/` (also gitignored) —
attach the PNG to the kanban slice body by hand; neither directory is ever
committed.

## Writing a new capture spec

```ts
import { test } from "@playwright/test";
import { ADMIN_STORAGE_STATE_PATH, VIEWPORT_NAMES } from "./lib/fixtures";
import { captureScreen } from "./capture";

test.use({ storageState: ADMIN_STORAGE_STATE_PATH });

for (const viewport of VIEWPORT_NAMES) {
  test(`my redesigned screen at ${viewport}`, async ({ page }) => {
    await captureScreen(page, {
      name: "my-screen",
      route: "/dashboard/whatever",
      viewport,
      // Something only the finished screen renders. See "The three guards".
      expectSelector: "[data-something-only-this-screen-has]",
      // Pass your own. See "Do not trust the default waitFor" below.
      waitFor: async (p) => {
        await p.waitForSelector("<a selector only the finished screen has>");
      },
    });
  });
}
```

Use `CLIENT_STORAGE_STATE_PATH` for anything under `/galleries/[publicSlug]`.

### The three guards `captureScreen` runs before it writes

Each one exists because the harness once blessed a wrong capture without it,
and in every case the PNG and the report looked identical to a correct one.

1. **Status** (#169). Refuses on a non-2xx. Catches `forbidden()`/`notFound()`,
   which Next renders **at the requested url** — so no URL assertion in your
   spec can see them.
2. **Destination** (#178). Refuses if the navigation ended at a different
   **pathname** than the one requested. A redirect to `/login` answers a
   perfectly legitimate 200, just somewhere else, so guard 1 says nothing about
   it. Compared on pathname (query params, fragments and trailing slashes are
   ignored); if your route is _meant_ to redirect, declare it with
   `expectPathname`.
3. **`expectSelector`**, when you supply one — and you should. It is the only
   guard that can tell two variants of the **same** 200 route apart: the locked
   `selected` gallery versus the `proofing` one is the live case (#179), and the
   locked screen still looks like a plausible proofing screen.

Guards 1 and 2 live in `tooling/e2e-navigation-arrival.ts` and are unit-tested
under `bun run test`; `e2e/capture.self-check.spec.ts` exercises all three
through a real browser.

> **Removed workaround (was: "assert something only your screen renders, AFTER
> the capture").** #145 had to do that by hand because the harness could not see
> a redirect. Guards 2 and 3 now do it BEFORE anything is written, which is
> strictly better — a refused capture leaves no PNG on disk for someone to
> attach by mistake. Keep writing post-capture assertions if you like, but you
> are no longer the only thing standing between a login wall and a slice report.

### Do not trust the default `waitFor` (added by #145, measured in #169)

`captureScreen`'s default gate is
`[...document.images].every((img) => img.complete)`. Measured, it is worth
very little:

| case                                        | elapsed    |
| ------------------------------------------- | ---------- |
| `<img>` in the initial HTML, default        | 2364 ms    |
| `<img>` in the initial HTML, **no-op**      | 2347 ms    |
| `<img>` injected 400 ms after load, default | **345 ms** |

For an image already in the initial HTML it adds nothing (`page.goto`'s
`waitUntil: "load"` already blocked on it). For one that does not exist yet
when the gate runs, `[...document.images]` is empty, `.every()` is vacuously
`true`, and the capture fires before the image exists. **Pass your own
`waitFor`** — a `page.waitForSelector` on something the finished screen
renders. `/galleries/[publicSlug]` is the live case: hydration re-points every
tile's `src` (`urls[asset.id] ?? asset.proofUrl` in `proof-grid.tsx`), which
resets `complete` on an `<img>` that had already loaded.

One more thing #145 hit on that route, worth copying:

- `loading="lazy"` and `fullPage: true` do not cooperate. Scroll the page
  through its own height inside your `waitFor`, return to the top, and only
  then require every image to be complete — otherwise the rows below the first
  screen land in the PNG as empty boxes.

### Seeding extra rows for a capture

The fixture gallery has **zero assets** on purpose, so a slice that needs a
populated screen seeds its own rows and deletes them again. Seed against **your
own** gallery — `E2E_GALLERY_PUBLIC_SLUG` from `e2e/lib/fixtures.ts`, never a
hardcoded slug. What worked for #145, without needing real Cloudflare
credentials or real photographs:

- **Fake `R2_*` values are enough**, but they ARE required the moment an asset
  exists: `getPresignedUrl` is a local HMAC (no network), yet it calls
  `r2Env()`, and an unset variable turns the page into a 500. Pass
  `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`
  inline alongside the four auth values above.
- **Serve the image bytes from the spec.** `page.route(/r2\.cloudflarestorage\.com/, …)`
  fulfilling with buffers you produced through the repo's own `processProof`
  gives a capture with real, correctly-sized, really-watermarked thumbnails and
  no R2 round trip.

> **Removed workaround (was: "run the dev server under Bun yourself, with
> `bun --bun run dev`, then let `reuseExistingServer` pick it up").** The config
> now starts `bun --bun run dev --port <derived>` itself, so `Bun.S3Client`
> exists and presigned URLs no longer throw `ReferenceError: Bun is not
defined`. Do not pre-start a server: reuse is off, and a server already on
> your port now makes the run fail rather than silently attach.

> **Removed workaround (was: "reset the gallery's `status` yourself").**
> `global-setup.ts` now forces the requested status on every run, existing row
> or not (#179). If your slice needs a variant other than `proofing`, change
> `E2E_GALLERY_STATUS` in `e2e/lib/fixtures.ts` rather than hand-editing a row
> — a hand edit will be corrected back on the next run, which is the point.

## Never in CI

This suite is not wired into `.github/workflows/ci.yml` and should not be:
it depends on a real local Postgres and a real local dev server, and its
whole reason to exist is verifying something _behind a login_ that
`photo-shipper` is explicitly forbidden from obtaining a session for against
production (see `AGENTS.md`). It only ever runs on a developer's or an
agent's own machine, on purpose.

The pure logic underneath it — the port/identity derivation, the navigation
guard, the fixture-gallery seeding decisions — lives in `tooling/` precisely so
that `bun run test` (which DOES run in CI) covers it. `vitest.config.ts`
excludes `e2e/**` deliberately; a test placed there would silently never run.
