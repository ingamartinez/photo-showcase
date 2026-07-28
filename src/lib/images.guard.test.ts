// Defends the WIRING of the fontless-watermark guard, not its predicate.
//
// `images.test.ts` proves `assertTileHasInk` throws on a blank tile. That is
// the predicate. This file proves the guard is actually CALLED on the path
// that produces bytes — delete the `await assertTileHasInk(tile)` line in
// `buildWatermarkTile` and this test goes red while every other test stays
// green. Without it, a refactor can quietly drop the single line standing
// between a fontless droplet and a silently unwatermarked proof.
//
// It lives in its own file because it mocks `sharp`, which every other test
// here needs for real.
import { describe, expect, it, vi } from "vitest";

// `sharp` is typed with `export =`, so the module type is itself the callable
// — there is no `.default` on the type, only on the interop namespace object
// `vi.importActual` hands back at runtime.
type SharpModule = { default: typeof import("sharp") };

// Simulates a droplet with NO font installed for fontconfig: librsvg
// rasterizes the watermark's <text> to a fully transparent tile rather than
// throwing. That silence is the whole failure mode. Every input that is not
// the watermark SVG goes to the real sharp, so the rest of the pipeline
// behaves normally and the proof would otherwise be produced successfully.
vi.mock("sharp", async () => {
  const actual = (await vi.importActual<SharpModule>("sharp")).default;

  const fontless = ((input?: unknown, options?: unknown) => {
    const looksLikeSvg =
      Buffer.isBuffer(input) && input.subarray(0, 256).toString("utf8").includes("<svg");

    if (looksLikeSvg) {
      // 1x1 fully transparent; `buildWatermarkTile`'s trailing `.resize()`
      // scales it to the tile size, still carrying no ink.
      return actual({
        create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      });
    }

    return actual(input as never, options as never);
  }) as typeof actual;

  // Carry over sharp's statics — `images.ts` calls `sharp.cache(false)` and
  // `sharp.concurrency(1)` at module scope.
  Object.assign(fontless, actual);

  return { default: fontless };
});

describe("fontless watermark guard (wiring)", () => {
  it("refuses to produce a proof when the watermark tile rasterizes with no ink", async () => {
    const realSharp = (await vi.importActual<SharpModule>("sharp")).default;
    const { processProof } = await import("./images");

    // An ordinary, perfectly valid photo. Nothing about the INPUT is wrong —
    // the only fault is the host's missing font.
    const photo = await realSharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .jpeg()
      .toBuffer();

    const error = await processProof(photo).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    // The message has to name the cause: whoever hits this in production
    // needs to know it is a missing font package, not a bad upload.
    expect((error as Error).message).toMatch(/font/i);
    expect((error as Error).message).toMatch(/infra\/README\.md/);
  });
});
