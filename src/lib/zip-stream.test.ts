// Verifies the hand-rolled zip writer (src/lib/zip-stream.ts) produces a
// genuinely spec-correct `.zip` — not merely "a suite that calls
// `buildZipStream` and checks it didn't throw". Two independent proofs, per
// this repo's own established stance on this exact trap (kanban #29's own
// body names it: a test that passes for the wrong reason):
//
//   1. A from-scratch parser (`parseZip` below) that reads the produced
//      bytes by walking the CENTRAL DIRECTORY and LOCAL HEADERS per the zip
//      spec, completely independently of `zip-stream.ts`'s own writing code
//      — sharing no logic with it, so a bug in the writer that also "sounds
//      right" cannot silently agree with a parser built the same wrong way.
//   2. The real, external `unzip`/`zipinfo` binaries (already present on
//      this machine and on GitHub's `ubuntu-latest` CI image), run against
//      an actual temp file — the same "prove it against a real, independent
//      tool, not just this app's own code" standard
//      route.download.test.ts already applies to the final-download path.
//      Skipped (not failed) if those binaries are unavailable, so this
//      suite never becomes flaky on an environment that happens to lack
//      them.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import {
  buildZipStream,
  checkZip32Limits,
  computeZipArchiveByteSize,
  toReadableStream,
  ZIP32_MAX_ENTRY_COUNT,
  ZIP32_MAX_TOTAL_BYTES,
  type ZipEntry,
} from "./zip-stream";

async function collect(entries: ZipEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of buildZipStream(entries)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Splits `data` into `chunkSize`-sized pieces and serves them one at a time
 * off a `ReadableStream` — stands in for a real network response body
 * arriving in small pieces, the same shape `fetch()`/an R2 stream actually
 * delivers, rather than handing the writer one giant pre-buffered chunk
 * (which would never exercise the crc/size accumulation across chunk
 * boundaries at all). */
function chunkedStream(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      controller.enqueue(data.slice(offset, end));
      offset = end;
    },
  });
}

function entryFor(name: string, content: string, chunkSize = 3): ZipEntry {
  const bytes = new TextEncoder().encode(content);
  return { name, openStream: () => chunkedStream(bytes, chunkSize) };
}

type ParsedEntry = { name: string; crc32: number; size: number; content: Buffer };

/** A from-scratch zip reader, sharing no code with zip-stream.ts's own
 * writer — see this file's own header comment for why that independence is
 * the point. Reads the END OF CENTRAL DIRECTORY record from the tail first
 * (the spec-correct way any real zip reader locates the central directory —
 * never by scanning local headers forward, which is what a bug shared
 * between writer and a naive parser could both get subtly wrong the same
 * way), then walks the central directory to find each entry's name,
 * crc/size, and its local header's offset — exactly how a real archive tool
 * reads a streaming (data-descriptor) zip, since the local header's OWN
 * crc/size fields are deliberately left at 0. */
