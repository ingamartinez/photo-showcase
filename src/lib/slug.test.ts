import { describe, expect, it } from "vitest";
import { generateGallerySlug } from "./slug";

describe("generateGallerySlug", () => {
  it("returns a different value on every call", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateGallerySlug()));
    expect(seen.size).toBe(200);
  });

  // The function takes no title/counter argument at all — this guards against
  // a future "helpful" refactor that starts hashing or deriving it from one.
  it("is not derived from anything — two calls in a row never match", () => {
    const a = generateGallerySlug();
    const b = generateGallerySlug();
    expect(a).not.toBe(b);
  });

  it("is not sequential — consecutive slugs share no predictable prefix", () => {
    const slugs = Array.from({ length: 10 }, () => generateGallerySlug());
    for (let i = 1; i < slugs.length; i++) {
      expect(slugs[i]).not.toBe(slugs[i - 1]);
      expect(slugs[i].slice(0, 4)).not.toBe(slugs[i - 1].slice(0, 4));
    }
  });

  it("is URL-safe (base64url — no characters that need percent-encoding)", () => {
    const slug = generateGallerySlug();
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries at least 128 bits of entropy (16 raw bytes, base64url-encoded)", () => {
    const slug = generateGallerySlug();
    // base64url encodes 3 bytes as 4 chars, no padding — 16 bytes -> 22 chars.
    expect(slug.length).toBeGreaterThanOrEqual(22);
  });
});
