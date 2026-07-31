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

// Branded key type (task #78) — the compiler-enforced half of what used to
// be JUST this file's header comment. `R2Key` is a plain `string` at
// runtime (the intersection with `{ readonly __r2: unique symbol }` is
// erased entirely; nothing about a string's runtime representation changes),
// but a bare `string` is NOT assignable to it, so TypeScript rejects a hand-
// rolled literal or variable passed to `putObject`/`getPresignedUrl`/
// `deleteObject` below.
//
// This closes the SPECIFIC gap #38's review flagged: nothing used to stop a
// future call site from writing `putObject(\`galleries/${id}/…\`, …)` by
// hand, skipping `namespacedKey` and landing a dev write in the production
// slice of the bucket. Now the ONLY ways to produce an `R2Key` are the
// builders below (`proofKey`/`finalKey`/`displayKey`, all funneled through
// `namespacedKey`) and the two named escape hatches (`nonGalleryKey`,
// `storedKey`) — every one of them greppable by searching this file for
// `as R2Key`.
//
// What this does NOT do: stop a caller from constructing its own
// `Bun.S3Client` and bypassing this module entirely (scripts/check-r2.ts
// does exactly that, deliberately — see its own header comment), or verify
// that `APP_ENV` is set correctly wherever the process runs. Both of those
// stay exactly as true as they were before this task; the type system can
// only make the boundary of THIS module hard to cross by accident, not make
// the module itself mandatory to go through.
//
// The second gap — nothing here verifies `APP_ENV` — is task #81's, and it
// is deliberately NOT closed by changing this file: making the builders
// below throw on unset `APP_ENV` would reverse `namespacedKey`'s fail-closed
// default for the RUNNING APP, not just for ops scripts, since this module
// cannot tell the two apart. Instead, one-shot ops scripts (a finals
// backfill for #26 is the anticipated case; `scripts/backfill-display-
// derivatives.ts` for #89 is the one that shipped) call
// `assertAppEnvIsSet()` from `scripts/lib/assert-app-env.ts` before minting
// or writing a real key — see that module's header for the full mechanism,
// and `scripts/ops-r2-guard.test.ts` for the test that fails `bun run test`
// if a script IMPORTS (under any local name — enforcement keys off the
// import, not the call site) one of `proofKey`/`finalKey`/`displayKey`/
// `putObject`/`deleteObject` without also calling that guard.
export type R2Key = string & { readonly __r2: unique symbol };

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
// This mechanism keys off `APP_ENV` alone — it is a naming convention this
// one function enforces, not a capability restriction: it does not stop a
// process that sets `APP_ENV=production` (accidentally or otherwise) from
// getting the production shape out of `proofKey`/`finalKey`. The isolation
// this buys is only as good as `APP_ENV` being set correctly wherever this
// process runs — see `.github/workflows/deploy.yml`'s release.env step, the
// only place `APP_ENV=production` is written, and note it is written for the
// systemd-managed app process ONLY — an ops script run outside that unit
// (by hand over SSH, or via `deploy.yml`'s own `sudo -n -u photoshowcase bun
// …` steps) inherits none of it; see this file's own "What this does NOT
// do" paragraph above for the guard those scripts must call instead
// (task #81). A stronger option (separate bucket + scoped token) was considered and
// rejected as disproportionate for now; see task #38. What task #78 adds on
// top is narrower and orthogonal: it is no longer possible to skip this
// function's prefixing *by forgetting to call it* and handing a raw string
// to `putObject`/`getPresignedUrl`/`deleteObject` instead — see `R2Key`
// above.
//
// Any future key builder added to this file — e.g. #26's finals-upload path —
// inherits the namespacing for free by construction: it must call
// `namespacedKey` for its path to end up in the bucket at all, the same way
// `proofKey` and `finalKey` do below.
//
// This is also the ONE place in this file that mints an `R2Key` from an
// unbranded string outside the two named escape hatches — every builder
// below returns exactly what this function hands back.
function namespacedKey(key: string): R2Key {
  return (process.env.APP_ENV === "production" ? key : `dev/${key}`) as R2Key;
}

/** Low-res, watermarked proof. Exists for every asset from the start. */
export function proofKey(galleryId: string, assetId: string): R2Key {
  return namespacedKey(`galleries/${galleryId}/proofs/${assetId}.webp`);
}

