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

Verified: **no `R2_*` variables are required.** The fixture gallery this
harness seeds has zero assets (see `e2e/global-setup.ts`'s note on
`ensureFixtureGallery`), so nothing on `/dashboard` or
`/galleries/e2e-visual-capture-gallery` ever calls `r2Env()`. A slice that
extends the fixture with real assets and wants a real presigned `<img>` to
render will need real R2 credentials too, at that point — this harness's
own two specs do not.

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
import { test } from "@playwright/test";
import { ADMIN_STORAGE_STATE_PATH, VIEWPORT_NAMES } from "./lib/fixtures";
import { captureScreen } from "./capture";

test.use({ storageState: ADMIN_STORAGE_STATE_PATH });

for (const viewport of VIEWPORT_NAMES) {
  test(`my redesigned screen at ${viewport}`, async ({ page }) => {
    await captureScreen(page, { name: "my-screen", route: "/dashboard/whatever", viewport });
  });
}
```

Use `CLIENT_STORAGE_STATE_PATH` for anything under `/galleries/[publicSlug]`.
`captureScreen` throws instead of writing a PNG if the navigation did not
return a 2xx response — see `e2e/capture.ts`'s own doc comment and
`e2e/capture.self-check.spec.ts` for why that check exists and what it
catches.

## Never in CI

This suite is not wired into `.github/workflows/ci.yml` and should not be:
it depends on a real local Postgres and a real local dev server, and its
whole reason to exist is verifying something _behind a login_ that
`photo-shipper` is explicitly forbidden from obtaining a session for against
production (see `AGENTS.md`). It only ever runs on a developer's or an
agent's own machine, on purpose.
