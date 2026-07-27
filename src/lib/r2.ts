// Server-only R2 client — the ONLY module that constructs an S3 client or
// forms an object key. Everything else (proof upload route, the sharp
// pipeline, the ownership-checked read route, ...) calls into these
// functions instead of touching `Bun.S3Client` or building a key string by
// hand.
//
// Uses Bun's native S3Client (no AWS SDK dependency) — see scripts/check-r2.ts
// for the original write / read / presign+fetch / delete proof against the
// real bucket.
//
// Do not import this from a client component: `r2Env()` reads secrets and
// must stay server-only.

import { S3Client } from "bun";
import { r2Env } from "@/lib/env";

// Presigned GET URLs are handed to the browser only after a route has
// verified the session owns the gallery (see the ownership-checked read
// route). 5 minutes is long enough for a gallery page's <img> tags to finish
// loading even on a slow connection, but short enough that a copied or
// leaked URL is useless again shortly after the page is closed.
export const PRESIGNED_URL_TTL_SECONDS = 5 * 60;

// Lazy singleton. Constructing the client calls r2Env(), which must never
// run at module scope: `next build` imports every route module while
// collecting page data, and CI builds with no application environment. This
// has already broken the build once, for the auth config — do not repeat it
// here.
let client: S3Client | undefined;

function getClient(): S3Client {
  if (!client) {
    const env = r2Env();
    client = new S3Client({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      endpoint: env.R2_ENDPOINT,
    });
  }
  return client;
}

// Key builders — the ONLY place these strings are formed. Nothing else in
// the app should concatenate a gallery id or asset id into an R2 key by hand.

/** Low-res, watermarked proof. Exists for every asset from the start. */
export function proofKey(galleryId: string, assetId: string): string {
  return `galleries/${galleryId}/proofs/${assetId}.webp`;
}

/** Full-res, no watermark. Exists only for assets the client selected. */
export function finalKey(galleryId: string, assetId: string): string {
  return `galleries/${galleryId}/finals/${assetId}.jpg`;
}

/** Whatever Bun's S3Client accepts as a write body: buffers, blobs, streams, ... */
export type PutObjectBody = Parameters<S3Client["write"]>[1];

/** Uploads bytes to R2 under `key`. `contentType` is required — R2 objects
 * are served back to clients via presigned URL, so the browser needs a
 * correct Content-Type to render them. */
export async function putObject(
  key: string,
  body: PutObjectBody,
  options: { contentType: string },
): Promise<void> {
  await getClient().write(key, body, { type: options.contentType });
}

/** Short-lived presigned GET URL for `key`. Callers must have already
 * verified the requesting session owns the gallery — this module has no
 * notion of ownership, it only talks to R2. */
export function getPresignedUrl(key: string): string {
  return getClient().presign(key, { expiresIn: PRESIGNED_URL_TTL_SECONDS });
}

/** Deletes an object from R2 (e.g. when a gallery or asset is removed). */
export async function deleteObject(key: string): Promise<void> {
  await getClient().delete(key);
}
