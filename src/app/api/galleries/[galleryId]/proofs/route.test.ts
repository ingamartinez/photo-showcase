import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { eqColumnAndValue } from "@/lib/test/eq-column-and-value";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// This route's own wiring is what's under test here, not sharp's pipeline
// (proven for real in src/lib/images.test.ts) or R2 (proven for real in
// src/lib/r2.test.ts, which also has to mock the "bun" module specifier —
// mocking the whole @/lib/r2 boundary here means that never has to happen
// in this file at all). Same boundary-mocking philosophy as
// src/app/api/auth/[...nextauth]/route.test.ts.
const processProofMock = vi.fn();
vi.mock("@/lib/images", () => ({
  processProof: (...args: unknown[]) => processProofMock(...args),
}));

const putObjectMock = vi.fn();
const deleteObjectMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  // A deterministic fake, not src/lib/r2.ts's real key format — that real
  // format is environment-namespaced (task #38: `dev/` prefix unless
  // `APP_ENV=production`) and this suite doesn't stub `APP_ENV`. What matters
  // here is only that this route's own failure-cleanup logic reuses the SAME
  // key it uploaded to when it calls deleteObject(), so the fake must be
  // deterministic per (galleryId, assetId), not merely return a fixed string.
  proofKey: (galleryId: string, assetId: string) => `galleries/${galleryId}/proofs/${assetId}.webp`,
  putObject: (...args: unknown[]) => putObjectMock(...args),
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
}));

// A minimal, genuinely-behaving double for `@/lib/db` — real filtering by
// the column/value encoded in `eq()`, real accumulation of inserted rows,
// same duck-typing approach as src/app/dashboard/galleries/actions.test.ts
// (drizzle-orm 0.45 gives no other stable way to introspect a query builder
// chain outside of a real database).
//
// Task #53: `eqColumnAndValue` now lives at src/lib/test/eq-column-and-value.ts
// and is shared with src/app/dashboard/galleries/actions.test.ts, which used
// to carry its own (buggy) local copy — see that module's header comment for
// why this is the one test double in the repo that's shared rather than
// duplicated per file.
type Row = Record<string, unknown>;

vi.mock("@/lib/db", async () => {
  const { galleries, assets } = await import("@/lib/db/schema");

  const galleryRows: Row[] = [];
  const assetRows: Row[] = [];

  return {
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            // `eqColumnAndValue` itself throws (rather than returning an
            // unresolved column) when `condition` isn't a genuine `eq()` or
            // its column can't be mapped back to a JS key — no local guard
            // needed here.
            const { column, value } = eqColumnAndValue(condition);

            if (table === galleries) {
              const rows = galleryRows.filter((r) => r[column] === value);
              return { limit: async (n: number) => rows.slice(0, n) };
            }
            if (table === assets) {
              const rows = assetRows.filter((r) => r[column] === value);
              // `db.select({ value: count() })` vs. a plain row select —
              // distinguished the same way the real shapes differ: only the
              // aggregate call passes a columns object with a "value" key.
              if (columns && "value" in columns) {
                return Promise.resolve([{ value: rows.length }]);
              }
              return Promise.resolve(rows);
            }
            throw new Error("fake db: unsupported table in select().where()");
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: async (row: Row) => {
          if (table !== assets) throw new Error("fake db: unsupported table in insert()");
          assetRows.push({ ...row });
          return [row];
        },
      }),
      // Test-only escape hatch, not part of the real `db` shape.
      __rows: { galleries: galleryRows, assets: assetRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleries: Row[]; assets: Row[] } };
  };
  return db;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientSession(): Session {
  return {
    user: { id: "client-1", role: "client", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function galleryRow(overrides: Partial<Row> = {}): Row {
  return {
    id: GALLERY_ID,
    clientId: "client-1",
    packageId: 1,
    title: "Boda Ana y Beto",
    sessionDate: "2026-08-01",
    status: "draft",
    publicSlug: "abc123",
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function requestFor(galleryId: string, body?: FormData): NextRequest {
  return new NextRequest(`http://localhost:3300/api/galleries/${galleryId}/proofs`, {
    method: "POST",
    body,
  });
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

function formDataWith(file: File | undefined): FormData {
  const data = new FormData();
  if (file) data.set("file", file);
  return data;
}

function imageFile(bytes: BlobPart = "fake-original-bytes", name = "photo.jpg"): File {
  return new File([bytes], name, { type: "image/jpeg" });
}

beforeEach(async () => {
  authMock.mockReset();
  processProofMock.mockReset();
  putObjectMock.mockReset();
  deleteObjectMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");

  processProofMock.mockResolvedValue({
    data: Buffer.from("fake-webp-bytes"),
    width: 800,
    height: 600,
  });
  putObjectMock.mockResolvedValue(undefined);
  deleteObjectMock.mockResolvedValue(undefined);

  const db = await seededDb();
  db.__rows.galleries.length = 0;
  db.__rows.assets.length = 0;
  db.__rows.galleries.push(galleryRow());
});

describe("POST /api/galleries/[galleryId]/proofs — authorization", () => {
  it("returns 401, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(processProofMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in CLIENT with a 403, without processing or storing anything", async () => {
    authMock.mockResolvedValue(clientSession());
    const { POST } = await import("./route");

    await expect(
      POST(requestFor(GALLERY_ID, formDataWith(imageFile())), paramsFor(GALLERY_ID)),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });

    expect(processProofMock).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/galleries/[galleryId]/proofs — gallery validation", () => {
  it("rejects a malformed gallery id with 400, before ever querying the database", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(
      requestFor("not-a-uuid", formDataWith(imageFile())),
      paramsFor("not-a-uuid"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_gallery_id" });
    expect(processProofMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the gallery does not exist", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "gallery_not_found" });
    expect(processProofMock).not.toHaveBeenCalled();
  });

  it.each(["selected", "delivered", "archived"])(
    "returns 409 when the gallery status is %s (proofs are only accepted in draft/proofing)",
    async (status) => {
      authMock.mockResolvedValue(adminSession());
      const db = await seededDb();
      db.__rows.galleries.length = 0;
      db.__rows.galleries.push(galleryRow({ status }));
      const { POST } = await import("./route");

      const response = await POST(
        requestFor(GALLERY_ID, formDataWith(imageFile())),
        paramsFor(GALLERY_ID),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "gallery_not_accepting_proofs" });
      expect(processProofMock).not.toHaveBeenCalled();
    },
  );

  it.each(["draft", "proofing"])("accepts an upload while the gallery is %s", async (status) => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.galleries.length = 0;
    db.__rows.galleries.push(galleryRow({ status }));
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(201);
  });
});

describe("POST /api/galleries/[galleryId]/proofs — upload validation, rejected before processing", () => {
  it("returns 400 when the multipart body has no file field", async () => {
    authMock.mockResolvedValue(adminSession());
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(undefined)),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "missing_file" });
    expect(processProofMock).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-image content type, without calling processProof", async () => {
    authMock.mockResolvedValue(adminSession());
    const file = new File(["%PDF-1.4 not an image"], "export.pdf", { type: "application/pdf" });
    const { POST } = await import("./route");

    const response = await POST(requestFor(GALLERY_ID, formDataWith(file)), paramsFor(GALLERY_ID));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "not_an_image" });
    expect(processProofMock).not.toHaveBeenCalled();
  });

  it("returns 413 for a file larger than the configured cap, without calling processProof", async () => {
    authMock.mockResolvedValue(adminSession());
    const { MAX_UPLOAD_BYTES, POST } = await import("./route");
    const oversized = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "huge.jpg", {
      type: "image/jpeg",
    });

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(oversized)),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "file_too_large" });
    expect(processProofMock).not.toHaveBeenCalled();
  });
});

