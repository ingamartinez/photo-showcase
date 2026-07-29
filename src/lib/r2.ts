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
//
// `S3Client` is imported as a TYPE ONLY (erased at compile time, zero
// runtime footprint) and constructed at runtime off the global `Bun`
// namespace instead of a value import of the "bun" module specifier. This
// matters because `next build`'s "Collecting page data" step evaluates every
// route module's compiled output in a plain Node.js worker process (spawned
// via jest-worker) even when the whole `next build` invocation itself runs
// under `bun run build` — that worker cannot resolve the bare `bun` module
// specifier, and it fails on evaluation alone, before anything in this file
// is ever called. A value `import { S3Client } from "bun"` survives into the
// compiled bundle and breaks that step for every route that reaches this
// module, regardless of `r2Env()`'s own laziness (a DIFFERENT trap from the
// module-scope-env one this file already guards against below). The global
// `Bun` reference below is inert during that evaluation (nothing calls
// `getClient()` at module scope) and resolves for real once this code
// actually runs — dev, build, and production all execute under the real
// Bun runtime in this app, where the `Bun` global is always present.
import type { S3Client } from "bun";
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
    client = new Bun.S3Client({
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
//
// Dev and prod currently share one R2 bucket and one set of credentials
// (task #38). Every key funnels through `namespacedKey` below, which prefixes
// the key with `dev/` unless `APP_ENV` is exactly `"production"`. That keeps
// dev writes in a distinct, separable slice of the bucket, and it fails
// CLOSED: any environment that never sets `APP_ENV` (a fresh clone, a
// misconfigured host, a future CI job) gets the `dev/` prefix by default, not
// the bare production shape.
//
// This deliberately does NOT read `process.env.NODE_ENV`. `NODE_ENV` is
// constant-folded by Next/Turbopack at build time (see
// `node_modules/next/dist/build/define-env.js`) — the `?:` branch on it gets
// dead-code-eliminated out of the compiled server bundle entirely, so a
// build produces the SAME hardcoded key shape regardless of which machine or
// environment later runs it. `APP_ENV` is not a Next-recognized build-time
// constant, so `r2Env()`'s own pattern of reading `process.env` lazily
// inside a function (never at module scope) stays dynamic through the build,
// the same way it already does for the R2 credentials themselves.
//
// This mechanism keys off `APP_ENV` alone — it is a naming convention
// enforced by this one function, not a capability restriction. It does NOT,
// on its own, stop a process from constructing a bare `galleries/…` key: any
// code that sets `APP_ENV=production` (accidentally or otherwise) before
// calling `proofKey`/`finalKey` gets the production shape. The isolation this
// buys is only as good as `APP_ENV` being set correctly wherever this process
// runs — see `.github/workflows/deploy.yml`'s release.env step, the only
// place `APP_ENV=production` is written for the real deployed process. A
// stronger option (separate bucket + scoped token) was considered and
// rejected as disproportionate for now; see task #38.
//
// Any future key builder added to this file — e.g. #26's finals-upload path —
// inherits the namespacing for free by construction: it must call
// `namespacedKey` for its path to end up in the bucket at all, the same way
// `proofKey` and `finalKey` do below.
function namespacedKey(key: string): string {
  return process.env.APP_ENV === "production" ? key : `dev/${key}`;
}

/** Low-res, watermarked proof. Exists for every asset from the start. */
export function proofKey(galleryId: string, assetId: string): string {
  return namespacedKey(`galleries/${galleryId}/proofs/${assetId}.webp`);
}

/** Full-res, no watermark. Exists only for assets the client selected. */
export function finalKey(galleryId: string, assetId: string): string {
  return namespacedKey(`galleries/${galleryId}/finals/${assetId}.jpg`);
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
 * notion of ownership, it only talks to R2.
 *
 * `contentDisposition` (task #28) is forwarded straight to R2's
 * `response-content-disposition` presign override — it does NOT change what
 * gets stored, only what header R2 answers THIS GET with. This is the fix
 * for "a phone browser opened the file instead of downloading it": a plain
 * presigned URL has no `Content-Disposition`, and a mobile browser
 * navigating to an `image/*` URL with no such header renders it inline
 * (exactly what a client wants for a PROOF, browsed in a grid — see the
 * proof route, which never passes this option — but not for a FINAL, which
 * exists to be saved to the phone's camera roll/downloads). Passing
 * `attachment; filename="…"` here is what turns that same navigation into an
 * actual download with a sensible filename, on both iOS Safari and Android
 * Chrome, without needing any client-side download plumbing beyond a normal
 * navigation to this URL. */
export function getPresignedUrl(key: string, options?: { contentDisposition?: string }): string {
  return getClient().presign(key, {
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
    ...(options?.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
  });
}

/** Deletes an object from R2 (e.g. when a gallery or asset is removed). */
export async function deleteObject(key: string): Promise<void> {
  await getClient().delete(key);
}
