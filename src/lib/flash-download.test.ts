import { describe, expect, it } from "vitest";
import { flashPhotoFilename, flashZipFilename } from "./flash-download";

describe("flash download filenames", () => {
  it("slugifies the zip name and falls back when nothing survives", () => {
    expect(flashZipFilename("Cumpleaños de Sofi!")).toBe("cumpleanos-de-sofi-fotos.zip");
    expect(flashZipFilename("🎉")).toBe("galeria-fotos.zip");
  });

  it("names a photo for what is actually stored and dedupes collisions", () => {
    const used = new Set<string>();
    expect(flashPhotoFilename("DSC 0001.JPG", "flash/g/finals/a.png", used)).toBe("dsc-0001.png");
    expect(flashPhotoFilename("dsc_0001.jpg", "flash/g/finals/b.png", used)).toBe("dsc-0001-2.png");
  });
});
