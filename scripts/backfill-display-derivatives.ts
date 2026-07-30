// Backfills the browsing-sized, unwatermarked display derivative (task #89)
// for finals that were uploaded BEFORE that task shipped.
//
//   bun run backfill:display          # do the work
//   bun run backfill:display -- --dry # report what it would do, write nothing
//
// WHY A SCRIPT AND NOT GENERATE-ON-FIRST-REQUEST — the decision task #89 asks
// to be made explicitly, recorded here where the code that implements it
// lives:
//
//   - Generate-on-first-request needs a way to know whether the object is
//     already there. Without a column (and task #89 rules a migration out,
//     correctly — `displayKey` is deterministic, so a column would store what
//     the app can already compute), that means an R2 HEAD per asset per page
//     load: twenty round trips on every open of a twenty-photo gallery,
//     forever, to answer a question that is permanently "yes" a few seconds
//     after this script runs once. `getPresignedUrl` is a local HMAC
//     precisely so the render path touches nothing over the network; probing
//     R2 there would undo that.
//   - It also puts a sharp decode/encode on a CLIENT GET path, inside the
//     same 768 MB service cap the photographer's own uploads compete for,
//     triggered at whatever moment a client happens to open their gallery.
//     And it requires the Next process to pull a full-resolution final's
//     bytes out of R2 through itself — the "the droplet never streams image
//     bytes" invariant (PLAN.md §5) that task #29 already had to carve one
//     documented exception out of. Two exceptions is a pattern, not an
//     exception.
//   - The affected population is tiny and KNOWN: production had exactly one
//     delivered gallery when this shipped. A one-shot, idempotent, resumable
//     script is proportional to that; a permanent runtime mechanism is not.
//
// The runtime does still degrade gracefully if this is never run — the
// display route HEADs the object and 404s, and <ProofGrid> falls back to the
// watermarked proof (see both of their comments). That is a safety net, not
// the plan. Run this at deploy time.
//
// Safe to re-run: it skips any asset whose display object already exists, and
// every key it writes is deterministic (`displayKey`), so even a forced
// rewrite is an overwrite in place rather than a new orphan. Sequential by
// design — `processDisplay` shares the process-wide mutex in
// src/lib/images.ts anyway, so parallelism here would buy nothing but a
// deeper R2 read queue.
//
// Relative imports, same as every other script in this directory: they run
// under plain `bun run`, without tsconfig path mapping.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import { assets } from "../src/lib/db/schema";
import { processDisplay } from "../src/lib/images";
import { displayKey, getObjectStream, objectExists, putObject } from "../src/lib/r2";

type BackfillCounts = {
  scanned: number;
  alreadyPresent: number;
  written: number;
  failed: number;
};

/** Reads a whole R2 object into memory. Deliberately NOT added to
 * src/lib/r2.ts: that module's read surface is presign (for clients) and
 * stream (for the zip writer), and buffering a full-resolution final is
 * exactly the thing no request path in this app is allowed to do. A one-shot
 * maintenance script running alone on the box is a different situation —
 * and keeping the helper here rather than in the shared module means no
 * route can ever reach for it by accident. */
async function readObject(key: string): Promise<Buffer> {
  const response = new Response(getObjectStream(key));
  return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry");

  // The same three facts that imply a deliverable everywhere else in this app
  // (see src/lib/final-access.ts): selected, edited, and a final key on the
  // row. Gallery status is deliberately NOT part of this filter — a gallery
  // that is `selected` today will be `delivered` tomorrow, and generating the
  // derivative early costs one WebP in a private bucket while generating it
  // late means the client's first look at their delivered gallery is the one
  // that goes through the fallback path.
  const rows = await db
    .select({
      id: assets.id,
      galleryId: assets.galleryId,
      finalKey: assets.finalKey,
      originalFilename: assets.originalFilename,
    })
    .from(assets)
    .where(and(isNotNull(assets.finalKey), eq(assets.isSelected, true), eq(assets.isEdited, true)));

  const counts: BackfillCounts = { scanned: rows.length, alreadyPresent: 0, written: 0, failed: 0 };
  console.log(`${rows.length} asset(s) with a final to check${dryRun ? " (dry run)" : ""}.\n`);

  for (const row of rows) {
    const target = displayKey(row.galleryId, row.id);
    const label = `${row.originalFilename} (${row.id})`;

    try {
      if (await objectExists(target)) {
        counts.alreadyPresent++;
        console.log(`skip   ${label} — display already present`);
        continue;
      }

      if (dryRun) {
        counts.written++;
        console.log(`would  ${label} -> ${target}`);
        continue;
      }

      // `row.finalKey` is non-null by the query's own filter; drizzle's
      // inferred type doesn't know that, so it is asserted rather than
      // re-checked with a branch that could never be taken.
      const finalBytes = await readObject(row.finalKey!);
      const display = await processDisplay(finalBytes);
      await putObject(target, display.data, { contentType: "image/webp" });

      counts.written++;
      const kib = (display.data.length / 1024).toFixed(0);
      console.log(`write  ${label} -> ${display.width}x${display.height}, ${kib} KiB`);
    } catch (error: unknown) {
      // One bad asset must not abandon the rest — a missing or corrupt final
      // in R2 is exactly the kind of thing a backfill exists to surface, and
      // the run is resumable, so reporting and continuing is strictly better
      // than stopping at the first problem.
      counts.failed++;
      console.error(`FAIL   ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `\nscanned ${counts.scanned}, already present ${counts.alreadyPresent}, ` +
      `${dryRun ? "would write" : "written"} ${counts.written}, failed ${counts.failed}`,
  );

  if (counts.failed > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The postgres pool keeps the process alive otherwise — same teardown as
    // scripts/seed-prod.ts.
    await db.$client.end();
  });