describe("parseContentLength", () => {
  it("returns null when the header is absent", async () => {
    const { parseContentLength } = await import("./route");
    expect(parseContentLength(null)).toBeNull();
  });

  it("parses a valid numeric header", async () => {
    const { parseContentLength } = await import("./route");
    expect(parseContentLength("1048576")).toBe(1_048_576);
  });

  it("returns null for a non-numeric header instead of throwing", async () => {
    const { parseContentLength } = await import("./route");
    expect(parseContentLength("not-a-number")).toBeNull();
  });

  it("returns null for a negative header value", async () => {
    const { parseContentLength } = await import("./route");
    expect(parseContentLength("-5")).toBeNull();
  });
});

describe("POST /api/galleries/[galleryId]/proofs — Content-Length gate runs before the body is read", () => {
  it("rejects with 413 off the header alone, never calling request.formData()", async () => {
    authMock.mockResolvedValue(adminSession());
    const { MAX_UPLOAD_BYTES, POST } = await import("./route");

    const formDataSpy = vi.fn();
    const fakeRequest = {
      headers: new Headers({ "content-length": String(MAX_UPLOAD_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as NextRequest;

    const response = await POST(fakeRequest, paramsFor(GALLERY_ID));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "file_too_large" });
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/galleries/[galleryId]/proofs — processing and storage failures", () => {
  it("returns 422 when processProof rejects, and never calls putObject", async () => {
    authMock.mockResolvedValue(adminSession());
    processProofMock.mockRejectedValue(new Error("not a real image"));
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "processing_failed" });
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the R2 upload fails, and leaves no assets row behind", async () => {
    authMock.mockResolvedValue(adminSession());
    putObjectMock.mockRejectedValue(new Error("R2 unreachable"));
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "upload_failed" });
    // The order this route chose (R2 write before insert) means a failed
    // upload can never leave an orphan assets row — nothing to clean up on
    // this side, by construction.
    expect(db.__rows.assets).toHaveLength(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("returns 500 and best-effort deletes the just-uploaded R2 object when the insert fails", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const { POST } = await import("./route");

    // Force the fake db's insert to fail by targeting a gallery id that
    // collides with nothing — instead, simplest reliable trigger: make the
    // fake db throw by inserting into a gallery whose id doesn't match the
    // table's expectations. Easiest genuine trigger available with this
    // fake: temporarily replace insert with a throwing implementation.
    const realInsert = db.__rows.assets.push;
    db.__rows.assets.push = () => {
      throw new Error("simulated insert failure");
    };

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    db.__rows.assets.push = realInsert;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "insert_failed" });
    expect(putObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    const uploadedKey = putObjectMock.mock.calls[0]?.[0];
    expect(deleteObjectMock).toHaveBeenCalledWith(uploadedKey);
    expect(db.__rows.assets).toHaveLength(0);
  });

  it("still returns 500 (not a thrown error) when the compensating delete itself fails", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    const realInsert = db.__rows.assets.push;
    db.__rows.assets.push = () => {
      throw new Error("simulated insert failure");
    };
    deleteObjectMock.mockRejectedValue(new Error("R2 unreachable for cleanup too"));
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );

    db.__rows.assets.push = realInsert;

    // This is the documented leak: the R2 object is now orphaned (upload
    // succeeded, insert failed, cleanup failed too) — but the handler itself
    // must still answer cleanly, not throw an unhandled rejection.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "insert_failed" });
  });
});

