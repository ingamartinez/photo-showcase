import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { flashAssets } from "@/lib/db/schema";
import { createRecordingDb } from "@/lib/test/recording-db";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// The finals route exports the shared size cap; mocked so this suite does not
// drag the whole finals route (and its mail/R2 imports) in. The value mirrors
// the real one — the over-cap test below goes through the content-length gate.
vi.mock("@/app/api/assets/[assetId]/final/route", () => ({
  MAX_FINAL_UPLOAD_BYTES: 80 * 1024 * 1024,
}));

const putObjectMock = vi.fn();
const deleteObjectMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  putObject: (...args: unknown[]) => putObjectMock(...args),
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
  flashFinalKey: (flashId: string, assetId: string, ext: string) =>
    `flash/${flashId}/finals/${assetId}.${ext}`,
  flashDisplayKey: (flashId: string, assetId: string) => `flash/${flashId}/display/${assetId}.webp`,
}));

const processDisplayMock = vi.fn();
vi.mock("@/lib/images", () => ({
  processDisplay: (...args: unknown[]) => processDisplayMock(...args),
}));

let current = createRecordingDb();
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (current.db as Record<string | symbol, unknown>)[prop] }),
}));

const FLASH_ID = "11111111-1111-4111-8111-111111111111";
const DISPLAY_BYTES = Buffer.from("display-webp");

