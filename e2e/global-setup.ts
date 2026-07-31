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
  E2E_GALLERY_TITLE,
} from "./lib/fixtures";
import { refuseUnlessDevEnvironment } from "./lib/refuse-on-production";

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

async function ensureFixtureGallery(
  db: ReturnType<typeof drizzle<typeof schema>>,
  clientUserId: string,
): Promise<void> {
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

  const [existingGallery] = await db
    .select({ id: schema.galleries.id })
    .from(schema.galleries)
    .where(eq(schema.galleries.publicSlug, E2E_GALLERY_PUBLIC_SLUG))
    .limit(1);

  const galleryId =
    existingGallery?.id ??
    (
      await db
        .insert(schema.galleries)
        .values({
          packageId: pkg.id,
          title: E2E_GALLERY_TITLE,
          sessionDate: new Date().toISOString().slice(0, 10),
          status: "proofing",
          publicSlug: E2E_GALLERY_PUBLIC_SLUG,
          includedPhotosSnapshot: pkg.includedPhotos,
          extraPhotoPriceCopSnapshot: pkg.extraPhotoPriceCop,
        })
        .returning({ id: schema.galleries.id })
    )[0].id;

  const [existingMembership] = await db
    .select({
      galleryId: schema.galleryClients.galleryId,
      removedAt: schema.galleryClients.removedAt,
    })
    .from(schema.galleryClients)
    .where(
      and(
        eq(schema.galleryClients.galleryId, galleryId),
        eq(schema.galleryClients.userId, clientUserId),
      ),
    )
    .limit(1);

  if (!existingMembership) {
    await db.insert(schema.galleryClients).values({ galleryId, userId: clientUserId });
  } else if (existingMembership.removedAt !== null) {
    // Reactivate a membership a previous run (or a stray manual edit) removed
    // -- see schema.ts's own comment on `removedAt`: re-attaching UPDATEs the
    // same composite-PK row back to NULL rather than inserting a second one.
    await db
      .update(schema.galleryClients)
      .set({ removedAt: null })
      .where(
        and(
          eq(schema.galleryClients.galleryId, galleryId),
          eq(schema.galleryClients.userId, clientUserId),
        ),
      );
  }
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

    await ensureFixtureGallery(db, clientId);

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
  } finally {
    // Without this, the pooled connection above keeps `playwright test`'s
    // process alive on an open socket after every spec has finished --
    // globalSetup runs in-process with the runner, unlike a one-shot script
    // that can just call `process.exit()` (see this file's header comment).
    await sql.end({ timeout: 5 });
  }
}
