// A minimal, STREAMING-ONLY zip writer (task #29 — "download all as a zip").
// No dependency was added for this: Node has no built-in ZIP *container*
// writer (`node:zlib` only does raw gzip/deflate, not the local-file-header +
// central-directory format a `.zip` actually is), but building one by hand is
// small and — crucially — lets this module guarantee the ONE property this
// task's memory acceptance criterion actually needs: at no point does this
// ever hold a whole file, let alone a whole gallery, in memory at once.
//
// Compression method is STORE (0), not DEFLATE, on purpose. Every entry this
// app ever zips is a JPEG (`processFinal`, src/lib/images.ts) — already
// DCT/entropy-coded — so re-compressing it with deflate would spend real CPU
// for a few percent at best (JPEG bytes are close to incompressible) and,
// worse, would force computing/holding a `Deflate` stream per entry. STORE
// needs nothing but a running CRC-32 and a byte counter per entry, both O(1)
// memory regardless of the entry's size.
//
// STREAMING technique — the "data descriptor" trick: a genuinely-streamed
// entry's CRC-32 and size are only known once ALL of its bytes have passed
// through, but a zip's LOCAL file header comes BEFORE the entry's bytes. This
// module writes that local header with CRC/sizes as 0 and general-purpose
// bit 3 SET (the documented "values are unknown, look at the data descriptor
// that follows this entry's data instead" signal — PKWARE's APPNOTE.TXT
// §4.3.9), then emits the real crc/sizes in a trailing data descriptor once
// the entry's stream ends. This is the standard, spec-legal way every
// streaming zip library (Python's `zipstream`, Node's `archiver`/`yazl` in
// their own streaming modes) produces a `.zip` without buffering an entry —
// this module does the same thing by hand instead of adding one of those as
// a dependency.
//
// Tradeoff, accepted and named: a FEW very old zip readers (old Windows
// built-in "Compressed Folders" from XP-era, ancient `unzip` builds) handle
// data-descriptor entries poorly or not at all. Every reader this product's
// actual audience uses — macOS Archive Utility, iOS/Android's built-in
// unzip, 7-Zip, modern `unzip`/`zipinfo` (verified in this task's own test
// suite, see zip-stream.test.ts) — reads them correctly. Precomputing sizes
// via a HEAD request per object first was considered and rejected: it removes
// the need for bit 3 on SIZES, but CRC-32 still requires reading every byte,
// so it buys nothing for the actual memory question this task exists to
// answer, at the cost of one extra R2 round trip per file.
//
// No Zip64 support: sizes/offsets are plain 32-bit fields, so this format
// caps out at ~4 GiB total archive size and 65,534 entries (see the
// `ZIP32_MAX_*` constants and their own comments further down for the exact
// numbers and why they're one short of the field widths' nominal max). Not
// implemented because it isn't needed here — PLAN.md §3's largest package
// includes 20 photos, and even a heavily-extras-laden gallery of a few
// hundred ~20 MiB finals (this module's own measured shape, see
// scripts/measure-zip-memory.ts) stays well under either limit. Worth
// revisiting only if this product's shape changes (e.g. video delivery).
// This IS enforced, not just documented: a review of this task found that
// crossing either ceiling doesn't corrupt an archive silently — every
// size/offset write below uses `Buffer.writeUInt32LE`, which THROWS a
// `RangeError` on overflow — but by the time that throw happens, this
// generator has already yielded a 200 response's worth of prior chunks,
// truncating the download with no clean error. `checkZip32Limits` below
// is the pre-flight fix: callers run it against every entry's known size
// BEFORE opening any R2 stream, and refuse cleanly if it would exceed
// either ceiling. See the route that does this
// (src/app/api/galleries/[galleryId]/download-all/route.ts).
import { crc32 as zlibCrc32 } from "node:zlib";