describe("POST /api/galleries/[galleryId]/proofs — happy path", () => {
  it("uploads the proof, inserts the assets row, and returns 201 with the asset's details", async () => {
    authMock.mockResolvedValue(adminSession());
    processProofMock.mockResolvedValue({
      data: Buffer.from("fake-webp-bytes"),
      width: 1600,
      height: 1067,
    });
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile("bytes", "IMG_0001.JPG"))),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      asset: {
        id: string;
        proofKey: string;
        width: number;
        height: number;
        sortOrder: number;
        originalFilename: string;
      };
    };
    expect(body.asset.proofKey).toBe(`galleries/${GALLERY_ID}/proofs/${body.asset.id}.webp`);
    expect(body.asset.width).toBe(1600);
    expect(body.asset.height).toBe(1067);
    expect(body.asset.sortOrder).toBe(0);
    expect(body.asset.originalFilename).toBe("IMG_0001.JPG");

    expect(putObjectMock).toHaveBeenCalledWith(
      body.asset.proofKey,
      Buffer.from("fake-webp-bytes"),
      { contentType: "image/webp" },
    );

    expect(db.__rows.assets).toHaveLength(1);
    expect(db.__rows.assets[0]).toMatchObject({
      id: body.asset.id,
      galleryId: GALLERY_ID,
      proofKey: body.asset.proofKey,
      proofWidth: 1600,
      proofHeight: 1067,
      originalFilename: "IMG_0001.JPG",
      sortOrder: 0,
    });

    // The original bytes handed to processProof are never referenced again —
    // nothing stored, nothing in the response body, per PLAN.md's "originals
    // are never stored" rule. This asserts the observable half of that: the
    // response and the persisted row carry only the PROCESSED proof's data.
    expect(JSON.stringify(body)).not.toContain("bytes");
  });

  // Task #100's own acceptance criterion, stated rather than inferred: a
  // gallery created BEFORE its client record exists must still take proofs —
  // that is the entire point of allowing a clientless draft (set the session
  // up, get the files off the card, decide who it belongs to later).
  //
  // Structurally this route cannot behave otherwise: it gates on
  // PROOF_ACCEPTING_STATUSES alone and never reads `gallery_clients` at all.
  // The fake `db` above has no such table and its `select().from()` throws on
  // any table it does not know, so a future change that started consulting
  // membership here would fail this test loudly instead of quietly locking
  // the photographer out of their own draft.
  it("accepts an upload into a DRAFT gallery with NO clients attached (task #100)", async () => {
    authMock.mockResolvedValue(adminSession());
    processProofMock.mockResolvedValue({
      data: Buffer.from("fake-webp-bytes"),
      width: 1600,
      height: 1067,
    });
    const db = await seededDb();
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile("bytes", "IMG_0001.JPG"))),
      paramsFor(GALLERY_ID),
    );

    expect(response.status).toBe(201);
    expect(db.__rows.assets).toHaveLength(1);
  });

  it("appends new uploads after existing assets instead of overwriting sort_order", async () => {
    authMock.mockResolvedValue(adminSession());
    const db = await seededDb();
    db.__rows.assets.push({ id: crypto.randomUUID(), galleryId: GALLERY_ID, sortOrder: 0 });
    db.__rows.assets.push({ id: crypto.randomUUID(), galleryId: GALLERY_ID, sortOrder: 1 });
    const { POST } = await import("./route");

    const response = await POST(
      requestFor(GALLERY_ID, formDataWith(imageFile())),
      paramsFor(GALLERY_ID),
    );
    const body = (await response.json()) as { asset: { sortOrder: number } };

    expect(response.status).toBe(201);
    expect(body.asset.sortOrder).toBe(2);
  });
});