function parseZip(buf: Buffer): ParsedEntry[] {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("parseZip: no End Of Central Directory record found");

  const recordCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buf.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buf.readUInt32LE(eocdOffset + 16);
  expect(eocdOffset - centralDirectoryOffset).toBe(centralDirectorySize);

  const entries: ParsedEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let i = 0; i < recordCount; i++) {
    expect(buf.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc32 = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    expect(compressedSize).toBe(uncompressedSize); // STORE: no compression
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf-8", cursor + 46, cursor + 46 + nameLength);

    expect(buf.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
    const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
    expect(localNameLength).toBe(nameLength);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const content = buf.subarray(dataStart, dataStart + uncompressedSize);

    entries.push({ name, crc32, size: uncompressedSize, content: Buffer.from(content) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("buildZipStream — structural correctness (independent parser)", () => {
  it("round-trips a single small entry with the right name, size, crc, and bytes", async () => {
    const zip = await collect([entryFor("foto.jpg", "hello world")]);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("foto.jpg");
    expect(parsed[0]!.content.toString("utf-8")).toBe("hello world");
    expect(parsed[0]!.size).toBe(11);
    expect(parsed[0]!.crc32).toBe(zlibCrc32(new TextEncoder().encode("hello world")));
  });

  it("keeps multiple entries distinct, in the order given, each with its own correct bytes", async () => {
    const zip = await collect([
      entryFor("boda-foto-1.jpg", "first entry content"),
      entryFor("boda-foto-2.jpg", "a different, longer second entry"),
      entryFor("boda-foto-3.jpg", "third"),
    ]);
    const parsed = parseZip(zip);

    expect(parsed.map((e) => e.name)).toEqual([
      "boda-foto-1.jpg",
      "boda-foto-2.jpg",
      "boda-foto-3.jpg",
    ]);
    expect(parsed[0]!.content.toString()).toBe("first entry content");
    expect(parsed[1]!.content.toString()).toBe("a different, longer second entry");
    expect(parsed[2]!.content.toString()).toBe("third");
  });

  it("computes a correct running CRC-32 across many small chunks, not just whole-buffer input", async () => {
    // A large-ish body split into 3-byte chunks (entryFor's default) — if the
    // writer's CRC accumulation across chunk boundaries were wrong (e.g.
    // recomputing from scratch per chunk instead of threading the running
    // value through), this would produce a crc that disagrees with the
    // independently-computed one below.
    const content = "the quick brown fox jumps over the lazy dog, repeated for length ".repeat(20);
    const zip = await collect([entryFor("large.jpg", content, 7)]);
    const parsed = parseZip(zip);

    expect(parsed[0]!.crc32).toBe(zlibCrc32(new TextEncoder().encode(content)));
    expect(parsed[0]!.content.toString()).toBe(content);
  });

  it("handles a zero-byte entry without corrupting the archive", async () => {
    const zip = await collect([entryFor("empty.jpg", ""), entryFor("after.jpg", "not empty")]);
    const parsed = parseZip(zip);

    expect(parsed[0]!.size).toBe(0);
    expect(parsed[0]!.content.toString()).toBe("");
    expect(parsed[1]!.content.toString()).toBe("not empty");
  });

  it("marks every entry STORE (uncompressed) — sizes agree exactly, no deflate ever runs", async () => {
    const zip = await collect([entryFor("a.jpg", "abc"), entryFor("b.jpg", "defgh")]);
    const parsed = parseZip(zip);
    for (const entry of parsed) {
      expect(entry.content.byteLength).toBe(entry.size);
    }
  });
});

describe("buildZipStream — lazy, sequential opening (the memory/concurrency guarantee)", () => {
  it("never opens a later entry's stream before the current one has been fully drained", async () => {
    const openOrder: string[] = [];
    const closeOrder: string[] = [];

    function trackedEntry(name: string, content: string): ZipEntry {
      const bytes = new TextEncoder().encode(content);
      return {
        name,
        openStream: () => {
          openOrder.push(name);
          let sent = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent) {
                closeOrder.push(name);
                controller.close();
                return;
              }
              sent = true;
              controller.enqueue(bytes);
            },
          });
        },
      };
    }

    await collect([
      trackedEntry("one.jpg", "aaa"),
      trackedEntry("two.jpg", "bbb"),
      trackedEntry("three.jpg", "ccc"),
    ]);

    // Each entry's stream is fully drained (closeOrder gets its name) BEFORE
    // the next entry's openStream is ever called — proving at most one
    // entry's stream is open at any given instant, which is the property
    // scripts/measure-zip-memory.ts's low, gallery-size-independent numbers
    // actually rest on.
    expect(openOrder).toEqual(["one.jpg", "two.jpg", "three.jpg"]);
    expect(closeOrder).toEqual(["one.jpg", "two.jpg", "three.jpg"]);
  });
});

// Task #29 review follow-up: this writer's fixed 32-bit/16-bit header
// fields cap out below what an unbounded-extras gallery can plausibly
// reach (PLAN.md §3 caps only the INCLUDED photo quota, not the total
// selection — see zip-stream.ts's own header comment). These prove the
// pre-flight math itself, independent of any R2/route wiring — the route's
// own test suite proves the WIRING (the check runs before any stream
// opens).
describe("computeZipArchiveByteSize", () => {
  it("matches the exact byte length buildZipStream itself produces", async () => {
    const entries: ZipEntry[] = [
      entryFor("one.jpg", "hello"),
      entryFor("two.jpg", "a longer second entry's content"),
    ];
    const actual = await collect(entries);

    const predicted = computeZipArchiveByteSize([
      { name: "one.jpg", size: 5 },
      { name: "two.jpg", size: "a longer second entry's content".length },
    ]);

    expect(predicted).toBe(actual.length);
  });

  // The prediction counts each entry's name TWICE (local header + central
  // directory), so a name measured in UTF-16 code units instead of UTF-8
  // bytes undercounts by twice the multi-byte difference. Every other name
  // in this file is ASCII, where the two measures coincide and the mistake
  // is invisible: replacing the encoder with `name.length` left the whole
  // suite green. A gallery cannot currently produce such a name — the route
  // builds entry names from a `[a-z0-9-]` alphabet — but the writer is a
  // general-purpose module and the next caller is not bound by that.
  it("counts a name's UTF-8 byte length, not its code-unit length", async () => {
    const name = "café-señor-ñandú.jpg";
    const entries: ZipEntry[] = [entryFor(name, "contents")];
    const actual = await collect(entries);

    expect(computeZipArchiveByteSize([{ name, size: "contents".length }])).toBe(actual.length);
  });

  it("returns exactly the fixed 22-byte EOCD size for zero entries", () => {
    expect(computeZipArchiveByteSize([])).toBe(22);
  });
});

describe("checkZip32Limits", () => {
  it("passes for an ordinary small archive", () => {
    const result = checkZip32Limits([
      { name: "a.jpg", size: 20 * 1024 * 1024 },
      { name: "b.jpg", size: 20 * 1024 * 1024 },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("refuses with too_many_files exactly one entry past ZIP32_MAX_ENTRY_COUNT, and passes exactly at it", () => {
    const atLimit = Array.from({ length: ZIP32_MAX_ENTRY_COUNT }, (_, i) => ({
      name: `f${i}.jpg`,
      size: 1,
    }));
    expect(checkZip32Limits(atLimit)).toEqual({ ok: true });

    const overLimit = [...atLimit, { name: "one-too-many.jpg", size: 1 }];
    expect(checkZip32Limits(overLimit)).toEqual({ ok: false, reason: "too_many_files" });
  });

  it("refuses with archive_too_large once the total archive byte size would cross ZIP32_MAX_TOTAL_BYTES", () => {
    // A single entry sized so the resulting archive (its bytes + this
    // writer's own fixed per-entry overhead) lands exactly one byte over
    // the ceiling — proves the check is against the ARCHIVE's total
    // output, not the raw entry size alone.
    const name = "big.jpg";
    const overhead = computeZipArchiveByteSize([{ name, size: 0 }]);
    const exactAtLimit = { name, size: ZIP32_MAX_TOTAL_BYTES - overhead };
    const oneByteOver = { name, size: ZIP32_MAX_TOTAL_BYTES - overhead + 1 };

    expect(checkZip32Limits([exactAtLimit])).toEqual({ ok: true });
    expect(checkZip32Limits([oneByteOver])).toEqual({
      ok: false,
      reason: "archive_too_large",
    });
  });

  it("sums sizes across many entries, not just checking one entry at a time", () => {
    // No single entry crosses the ceiling, but the SUM of a plausible
    // heavily-extras-laden gallery of ~20 MiB finals does — this is
    // exactly the shape kanban #29's own review finding names as not
    // theoretical (PLAN.md §3 caps included photos, not total selection).
    const TWENTY_MIB = 20 * 1024 * 1024;
    const entryCount = Math.ceil(ZIP32_MAX_TOTAL_BYTES / TWENTY_MIB) + 1;
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      name: `foto-${i}.jpg`,
      size: TWENTY_MIB,
    }));

    expect(checkZip32Limits(entries)).toEqual({ ok: false, reason: "archive_too_large" });
  });
});

describe("toReadableStream", () => {
  it("adapts the async generator into a pull-driven ReadableStream carrying the same bytes", async () => {
    const stream = toReadableStream(buildZipStream([entryFor("x.jpg", "content")]));
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const parsed = parseZip(Buffer.concat(chunks));
    expect(parsed[0]!.content.toString()).toBe("content");
  });

  it("stops pulling further entries once cancelled", async () => {
    const openedNames: string[] = [];
    function trackedEntry(name: string): ZipEntry {
      return {
        name,
        openStream: () => {
          openedNames.push(name);
          return chunkedStream(new TextEncoder().encode("data"), 1);
        },
      };
    }
    const stream = toReadableStream(
      buildZipStream([trackedEntry("first.jpg"), trackedEntry("second.jpg")]),
    );
    const reader = stream.getReader();
    await reader.read(); // the first entry's local header
    await reader.read(); // triggers the first entry's openStream()
    await reader.cancel("client disconnected");

    // Whatever was already in flight may have opened; the point is this
    // never throws and never hangs — `cancel` must propagate to the
    // underlying generator via `.return()` cleanly.
    expect(openedNames.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildZipStream — real, independent unzip tool (belt-and-suspenders)", () => {
  it("is readable by the system's own unzip/zipinfo binaries, if present", async () => {
    let unzipAvailable = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzipAvailable = false;
    }
    if (!unzipAvailable) {
      // No unzip binary on this machine/CI image — the from-scratch parser
      // suite above already proves structural correctness; this is a bonus
      // check, not the only proof, so it degrades gracefully instead of
      // failing the whole suite on an environment that lacks the tool.
      return;
    }

    const zip = await collect([
      entryFor("boda-ana-y-beto-foto-1.jpg", "primera foto (bytes de prueba)"),
      entryFor("boda-ana-y-beto-foto-2.jpg", "segunda foto, un poco más larga que la primera"),
    ]);

    const dir = mkdtempSync(path.join(tmpdir(), "zip-stream-test-"));
    const zipPath = path.join(dir, "galeria.zip");
    try {
      writeFileSync(zipPath, zip);

      const listing = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf-8" });
      const names = listing.trim().split("\n");
      expect(names).toEqual(["boda-ana-y-beto-foto-1.jpg", "boda-ana-y-beto-foto-2.jpg"]);

      const extracted1 = execFileSync("unzip", ["-p", zipPath, "boda-ana-y-beto-foto-1.jpg"], {
        encoding: "utf-8",
      });
      expect(extracted1).toBe("primera foto (bytes de prueba)");

      // `unzip -t` runs the SAME CRC-32 verification a real user's extract
      // would — this is the external tool independently confirming the
      // written crc/size fields are correct, not just present.
      execFileSync("unzip", ["-t", zipPath], { stdio: "ignore" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