// --- Zip64-less format ceiling (task #29 review follow-up) -----------------
// Every size/offset field this writer emits (buildLocalFileHeader,
// buildCentralFileHeader, buildEndOfCentralDirectory above) is a plain
// 32-bit `writeUInt32LE`, and the entry count in the End Of Central
// Directory record is a plain 16-bit `writeUInt16LE`. Zip64 is the format's
// own extension for archives past those widths: a per-entry "Zip64 extra
// field" carrying real 64-bit sizes/offsets, activated by writing the
// SENTINEL value 0xFFFFFFFF (0xFFFF for the count) into the normal-width
// field instead of a genuine number, telling the reader "the real value is
// in the extra field, not here." This writer never emits that extra field —
// which is exactly why the sentinel values themselves must never be
// reachable as genuine sizes/offsets/counts. An archive that actually needed
// them would silently write "look elsewhere" into a header with nowhere else
// to look, and — per this review's own finding — `Buffer.writeUInt32LE`
// throws a `RangeError` on outright overflow (past 2**32), not silent
// wraparound, but that throw happens mid-generator, AFTER `buildZipStream`
// has already yielded a 200 response's worth of prior chunks. There is no
// way to turn a throw at that point into a clean HTTP status; the fix has to
// run BEFORE the first byte is streamed. See `checkZip32Limits` below, and
// the route that calls it before ever touching `buildZipStream`
// (src/app/api/galleries/[galleryId]/download-all/route.ts).
//
// Adopting real Zip64 support would mean: emitting a Zip64 extra field on
// any entry whose own size crosses 2**32, appending a Zip64 End Of Central
// Directory Record + Locator after the plain EOCD once total size or entry
// count crosses either ceiling, and switching every reader of this output
// (parseZip in zip-stream.test.ts, any external tool) to look at the extra
// field once the plain one reads as a sentinel. That's a second header
// format nested inside the first one, not a two-line change — not worth it
// for a product whose largest package is 20 included photos (PLAN.md §3);
// revisit if that shape changes (e.g. video delivery, or galleries growing
// enough that heavily-extras-laden ones routinely approach these numbers).
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

// Version 2.0 — the minimum that understands STORE + data descriptors, the
// only two format features this writer ever uses.
const VERSION = 20;

// General-purpose bit flag: bit 3 (0x0008, "sizes/crc are in a trailing data
// descriptor") OR'd with bit 11 (0x0800, "the file name below is UTF-8, not
// the legacy IBM437 codepage"). Every name this module ever writes is
// already plain ASCII (callers slugify before handing a name to this module
// — see the zip-entry-filename builder in the route that uses this), so bit
// 11 is a no-op in practice, but it costs nothing to set correctly.
const GENERAL_PURPOSE_FLAG = 0x0008 | 0x0800;

// Regular file, `rw-r--r--` — the Unix permission bits some readers (macOS
// Archive Utility, `unzip` on Linux) apply to an extracted entry when this
// external-attributes field is present. `0` (i.e. omitting permission info
// entirely) also works and is what a bare-bones writer would leave here; this
// sets a sane, explicit default instead of relying on every reader's own
// fallback.
const UNIX_REGULAR_FILE_RW_R__R__ = (0o100644 << 16) >>> 0;

/** The true representable maximum for the End Of Central Directory record's
 * 16-bit entry-count field — one LESS than 2**16, not 2**16 itself. The
 * value AT 2**16-1 (0xFFFF) is the Zip64 sentinel described in the block
 * comment above ("look elsewhere for the real count"), so an archive with
 * EXACTLY that many entries is already ambiguous to a strict reader before
 * this writer has even crossed a "real" limit; the safe enforced ceiling is
 * one entry short of the field's own nominal max. */
export const ZIP32_MAX_ENTRY_COUNT = 0xffff - 1; // 65,534

/** The true representable maximum for a 32-bit size/offset field, for the
 * same sentinel reason as `ZIP32_MAX_ENTRY_COUNT` above (0xFFFFFFFF is the
 * Zip64 escape value for size/offset fields). Enforced here against the
 * ARCHIVE'S total byte size — in practice the central directory's own
 * offset (itself a 32-bit field, `buildEndOfCentralDirectory`'s `cdOffset`)
 * is what would overflow first, since it equals the sum of every entry's
 * local header + bytes + data descriptor written before it. */
export const ZIP32_MAX_TOTAL_BYTES = 0xffffffff - 1; // ~4 GiB (4,294,967,294 bytes)

/** What `checkZip32Limits`/`computeZipArchiveByteSize` need per entry: just
 * a name and a byte size — exactly what a caller can get from an R2 HEAD
 * request (`getObjectSize` in src/lib/r2.ts, itself Bun's `S3Client.size()`)
 * WITHOUT ever opening the object's body, matching this whole check's own
 * point: know the shape before streaming a single byte. */
export type ZipEntrySizePlan = { name: string; size: number };

