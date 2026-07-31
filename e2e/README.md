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

## What you DO need in your shell/`.env.local` first

`bun run test:e2e` boots a real `bun run dev` on `:3300` as its
`webServer` (see `playwright.config.ts`), and that dev server needs Auth.js
to construct without throwing. Four values, **all safely fake for local
use** — nobody has to copy a real `.env.local` into a fresh worktree just to
run this harness:

```bash
AUTH_SECRET="any-string-at-least-32-characters-long"
AUTH_URL="http://localhost:3300"
RESEND_API_KEY="re_fake"
EMAIL_FROM="dev@example.com"
```

Verified: **no `R2_*` variables are required for the two committed specs.** The
fixture gallery this harness seeds has zero assets (see `e2e/global-setup.ts`'s
note on `ensureFixtureGallery`), so nothing on `/dashboard` or
`/galleries/e2e-visual-capture-gallery` ever calls `r2Env()`.

The moment your spec seeds an asset, that stops being true — but the values can
still be **fake**, and the dev server has to run under Bun. See "Seeding extra
rows for a capture" below; #145 established both, and neither is guessable from
here.

You also need a local Postgres running with the `photoshowcase` dev database
migrated and at least one active `packages` row (`bun run db:seed:packages`
if that's empty) — same prerequisite as any other script under `scripts/`
that touches the dev DB (`scripts/create-admin.ts`, etc).

## What it seeds

`e2e/global-setup.ts` runs once per `playwright test` invocation, before any
spec or worker starts:

- An admin user + session (`e2e-admin@photo-showcase.test`).
- A client user + session (`e2e-client@photo-showcase.test`).
- One fixture gallery (`e2e-visual-capture-gallery`, status `proofing`, the
  client attached to it) — **with zero assets**. See `e2e/lib/fixtures.ts`
  and `e2e/global-setup.ts` for why, and which downstream slices need to
  extend it.

Storage states land in `playwright/.cache/{admin,client}-storage-state.json`
(gitignored). Screenshots land in `e2e/screenshots/` (also gitignored) —
attach the PNG to the kanban slice body by hand; neither directory is ever
committed.

## Writing a new capture spec

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STORAGE_STATE_PATH, VIEWPORT_NAMES } from "./lib/fixtures";
import { captureScreen } from "./capture";

test.use({ storageState: ADMIN_STORAGE_STATE_PATH });

for (const viewport of VIEWPORT_NAMES) {
  test(`my redesigned screen at ${viewport}`, async ({ page }) => {
    await captureScreen(page, {
      name: "my-screen",
      route: "/dashboard/whatever",
      viewport,
      // Pass your own. See "Do not trust the default waitFor" below.
      waitFor: async (p) => {
        await p.waitForSelector("<a selector only the finished screen has>");
      },
    });

    // Prove the PNG is the screen you think it is, not a login wall.
    await expect(page.getByText(/some copy only this screen renders/)).toBeVisible();
  });
}
```

Use `CLIENT_STORAGE_STATE_PATH` for anything under `/galleries/[publicSlug]`.
`captureScreen` throws instead of writing a PNG if the navigation did not
return a 2xx response — see `e2e/capture.ts`'s own doc comment and
`e2e/capture.self-check.spec.ts` for why that check exists and what it
catches.

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

Two more things #145 hit on that route, both worth copying:

- `loading="lazy"` and `fullPage: true` do not cooperate. Scroll the page
  through its own height inside your `waitFor`, return to the top, and only
  then require every image to be complete — otherwise the rows below the first
  screen land in the PNG as empty boxes.
- **Assert something only your screen renders, after the capture.** The
  non-2xx guard cannot see a redirect to `/login`, because that renders 200 at
  a different url. This is not theoretical: with several lanes working in
  parallel, another lane's `globalSetup` deletes and re-seeds the fixture
  users' sessions (`reseedSession`), which invalidates the `storageState` this
  run is holding, mid-run. #145 caught exactly that — one viewport captured
  the gallery, the next captured the login page.

### Seeding extra rows for a capture

The fixture gallery has **zero assets** on purpose (see below), so a slice that
needs a populated screen seeds its own rows and deletes them again. What worked
for #145, without needing real Cloudflare credentials or real photographs:

- **Fake `R2_*` values are enough**, but they ARE required the moment an asset
  exists: `getPresignedUrl` is a local HMAC (no network), yet it calls
  `r2Env()`, and an unset variable turns the page into a 500. Pass
  `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`
  inline alongside the four auth values above.
- **Run the dev server under Bun**: `bun --bun run dev`. Plain `bun run dev`
  hands `next dev` to Node, where `Bun.S3Client` does not exist, so every
  presigned URL throws `ReferenceError: Bun is not defined` and any page with
  an asset 500s. Production does not have this problem (`infra/systemd/
photoshowcase.service` starts `bun server.js`). `playwright.config.ts` sets
  `reuseExistingServer: true`, so starting `bun --bun run dev` yourself before
  `playwright test` is all it takes.
- **Serve the image bytes from the spec.** `page.route(/r2\.cloudflarestorage\.com/, …)`
  fulfilling with buffers you produced through the repo's own `processProof`
  gives a capture with real, correctly-sized, really-watermarked thumbnails and
  no R2 round trip.
- **Reset the gallery's `status` yourself.** `ensureFixtureGallery` only sets
  `status` when it INSERTS the gallery; it never corrects an existing one. Once
  any run submits the fixture selection the gallery stays `selected` forever,
  and `/galleries/[publicSlug]` quietly renders the locked variant — which
  still looks like a plausible proofing screen if you are not looking for it.

## Never in CI

This suite is not wired into `.github/workflows/ci.yml` and should not be:
it depends on a real local Postgres and a real local dev server, and its
whole reason to exist is verifying something _behind a login_ that
`photo-shipper` is explicitly forbidden from obtaining a session for against
production (see `AGENTS.md`). It only ever runs on a developer's or an
agent's own machine, on purpose.
