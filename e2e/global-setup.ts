// Playwright `globalSetup` (task #165) — runs once before any spec, seeds an
// admin and a client session DIRECTLY into the dev database with Drizzle,
// and writes two `storageState` files a spec can hand to `test.use(...)`.
//
// WHY DIRECT DB SEEDING, NOT THE REAL MAGIC-LINK FLOW: the link goes out
// through Resend (src/lib/login-email.ts, src/lib/gallery-access-email.ts)
// and a lane cannot read an inbox. `scripts/create-admin.ts` is this repo's
// existing precedent for a script touching the DB directly with Drizzle;
// this follows the same shape. There is deliberately NO `/api/test/login`
// route anywhere in `src/` — that is precisely the standing bypass task #82
// rejected. The seeding lives only here, in the test harness.
//
// WHY A DEDICATED, SHORT-LIVED CONNECTION INSTEAD OF IMPORTING `src/lib/db`:
// that module's pooled client (`max: 10`, no `.end()` exported) is designed
// for a long-running Next.js server process, not a one-shot script — see
// `scripts/create-admin.ts`, which relies on its own explicit
// `process.exit(0)` to terminate a process that would otherwise hang on open
// sockets. Calling `process.exit()` from inside `globalSetup` would kill the
// whole `playwright test` run before a single spec started, so that escape
// hatch is not available here. A private connection this file opens and
// explicitly closes (`sql.end()` below) avoids ever needing it, without
// touching `src/lib/db/index.ts` at all — this harness is a consumer of the
// schema, never of the app's own pool.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";
import {
  ADMIN_STORAGE_STATE_PATH,
  AUTH_SESSION_COOKIE_NAME,
  CLIENT_STORAGE_STATE_PATH,
  E2E_ADMIN_EMAIL,
  E2E_CLIENT_EMAIL,
  E2E_GALLERY_PUBLIC_SLUG,
  E2E_GALLERY_STATUS,
  E2E_GALLERY_TITLE,
} from "./lib/fixtures";
import { type FixtureGalleryStore, ensureFixtureGallery } from "../tooling/e2e-fixture-gallery";
import { formatCaptureHarnessBanner } from "../tooling/e2e-worktree";
import { refuseUnlessDevEnvironment } from "../tooling/refuse-on-production";

// A day is generous headroom for a local capture run and short enough that a
// stray leftover row from a crashed run is never mistaken for a long-lived
// credential.
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

async function upsertUser(
  db: ReturnType<typeof drizzle<typeof schema>>,
  email: string,
  role: "admin" | "client",
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      role,
      name: role === "admin" ? "Admin E2E" : "Cliente E2E",
      emailVerified: new Date(),
    })
    .returning({ id: schema.users.id });
  return created.id;
}

// Fresh token every run: any session left over from a previous (or crashed)
// run for this same fixture user is deleted first, so `sessions` never
// accumulates orphaned rows for these two fixture identities.
//
// THE DELETE USED TO BE THE #177 RACE, and it is safe again only because of
// what changed one file over. The fixture identities were fixed strings shared
// by every worktree, so this statement wiped the session a CONCURRENT lane was
// authenticated with, mid-run -- #145 lost its session exactly here and
// captured a login page for one viewport. `e2e/lib/fixtures.ts` now derives
// the addresses per worktree, so `userId` below belongs to this run alone.
// Note what was NOT done: no lock, no queue, no `workers: 1`. Lanes are meant
// to run at once (#177's own stated trap).
async function reseedSession(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
): Promise<{ sessionToken: string; expires: Date }> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));

  const sessionToken = randomUUID();
  const expires = new Date(Date.now() + SESSION_LIFETIME_MS);
  await db.insert(schema.sessions).values({ sessionToken, userId, expires });
  return { sessionToken, expires };
}