/** The exact final byte length `buildZipStream`'s own output would be for
 * `entries`, computed WITHOUT calling `buildZipStream` — no stream opened,
 * no bytes read, just the fixed per-entry overhead this writer always emits
 * (a 30-byte local header + the entry's name, the entry's own bytes, a
 * 16-byte data descriptor, and later a 46-byte central directory record +
 * the entry's name again), plus the fixed 22-byte End Of Central Directory
 * record. Kept here rather than re-derived at the call site so a future
 * change to any header's fixed width (e.g. a real Zip64 extra field) only
 * has ONE place to update to stay in sync with what the writer above
 * actually emits. */
export function computeZipArchiveByteSize(entries: ZipEntrySizePlan[]): number {
  const LOCAL_HEADER_FIXED_BYTES = 30;
  const DATA_DESCRIPTOR_BYTES = 16;
  const CENTRAL_HEADER_FIXED_BYTES = 46;
  const END_OF_CENTRAL_DIRECTORY_BYTES = 22;

  let total = END_OF_CENTRAL_DIRECTORY_BYTES;
  for (const entry of entries) {
    const nameByteLength = new TextEncoder().encode(entry.name).length;
    total +=
      LOCAL_HEADER_FIXED_BYTES +
      nameByteLength +
      entry.size +
      DATA_DESCRIPTOR_BYTES +
      CENTRAL_HEADER_FIXED_BYTES +
      nameByteLength;
  }
  return total;
}

/** The pre-flight refusal this format's Zip64-less ceiling demands (task
 * #29 review follow-up): checks `entries` against BOTH `ZIP32_MAX_*`
 * ceilings before a caller ever calls `buildZipStream` or opens a single R2
 * stream, so a gallery too big for this writer's fixed-width headers gets a
 * clean, immediate refusal instead of a `RangeError` thrown mid-archive
 * after a 200 (and however many prior chunks) have already gone out over
 * the wire — see the block comment above this section for why the throw
 * itself is too late to become a clean HTTP status on its own.
 *
 * `reason` doubles as the caller's own API error code on purpose — same
 * "the validation reason IS the wire error code" shape this codebase's
 * other size gates already use (e.g. `file_too_large` in
 * src/app/api/assets/[assetId]/final/route.ts) — so the route that calls
 * this can hand `reason` straight to its own `errorResponse` helper without
 * a translation layer in between. */
export function checkZip32Limits(
  entries: ZipEntrySizePlan[],
): { ok: true } | { ok: false; reason: "too_many_files" | "archive_too_large" } {
  if (entries.length > ZIP32_MAX_ENTRY_COUNT) {
    return { ok: false, reason: "too_many_files" };
  }
  if (computeZipArchiveByteSize(entries) > ZIP32_MAX_TOTAL_BYTES) {
    return { ok: false, reason: "archive_too_large" };
  }
  return { ok: true };
}

/** One entry to be written into the zip. `openStream` is a FACTORY, not an
 * already-open stream — it is called exactly once, and only when THIS
 * entry's turn in the sequence actually arrives, never ahead of time. That
 * is what keeps this module's own resource use to "one entry's connection at
 * a time" regardless of how many entries the whole archive has: the caller
 * (the download-all route) hands over N *lazy* R2 reads, not N already-open
 * ones. */
export type ZipEntry = {
  /** The name this entry is stored under INSIDE the zip — already sanitized
   * by the caller (ASCII, no path separators, unique within the archive).
   * This module does not sanitize or dedupe; see the route that calls it. */
  name: string;
  openStream: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
};

type CentralDirectoryRecord = {
  nameBytes: Uint8Array;
  crc32: number;
  size: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
};

/** MS-DOS date/time packing — the format every zip header field uses for
 * timestamps (there is no other option; zip predates any richer alternative
 * ever being retrofitted into the base format). Resolution is 2 seconds,
 * years are 1980-2107 — irrelevant precision loss for a "when was this
 * downloaded" field nobody actually reads. */
function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosTime, dosDate };
}

function buildLocalFileHeader(nameBytes: Uint8Array, dosTime: number, dosDate: number): Buffer {
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(GENERAL_PURPOSE_FLAG, 6);
  header.writeUInt16LE(0, 8); // compression method: STORE
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(0, 14); // crc-32 — deferred, see data descriptor
  header.writeUInt32LE(0, 18); // compressed size — deferred
  header.writeUInt32LE(0, 22); // uncompressed size — deferred
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  Buffer.from(nameBytes).copy(header, 30);
  return header;
}

