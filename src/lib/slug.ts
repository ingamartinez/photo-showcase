// `public_slug` is the ONLY identifier that ever appears in a gallery URL
// (schema.ts's comment on `galleries.publicSlug`) — a client with the link
// must never be able to guess a sibling client's gallery by walking ids or
// titles. This file's only job is to generate that value: no title, no
// counter, no database read involved, so there is nothing here for a future
// "helpful" refactor to accidentally derive it from.
//
// No dependency added for this — `node:crypto` already ships with Bun/Node,
// and 16 random bytes (128 bits) is far more entropy than a slug needs to be
// practically unguessable.
import { randomBytes } from "node:crypto";

const SLUG_BYTES = 16;

/** A random, URL-safe, unguessable identifier for a new gallery. */
export function generateGallerySlug(): string {
  return randomBytes(SLUG_BYTES).toString("base64url");
}