const admin = {
  user: { id: "admin-1", role: "admin", email: "a@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;
const client = {
  user: { id: "c-1", role: "client", email: "c@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;

function post(file: File | undefined, headers: Record<string, string> = {}) {
  const body = new FormData();
  if (file) body.set("file", file);
  return new NextRequest(`http://localhost:3300/api/flash/${FLASH_ID}/assets`, {
    method: "POST",
    body,
    headers,
  });
}
const params = (id = FLASH_ID) => ({ params: Promise.resolve({ flashId: id }) });
const jpeg = (bytes: Uint8Array = new Uint8Array([1, 2, 3, 4, 5, 6])) =>
  new File([bytes as BlobPart], "DSC_0001.JPG", { type: "image/jpeg" });

beforeEach(() => {
  authMock.mockReset();
  putObjectMock.mockReset();
  putObjectMock.mockResolvedValue(undefined);
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  processDisplayMock.mockReset();
  processDisplayMock.mockResolvedValue({ data: DISPLAY_BYTES, width: 1600, height: 1067 });
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  authMock.mockResolvedValue(admin);
  // Default script: the flash gallery exists, no photos yet.
  current = createRecordingDb({ select: [[{ id: FLASH_ID }], [{ value: null }]] });
});

describe("POST /api/flash/[flashId]/assets", () => {
  it("stores the upload BYTE-FOR-BYTE plus a webp derivative, then records the row", async () => {
    const { POST } = await import("./route");
    const original = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);

    const response = await POST(post(jpeg(original)), params());

    expect(response.status).toBe(201);
    const body = (await response.json()) as { asset: { id: string; finalKey: string } };
    const assetId = body.asset.id;

    const finalCall = putObjectMock.mock.calls.find(
      (c) => c[0] === `flash/${FLASH_ID}/finals/${assetId}.jpg`,
    )!;
    expect(finalCall).toBeDefined();
    // Byte-for-byte: the stored body is exactly what was uploaded.
    expect(new Uint8Array(finalCall[1] as ArrayBuffer)).toEqual(original);
    expect(finalCall[2]).toEqual({ contentType: "image/jpeg" });

    const displayCall = putObjectMock.mock.calls.find(
      (c) => c[0] === `flash/${FLASH_ID}/display/${assetId}.webp`,
    )!;
    expect(displayCall[1]).toBe(DISPLAY_BYTES);
    expect(displayCall[2]).toEqual({ contentType: "image/webp" });

    // The derivative is fed the SAME raw upload, never a pre-filtered copy.
    expect(new Uint8Array(processDisplayMock.mock.calls[0]![0] as ArrayBuffer)).toEqual(original);

    const [insert] = current.ofOp("insert");
    expect(insert!.table).toBe(flashAssets);
    expect(insert!.values).toEqual({
      id: assetId,
      flashGalleryId: FLASH_ID,
      originalFilename: "DSC_0001.JPG",
      finalKey: `flash/${FLASH_ID}/finals/${assetId}.jpg`,
      displayWidth: 1600,
      displayHeight: 1067,
      sortOrder: 0,
    });
  });

  it("keeps a PNG as a .png final", async () => {
    const { POST } = await import("./route");
    const png = new File([new Uint8Array([1, 2])], "edit.png", { type: "image/png" });
    const response = await POST(post(png), params());
    expect(response.status).toBe(201);
    const { asset } = (await response.json()) as { asset: { finalKey: string } };
    expect(asset.finalKey.endsWith(".png")).toBe(true);
    expect(putObjectMock.mock.calls[0]![2]).toEqual({ contentType: "image/png" });
  });

  it("appends after the current highest sortOrder", async () => {
    current = createRecordingDb({ select: [[{ id: FLASH_ID }], [{ value: 6 }]] });
    const { POST } = await import("./route");
    await POST(post(jpeg()), params());
    expect((current.ofOp("insert")[0]!.values as { sortOrder: number }).sortOrder).toBe(7);
  });

  it("refuses a CLIENT with 403 before any db read or r2 write", async () => {
    authMock.mockResolvedValue(client);
    const { POST } = await import("./route");
    await expect(POST(post(jpeg()), params())).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    expect(current.calls).toHaveLength(0);
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("answers 401 JSON with no session", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");
    const response = await POST(post(jpeg()), params());
    expect(response.status).toBe(401);
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("404s an unknown flash gallery and 400s a malformed id", async () => {
    const { POST } = await import("./route");
    current = createRecordingDb({ select: [[]] });
    expect((await POST(post(jpeg()), params())).status).toBe(404);
    current = createRecordingDb();
    expect((await POST(post(jpeg()), params("nope"))).status).toBe(400);
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("rejects non-image types (415), a missing file (400) and an over-cap upload (413)", async () => {
    const { POST } = await import("./route");
    const gif = new File(["x"], "a.gif", { type: "image/gif" });
    expect((await POST(post(gif), params())).status).toBe(415);
    current = createRecordingDb({ select: [[{ id: FLASH_ID }]] });
    expect((await POST(post(undefined), params())).status).toBe(400);
    current = createRecordingDb({ select: [[{ id: FLASH_ID }]] });
    const tooBig = await POST(
      post(jpeg(), { "content-length": String(81 * 1024 * 1024) }),
      params(),
    );
    expect(tooBig.status).toBe(413);
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(current.ofOp("insert")).toHaveLength(0);
  });

  it("422s an undecodable image without touching r2 or the db", async () => {
    processDisplayMock.mockRejectedValue(new Error("corrupt"));
    const { POST } = await import("./route");
    expect((await POST(post(jpeg()), params())).status).toBe(422);
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(current.ofOp("insert")).toHaveLength(0);
  });

  it("502s and cleans up when an r2 write fails, recording no row", async () => {
    putObjectMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("r2"));
    const { POST } = await import("./route");
    expect((await POST(post(jpeg()), params())).status).toBe(502);
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
    expect(current.ofOp("insert")).toHaveLength(0);
  });

  it("deletes the freshly written objects if the row insert fails", async () => {
    const { POST } = await import("./route");
    const failing = createRecordingDb({ select: [[{ id: FLASH_ID }], [{ value: null }]] });
    const realInsert = failing.db.insert;
    failing.db.insert = (table: unknown) => {
      const chain = realInsert(table) as Record<string, unknown>;
      chain.then = (_resolve: unknown, reject: (e: unknown) => unknown) =>
        Promise.reject(new Error("db down")).catch(reject);
      return chain;
    };
    current = failing;

    expect((await POST(post(jpeg()), params())).status).toBe(500);
    const written = putObjectMock.mock.calls.map((c) => c[0]).sort();
    expect(deleteObjectMock.mock.calls.map((c) => c[0]).sort()).toEqual(written);
  });
});
