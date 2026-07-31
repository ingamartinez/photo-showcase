// R2 connectivity check — run after creating the bucket and its API token:
//   bun run check:r2
//
// Proves the exact operations the gallery pipeline depends on, in order:
// write -> read -> presign + fetch -> presign expiry -> delete. If this
// passes, the credentials and bucket scope are correct. If it fails, it
// fails here instead of halfway through an upload with a client's photos in
// flight.
//
// The presign-expiry step exists for task #16 (the ownership-checked read
// route): "the presigned URL expires; an expired URL is verified to fail"
// is a property of R2's own signature verification, not of any code in this
// app — a Vitest unit test can only assert that `getPresignedUrl()` calls
// `presign()` with the right TTL (see src/lib/r2.test.ts), never that R2
// actually honors it. This script is the one place in the repo that talks
// to the real bucket, so it is also the one place that can prove expiry for
// real, against a short-lived URL and a real clock.
//
// Uses Bun's native S3 client (no AWS SDK dependency). Relative imports so it
// resolves without tsconfig path mapping, same as the other scripts.

import { S3Client } from "bun";
import { r2Env } from "../src/lib/env";
import { nonGalleryKey } from "../src/lib/r2";

// Task #78: `nonGalleryKey` is the named escape hatch for exactly this case
// — a legitimate R2 key that isn't shaped like `galleries/{galleryId}/…`.
// Still funnels through the same dev/prod namespacing as every real key
// (see its own comment in src/lib/r2.ts), it just isn't produced by this
// script's own throwaway `S3Client` below, which is deliberately built
// independent of src/lib/r2.ts's cached client singleton (see this file's
// own purpose above: proving the raw credentials/bucket work, not r2.ts's
// caching).
const TEST_KEY = nonGalleryKey(`_healthcheck/${Date.now()}.txt`);
const TEST_BODY = "photo-showcase r2 healthcheck";

async function main(): Promise<void> {
  const env = r2Env();

  const client = new S3Client({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT,
  });

  console.log(`bucket:   ${env.R2_BUCKET}`);
  console.log(`endpoint: ${env.R2_ENDPOINT}\n`);

  const file = client.file(TEST_KEY);

  // Task #103: `objectExists` (src/lib/r2.ts, Bun's `S3Client.exists()`) had
  // only ever run against a MOCKED S3Client — this is the one place in the
  // repo that talks to the real bucket, so it is also the one place that can
  // prove its two possible answers for real. Checked BEFORE the write below:
  // an absent key must read as `false`, not throw and not some other
  // truthy-but-wrong value — the residual risk this task exists to close
  // (see this task's own body: #89's try/catch already neutralises a throw,
  // what remained unproven was the wrong-truthy case).
  const missingBeforeWrite = await file.exists();
  if (missingBeforeWrite !== false) {
    throw new Error(`exists() on an absent key returned ${missingBeforeWrite}, expected false`);
  }
  console.log("exists   ok  (absent key -> false)");

  await file.write(TEST_BODY);
  console.log(`write    ok  ${TEST_KEY}`);

  const roundTripped = await file.text();
  if (roundTripped !== TEST_BODY) {
    throw new Error(`read mismatch: expected "${TEST_BODY}", got "${roundTripped}"`);
  }
  console.log("read     ok");

  // Same check, now that the object is actually there — proves `exists()`
  // isn't just always returning `false`.
  const presentAfterWrite = await file.exists();
  if (presentAfterWrite !== true) {
    throw new Error(`exists() on a present key returned ${presentAfterWrite}, expected true`);
  }
  console.log("exists   ok  (present key -> true)");

  // `getObjectSize` (src/lib/r2.ts, Bun's `S3Client.size()`) has the exact
  // same "only ever run against mocks" gap (task #103's own acceptance
  // criterion suggests covering it in the same pass) — same HEAD-only
  // mechanism, same real-bucket blind spot, cheap to close here.
  const size = await client.size(TEST_KEY);
  if (size !== TEST_BODY.length) {
    throw new Error(`size() returned ${size}, expected ${TEST_BODY.length}`);
  }
  console.log(`size     ok  (${size} bytes)`);

  // The app never streams image bytes: clients fetch R2 directly with a
  // short-lived presigned URL. If presigning works, that whole path works.
  const url = file.presign({ expiresIn: 60 });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`presigned GET failed: ${response.status} ${response.statusText}`);
  }
  if ((await response.text()) !== TEST_BODY) {
    throw new Error("presigned GET returned unexpected content");
  }
  console.log("presign  ok  (60s URL fetched successfully)");

  // Expiry: sign for the shortest TTL R2 will accept (1s), wait past it,
  // and confirm the SAME url that worked a moment ago now fails. This is
  // what makes "short-lived" a proven property instead of an assumption.
  const shortLivedUrl = file.presign({ expiresIn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const expiredResponse = await fetch(shortLivedUrl);
  if (expiredResponse.ok) {
    throw new Error(
      `presigned GET should have expired but still returned ${expiredResponse.status}`,
    );
  }
  console.log(`expiry   ok  (1s URL rejected after waiting: ${expiredResponse.status})`);

  await file.delete();
  console.log("delete   ok");

  // Closes the loop: the same key must read as absent again after delete,
  // not linger truthy due to some R2/edge-cache quirk this app would
  // otherwise never notice.
  const missingAfterDelete = await file.exists();
  if (missingAfterDelete !== false) {
    throw new Error(`exists() after delete returned ${missingAfterDelete}, expected false`);
  }
  console.log("exists   ok  (deleted key -> false again)");

  console.log("\nR2 is correctly configured.");
}

main().catch((error: unknown) => {
  console.error(`\nR2 check FAILED\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