/** Full-res, no watermark. Exists only for assets the client selected. */
export function finalKey(galleryId: string, assetId: string): R2Key {
  return namespacedKey(`galleries/${galleryId}/finals/${assetId}.jpg`);
}

/** Browsing-sized, no watermark — the derivative a DELIVERED gallery shows in
 * its grid and lightbox (task #89). Derived from the final, never from the
 * original: see `processDisplay`'s own section header in src/lib/images.ts.
 *
 * NO NEW COLUMN, and this is why. Like `proofKey` and `finalKey` above, this
 * is a pure function of `(galleryId, assetId)` (plus `APP_ENV`, which is
 * fixed for a given running process) — the same pair always yields the same
 * string, so there is nothing per-row left to remember. A display object's
 * EXISTENCE is therefore implied by exactly the same facts that imply a
 * final's: `assets.final_key` is set and `assets.is_edited` is true, because
 * the one route that writes a final (POST
 * /api/assets/[assetId]/final/route.ts) writes this derivative in the same
 * request, and scripts/backfill-display-derivatives.ts closes the gap for
 * finals uploaded before task #89 shipped. A `display_key` column would hold
 * a value the app can already compute, and would then have to be kept in
 * sync with a key builder that cannot change without a data migration
 * anyway. Same reasoning schema.ts's `proof_key` predates — it stores a key
 * because it was written before this determinism was established; nothing new
 * should follow that shape.
 *
 * Distinct extension from the final (`.webp` vs `.jpg`) as well as a distinct
 * prefix, so the two can never collide even if a future refactor got the
 * folder wrong. */
export function displayKey(galleryId: string, assetId: string): R2Key {
  return namespacedKey(`galleries/${galleryId}/display/${assetId}.webp`);
}

/** Escape hatch #1 (task #78): mints an `R2Key` for a legitimate key that
 * isn't shaped like `galleries/{galleryId}/…` at all — today, that's just
 * scripts/check-r2.ts's throwaway healthcheck probe. Still funnels through
 * `namespacedKey`, so it lands in the same dev/prod slice of the bucket as
 * every gallery-shaped key; it only skips the `galleries/…` path shape the
 * builders above hard-code.
 *
 * Reach for this ONLY when a key genuinely has nothing to do with a gallery
 * or asset. Anything about a gallery or asset belongs in
 * `proofKey`/`finalKey`/`displayKey` instead — that's the whole point of
 * branding this type in the first place. */
export function nonGalleryKey(key: string): R2Key {
  return namespacedKey(key);
}

/** Escape hatch #2 (task #78): re-attaches the `R2Key` brand to a key read
 * back out of the database. `assets.proof_key`/`assets.final_key` are plain
 * `text` columns (see schema.ts) — Drizzle infers them as ordinary
 * `string`, so the brand `proofKey()`/`finalKey()` applied at write time
 * doesn't survive the round trip through Postgres.
 *
 * Deliberately does NOT call `namespacedKey`: a value passed here is already
 * namespaced, from whichever `APP_ENV` was active when some route wrote it
 * — reapplying the prefix would double it (`dev/dev/galleries/…`).
 *
 * Use this ONLY for a value that came off an `assets` row originally written
 * by `proofKey()`/`finalKey()`. It is, deliberately, just as easy to misuse
 * as an inline `as R2Key` — the type system cannot prove where a `string`
 * actually came from — but misuse is now a `grep -rn "storedKey("` away
 * instead of scattered `as R2Key` casts with no shared name to search for. */
export function storedKey(key: string): R2Key {
  return key as R2Key;
}

/** Whatever Bun's S3Client accepts as a write body: buffers, blobs, streams, ... */
export type PutObjectBody = Parameters<S3Client["write"]>[1];

/** Uploads bytes to R2 under `key`. `contentType` is required — R2 objects
 * are served back to clients via presigned URL, so the browser needs a
 * correct Content-Type to render them.
 *
 * `key` must be an `R2Key` (task #78) — the only way to get one is a builder
 * above or a named escape hatch, never a bare string literal. */
