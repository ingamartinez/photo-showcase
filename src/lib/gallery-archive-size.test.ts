import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZIP32_MAX_ENTRY_COUNT, ZIP32_MAX_TOTAL_BYTES } from "@/lib/zip-stream";

vi.mock("server-only", () => ({}));

const getObjectSizeMock = vi.fn<(key: string) => Promise<number>>();
vi.mock("@/lib/r2", () => ({
  getObjectSize: (...args: [string]) => getObjectSizeMock(...args),
}));

function asset(
  overrides: Partial<{
    finalKey: string | null;
    isSelected: boolean;
    isEdited: boolean;
  }> = {},
) {
  return {
    finalKey: "galleries/g1/finals/a1.jpg",
    isSelected: true,
    isEdited: true,
    ...overrides,
  };
}

beforeEach(() => {
  getObjectSizeMock.mockReset();
});

describe("getGalleryArchiveSize", () => {
  it("returns null and issues no R2 request when there is no deliverable asset", async () => {
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    const result = await getGalleryArchiveSize([
      asset({ isSelected: false }),
      asset({ isEdited: false }),
      asset({ finalKey: null }),
    ]);

    expect(result).toBeNull();
    expect(getObjectSizeMock).not.toHaveBeenCalled();
  });

  it("returns null for an empty asset list", async () => {
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    await expect(getGalleryArchiveSize([])).resolves.toBeNull();
    expect(getObjectSizeMock).not.toHaveBeenCalled();
  });

  it("sums every deliverable asset's own size via getObjectSize, ignoring the non-deliverable ones", async () => {
    getObjectSizeMock.mockResolvedValue(1024);
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    const result = await getGalleryArchiveSize([
      asset({ finalKey: "galleries/g1/finals/a1.jpg" }),
      asset({ finalKey: "galleries/g1/finals/a2.jpg" }),
      asset({ isSelected: false }), // never queried
    ]);

    expect(getObjectSizeMock).toHaveBeenCalledTimes(2);
    expect(result?.status).toBe("ok");
    expect(result?.entryCount).toBe(2);
    // Real bytes plus this format's own fixed per-entry overhead
    // (computeZipArchiveByteSize) — strictly more than the raw sum of sizes.
    expect(result?.totalBytes).toBeGreaterThan(2 * 1024);
  });

  // Task #93's own gap, reused here rather than re-triggered: a stale
  // finalKey must not make this function itself throw — it counts as a
  // 0-byte contribution, not an error. See this function's own header
  // comment on why this deliberately does NOT also notify the photographer.
  it("treats a getObjectSize rejection as a 0-byte contribution, never throwing", async () => {
    getObjectSizeMock.mockRejectedValueOnce(new Error("no object at key"));
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    await expect(
      getGalleryArchiveSize([asset({ finalKey: "galleries/g1/finals/missing.jpg" })]),
    ).resolves.toMatchObject({ status: "ok", entryCount: 1 });
  });

  it("reports 'approaching' once the total crosses 80% of the byte ceiling, before it actually crosses it", async () => {
    // Two entries whose sizes alone sum to ~85% of the ceiling — status must
    // already be "approaching", and the archive must NOT be reported as
    // already refused ("over").
    const perEntry = Math.floor((ZIP32_MAX_TOTAL_BYTES * 0.85) / 2);
    getObjectSizeMock.mockResolvedValue(perEntry);
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    const result = await getGalleryArchiveSize([
      asset({ finalKey: "galleries/g1/finals/a1.jpg" }),
      asset({ finalKey: "galleries/g1/finals/a2.jpg" }),
    ]);

    expect(result?.status).toBe("approaching");
  });

  it("reports 'ok' for a gallery nowhere near either ceiling — the realistic case today", async () => {
    getObjectSizeMock.mockResolvedValue(20 * 1024 * 1024); // ~20 MiB, a real final
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    const result = await getGalleryArchiveSize([
      asset({ finalKey: "galleries/g1/finals/a1.jpg" }),
      asset({ finalKey: "galleries/g1/finals/a2.jpg" }),
    ]);

    expect(result?.status).toBe("ok");
  });

  it("reports 'over' once the total crosses the byte ceiling", async () => {
    const perEntry = Math.ceil((ZIP32_MAX_TOTAL_BYTES + 1_000_000) / 2);
    getObjectSizeMock.mockResolvedValue(perEntry);
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    const result = await getGalleryArchiveSize([
      asset({ finalKey: "galleries/g1/finals/a1.jpg" }),
      asset({ finalKey: "galleries/g1/finals/a2.jpg" }),
    ]);

    expect(result?.status).toBe("over");
  });

  // Symmetric with the byte ceiling — the ENTRY-COUNT axis reads off
  // `ZIP32_MAX_ENTRY_COUNT` too, never a restated number (task #92's own
  // acceptance criterion). Tiny per-entry sizes so this is really the
  // entry-count leg driving the result, not the byte leg.
  it("reports 'approaching' once entry count alone crosses 80% of ZIP32_MAX_ENTRY_COUNT", async () => {
    getObjectSizeMock.mockResolvedValue(1);
    const { getGalleryArchiveSize } = await import("./gallery-archive-size");

    const count = Math.ceil(ZIP32_MAX_ENTRY_COUNT * 0.85);
    const assets = Array.from({ length: count }, (_, i) =>
      asset({ finalKey: `galleries/g1/finals/a${i}.jpg` }),
    );

    const result = await getGalleryArchiveSize(assets);

    expect(result?.status).toBe("approaching");
    expect(result?.entryCount).toBe(count);
  });
});