// NOTE FOR WHOEVER RUNS THIS NEXT AND SEES AN EMPTY GRID: this fixture
// gallery is seeded with ZERO assets, deliberately -- task #165's own scope
// is the seeding/capture MECHANISM, not a realistic proof grid. A capture of
// `/galleries/<the per-worktree slug>` shows "Tu fotógrafo todavía no subió
// fotos para esta galería" and nothing else. Slices #145/#146 (proof grid
// redesign) need real thumbnails to capture something meaningful and MUST seed
// their own `assets` rows before screenshotting that page -- nothing here does
// it for them.
//
// THE DECISIONS LIVE IN `tooling/e2e-fixture-gallery.ts`, NOT HERE (task
// #179). This adapter is only SQL. The bug it exists to keep fixed was a
// missing write -- `status` was set on INSERT and never corrected on an
// existing row, so once any run submitted the fixture selection the gallery
// stayed `selected` and the route rendered the LOCKED variant, which still
// looks like a plausible proofing screen. `vitest.config.ts` never looks
// inside `e2e/**` and `bun run test` has no database, so a missing write is
// only provable in `tooling/`.
async function makeFixtureGalleryStore(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<FixtureGalleryStore> {
  const [pkg] = await db
    .select()
    .from(schema.packages)
    .where(eq(schema.packages.active, true))
    .orderBy(schema.packages.sortOrder)
    .limit(1);

  if (!pkg) {
    throw new Error(
      "No active package found in the dev database. Run `bun run db:seed:packages` " +
        "first -- the visual-capture harness needs at least one active package to " +
        "snapshot onto its fixture gallery.",
    );
  }

  return {
    findGalleryByPublicSlug: async (publicSlug) => {
      const [row] = await db
        .select({ id: schema.galleries.id, status: schema.galleries.status })
        .from(schema.galleries)
        .where(eq(schema.galleries.publicSlug, publicSlug))
        .limit(1);
      return row;
    },
    insertGallery: async ({ publicSlug, title, status }) => {
      const [row] = await db
        .insert(schema.galleries)
        .values({
          packageId: pkg.id,
          title,
          sessionDate: new Date().toISOString().slice(0, 10),
          status,
          publicSlug,
          // The frozen commercial terms (PLAN.md §3): copied from the package
          // AT CREATION and never recomputed afterwards, exactly as a real
          // gallery does it.
          includedPhotosSnapshot: pkg.includedPhotos,
          extraPhotoPriceCopSnapshot: pkg.extraPhotoPriceCop,
        })
        .returning({ id: schema.galleries.id });
      return row.id;
    },
    updateGalleryStatus: async (galleryId, status) => {
      await db.update(schema.galleries).set({ status }).where(eq(schema.galleries.id, galleryId));
    },
    findMembership: async (galleryId, userId) => {
      const [row] = await db
        .select({ removedAt: schema.galleryClients.removedAt })
        .from(schema.galleryClients)
        .where(
          and(
            eq(schema.galleryClients.galleryId, galleryId),
            eq(schema.galleryClients.userId, userId),
          ),
        )
        .limit(1);
      return row;
    },
    insertMembership: async (galleryId, userId) => {
      await db.insert(schema.galleryClients).values({ galleryId, userId });
    },
    reactivateMembership: async (galleryId, userId) => {
      await db
        .update(schema.galleryClients)
        .set({ removedAt: null })
        .where(
          and(
            eq(schema.galleryClients.galleryId, galleryId),
            eq(schema.galleryClients.userId, userId),
          ),
        );
    },
  };
}

function buildStorageState(sessionToken: string, expires: Date): string {
  return JSON.stringify(
    {
      cookies: [
        {
          name: AUTH_SESSION_COOKIE_NAME,
          value: sessionToken,
          // Host-only cookie for `localhost` — matches `playwright.config.ts`'s
          // `baseURL` (`http://localhost:3300`) and the plain, non-`__Secure-`
          // cookie name `fixtures.ts` documents for a plain-http `bun run dev`.
          domain: "localhost",
          path: "/",
          expires: Math.floor(expires.getTime() / 1000),
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    null,
    2,
  );
}

export default async function globalSetup(): Promise<void> {
  refuseUnlessDevEnvironment();

  // COUPLED TO `src/lib/db/index.ts` BY COPY, NOT BY IMPORT -- flagged
  // explicitly in the #165 review as a real, if currently harmless, risk:
  // these five lines (socket default, PGHOST/PGDATABASE/PGUSER/PGPORT/
  // PGPASSWORD precedence) are hand-duplicated from that file rather than
  // imported, for the reason in this file's header comment (no closable
  // pooled client to reuse). Today the two are IDENTICAL, so this harness
  // seeds the same database the running app reads from. If `src/lib/db/
  // index.ts` ever grows a second connection path (e.g. a `DATABASE_URL`
  // branch), this copy will NOT follow it silently -- this file would keep
  // seeding the socket-based dev database while the app reads from
  // somewhere else, and every capture would render a login wall with no
  // clue why. Whoever changes `src/lib/db/index.ts`'s connection logic
  // should grep for this comment and update this block to match.
  const defaultSocket = process.platform === "darwin" ? "/tmp" : "/var/run/postgresql";
  const sql = postgres({
    host: process.env.PGHOST ?? defaultSocket,
    database: process.env.PGDATABASE ?? "photoshowcase",
    username: process.env.PGUSER ?? process.env.USER,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    password: process.env.PGPASSWORD,
    max: 1,
    prepare: false,
  });
  const db = drizzle(sql, { schema });

  try {
    const adminId = await upsertUser(db, E2E_ADMIN_EMAIL, "admin");
    const clientId = await upsertUser(db, E2E_CLIENT_EMAIL, "client");

    await ensureFixtureGallery(await makeFixtureGalleryStore(db), {
      publicSlug: E2E_GALLERY_PUBLIC_SLUG,
      title: E2E_GALLERY_TITLE,
      status: E2E_GALLERY_STATUS,
      clientUserId: clientId,
    });

    const adminSession = await reseedSession(db, adminId);
    const clientSession = await reseedSession(db, clientId);

    await mkdir(path.dirname(ADMIN_STORAGE_STATE_PATH), { recursive: true });
    await writeFile(
      ADMIN_STORAGE_STATE_PATH,
      buildStorageState(adminSession.sessionToken, adminSession.expires),
    );
    await writeFile(
      CLIENT_STORAGE_STATE_PATH,
      buildStorageState(clientSession.sessionToken, clientSession.expires),
    );

    // `process.stdout.write`, not `console.log`: eslint's `no-console` is an
    // error everywhere except `scripts/**` and `tooling/**`, and this file is
    // neither. The banner itself is built in `tooling/e2e-worktree.ts` (pure,
    // and covered by `bun run test`); only the write happens here. It earns
    // its place because everything this harness uses is now DERIVED -- a lane
    // that wants to open its own gallery by hand, or seed extra rows against
    // it, cannot guess the port or the slug any more.
    process.stdout.write(`${formatCaptureHarnessBanner(process.cwd(), process.env.E2E_PORT)}\n`);
  } finally {
    // Without this, the pooled connection above keeps `playwright test`'s
    // process alive on an open socket after every spec has finished --
    // globalSetup runs in-process with the runner, unlike a one-shot script
    // that can just call `process.exit()` (see this file's header comment).
    await sql.end({ timeout: 5 });
  }
}