function buildDataDescriptor(crc: number, size: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8); // compressed size === uncompressed size (STORE)
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function buildCentralFileHeader(record: CentralDirectoryRecord): Buffer {
  const header = Buffer.alloc(46 + record.nameBytes.length);
  header.writeUInt32LE(CENTRAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION, 4); // version made by
  header.writeUInt16LE(VERSION, 6); // version needed to extract
  header.writeUInt16LE(GENERAL_PURPOSE_FLAG, 8);
  header.writeUInt16LE(0, 10); // compression method: STORE
  header.writeUInt16LE(record.dosTime, 12);
  header.writeUInt16LE(record.dosDate, 14);
  header.writeUInt32LE(record.crc32, 16);
  header.writeUInt32LE(record.size, 20); // compressed size
  header.writeUInt32LE(record.size, 24); // uncompressed size
  header.writeUInt16LE(record.nameBytes.length, 28);
  header.writeUInt16LE(0, 30); // extra field length
  header.writeUInt16LE(0, 32); // file comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal file attributes
  header.writeUInt32LE(UNIX_REGULAR_FILE_RW_R__R__, 38); // external file attributes
  header.writeUInt32LE(record.localHeaderOffset, 42);
  Buffer.from(record.nameBytes).copy(header, 46);
  return header;
}

function buildEndOfCentralDirectory(recordCount: number, cdSize: number, cdOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // this disk number
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(recordCount, 8); // # records on this disk
  eocd.writeUInt16LE(recordCount, 10); // total # records
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

/** Drains `entry.openStream()` chunk by chunk, yielding each chunk through
 * unchanged while accumulating its running CRC-32 and byte count — the ONLY
 * per-entry state this ever holds beyond the current chunk itself. Nothing
 * here retains a chunk after it has been yielded. */
async function* streamEntryBody(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, { crc32: number; size: number }> {
  let crc = 0;
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      crc = zlibCrc32(value, crc);
      size += value.byteLength;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
  return { crc32: crc, size };
}

/** Builds the byte stream of a zip archive containing every one of `entries`,
 * in order — WITHOUT ever buffering an entry's full bytes, let alone the
 * whole archive. Each entry's `openStream` is invoked exactly once, and only
 * once every PRIOR entry's bytes have already been fully written out — this
 * is what keeps concurrent open connections (to R2, in the caller's actual
 * use) at exactly one, and peak resident memory at "one entry's current
 * chunk plus a handful of tiny per-entry bookkeeping records", regardless of
 * how many entries there are or how large any one of them is. See
 * scripts/measure-zip-memory.ts for the measured shape this produces. */
export async function* buildZipStream(entries: ZipEntry[]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  const centralRecords: CentralDirectoryRecord[] = [];
  const { dosTime, dosDate } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const localHeaderOffset = offset;

    const header = buildLocalFileHeader(nameBytes, dosTime, dosDate);
    yield header;
    offset += header.length;

    const stream = await entry.openStream();
    const drain = streamEntryBody(stream);
    let step = await drain.next();
    while (!step.done) {
      const chunk = step.value;
      yield chunk;
      offset += chunk.byteLength;
      step = await drain.next();
    }
    const { crc32, size } = step.value;

    const descriptor = buildDataDescriptor(crc32, size);
    yield descriptor;
    offset += descriptor.length;

    centralRecords.push({ nameBytes, crc32, size, localHeaderOffset, dosTime, dosDate });
  }

  const centralDirectoryOffset = offset;
  for (const record of centralRecords) {
    const header = buildCentralFileHeader(record);
    yield header;
    offset += header.length;
  }
  const centralDirectorySize = offset - centralDirectoryOffset;

  yield buildEndOfCentralDirectory(
    centralRecords.length,
    centralDirectorySize,
    centralDirectoryOffset,
  );
}

/** Adapts the async generator above into a WHATWG `ReadableStream` — what a
 * Next.js Route Handler actually needs to hand back as a `Response` body.
 * Deliberately NOT `ReadableStream.from(iterable)`: that method exists in
 * Node's web-streams implementation but is NOT implemented in Bun 1.3 (the
 * runtime this app actually deploys under — verified directly, not assumed;
 * `typeof ReadableStream.from === "undefined"` under `bun -e` at the time
 * this was written). A hand-written `pull`-driven wrapper works identically
 * on both. */
export function toReadableStream(source: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await source.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      // The client disconnected (closed the tab, navigated away) before the
      // archive finished — stop pulling further chunks/opening further R2
      // streams rather than continuing to do work nobody will receive.
      await source.return(reason);
    },
  });
}