export async function putObject(
  key: R2Key,
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
 * navigation to this URL.
 *
 * `key` must be an `R2Key` (task #78) — see `putObject`'s own comment on
 * what that means and what it doesn't. */
export function getPresignedUrl(key: R2Key, options?: { contentDisposition?: string }): string {
  return getClient().presign(key, {
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
    ...(options?.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
  });
}

/** Deletes an object from R2 (e.g. when a gallery or asset is removed).
 *
 * `key` must be an `R2Key` (task #78) — see `putObject`'s own comment on
 * what that means and what it doesn't. */
export async function deleteObject(key: R2Key): Promise<void> {
  await getClient().delete(key);
}

// Task #78 deliberately stops the `R2Key` requirement at the three functions
// above (`putObject`, `getPresignedUrl`, `deleteObject`) and does NOT widen
// it to the three read-only HEAD/stream functions below
// (`getObjectStream`, `getObjectSize`, `objectExists`), even though they
// take a `key: string` too and are just as easy to call with a hand-rolled
// value. Reasoning: the risk this task closes is specifically the one #38's
// review named — a caller skipping `namespacedKey` and landing a WRITE, or a
// URL handed to a real BROWSER, in the wrong dev/prod slice, silently. A
// wrongly-shaped key reaching one of the three functions below instead fails
// LOUD and immediately (a 404 from a HEAD request, or an empty/erroring
// stream) — there is no silent cross-namespace side effect to prevent, only
// an ordinary "object not found" bug with an ordinary blast radius. Widening
// to these three later, once #26 or another slice gives a concrete reason,
// is cheap and welcome; doing it now would only add three more `storedKey`
// call sites for no closed risk.

/** Streams `key`'s bytes directly out of R2 — task #29 (download-all-as-zip).
 * This is the one deliberate, DOCUMENTED exception in this codebase to
 * PLAN.md §5's "the droplet never streams image bytes" rule: see the route
 * that calls this (src/app/api/galleries/[galleryId]/download-all/route.ts)
 * for the full reasoning behind building the zip on the droplet at all
 * rather than in a Cloudflare Worker, and PLAN.md §11 for the decision
 * record.
 *
 * Callers must have already verified the requesting session owns the
 * gallery — same contract as `getPresignedUrl` above, this module has no
 * notion of ownership.
 *
 * Returns a `ReadableStream` (Bun's native `S3File.stream()`, itself just an
 * inherited `Blob.stream()` — `S3File extends Blob`), NOT a buffered
 * `Buffer`/`ArrayBuffer` — the whole point of this function existing
 * separately from `getPresignedUrl` is that callers can pipe these bytes
 * through without ever holding a whole object in memory. See
 * src/lib/zip-stream.ts's own header comment for how the one caller that
 * exists today (the zip writer) uses this guarantee. */
export function getObjectStream(key: string): ReadableStream<Uint8Array> {
  return getClient().file(key).stream();
}

/** Byte size of the object at `key`, via R2 HEAD request — no object bytes
 * are read. Task #29 follow-up: the download-all route's pre-flight
 * capacity check (`checkZip32Limits` in src/lib/zip-stream.ts) needs every
 * entry's size BEFORE opening any stream, so a gallery that would overflow
 * this app's Zip64-less writer can be refused cleanly instead of dying
 * mid-archive. Bun's `S3Client` exposes exactly that: `.size()` resolves a
 * byte count off a HEAD request alone (see bun-types/s3.d.ts's own comment,
 * "Uses HEAD request to efficiently get size") — it never downloads the
 * object, the same guarantee `getObjectStream` above relies on for the
 * opposite reason (it DOES want the bytes, just lazily/one at a time).
 * Same ownership-already-verified contract as every other function in this
 * module: this has no notion of ownership, callers must have checked it. */
export async function getObjectSize(key: string): Promise<number> {
  return getClient().size(key);
}

/** Whether an object exists at `key`, via R2 HEAD request — no object bytes
 * are read (Bun's `S3Client.exists()`, the same HEAD-only mechanism
 * `getObjectSize` above uses).
 *
 * Task #89's ONE caller: GET /api/assets/[assetId]/display. Because
 * `displayKey` (above) is deterministic, nothing in the database records
 * whether a given asset's display derivative has actually been written yet —
 * and for a final uploaded BEFORE task #89 shipped, it has not been, until
 * scripts/backfill-display-derivatives.ts runs. That route uses this to turn
 * "the object isn't there" into a clean 404 the client falls back to the
 * (watermarked) proof on, instead of a broken thumbnail.
 *
 * Deliberately NOT called from the gallery page's render path: that would be
 * one R2 round trip per asset per page load, forever, to answer a question
 * that is permanently "yes" once the backfill has run. This lives on the
 * error path only. */
export async function objectExists(key: string): Promise<boolean> {
  return getClient().exists(key);
}
