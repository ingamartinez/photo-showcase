import { describe, expect, it } from "vitest";
import { buildFlashMetadata } from "./flash-meta";

const photo = { displayWidth: 1600, displayHeight: 1067 };
const publicGallery = { title: "Cumple de Sofi", isPublic: true, publicSlug: "abc" };

describe("buildFlashMetadata", () => {
  it("shares title and a STABLE own-route image for a public gallery with photos", () => {
    const meta = buildFlashMetadata(publicGallery, photo);
    expect(meta.title).toBe("Cumple de Sofi");
    expect(meta.openGraph).toMatchObject({
      title: "Cumple de Sofi",
      images: [{ url: "/flash/abc/og-image", width: 1600, height: 1067 }],
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
    expect(meta.robots).toEqual({ index: false, follow: false });
    // Never a presigned R2 URL.
    expect(JSON.stringify(meta)).not.toMatch(/X-Amz|r2\.|https?:/);
  });

  it("leaks neither title nor image for a private gallery (generic OG, noindex only)", () => {
    const meta = buildFlashMetadata({ ...publicGallery, isPublic: false }, photo);
    expect(meta).toEqual({ robots: { index: false, follow: false } });
    expect(JSON.stringify(meta)).not.toContain("Cumple");
  });

  it("falls back to generic for a public gallery without photos", () => {
    expect(buildFlashMetadata(publicGallery, null)).toEqual({
      robots: { index: false, follow: false },
    });
  });

  it("is generic and noindex when the gallery does not resolve", () => {
    expect(buildFlashMetadata(null, null)).toEqual({ robots: { index: false, follow: false } });
  });
});
