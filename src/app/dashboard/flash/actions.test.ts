import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { flashAssets, flashGalleries, flashGalleryClients } from "@/lib/db/schema";
import { createRecordingDb } from "@/lib/test/recording-db";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const deleteObjectMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
  storedKey: (key: string) => key,
  flashDisplayKey: (galleryId: string, assetId: string) =>
    `flash/${galleryId}/display/${assetId}.webp`,
}));

// `vi.mock` is hoisted, so the scripted db lives on a holder the factory reads.
let current = createRecordingDb();
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (current.db as Record<string | symbol, unknown>)[prop] }),
}));

const FLASH_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";

const admin = {
  user: { id: "admin-1", role: "admin", email: "a@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;
const client = {
  user: { id: "client-x", role: "client", email: "c@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;

function form(fields: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
}

beforeEach(() => {
  authMock.mockReset();
  revalidatePathMock.mockReset();
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
  current = createRecordingDb();
});

describe("every flash action is admin-only and writes nothing otherwise", () => {
  const cases: [string, (a: typeof import("./actions")) => Promise<unknown>][] = [
    [
      "createFlashGallery",
      (a) => a.createFlashGallery({ status: "idle" }, form({ title: "Regalo" })),
    ],
    ["setFlashGalleryPublic", (a) => a.setFlashGalleryPublic(FLASH_ID, true)],
    [
      "attachFlashClients",
      (a) =>
        a.attachFlashClients(
          { status: "idle" },
          form({ flashGalleryId: FLASH_ID, clientIds: ["client-a"] }),
        ),
    ],
    ["removeFlashClient", (a) => a.removeFlashClient(FLASH_ID, "client-a")],
    [
      "updateFlashGalleryMeta",
      (a) =>
        a.updateFlashGalleryMeta(
          { status: "idle" },
          form({ flashGalleryId: FLASH_ID, title: "x" }),
        ),
    ],
    ["deleteFlashAsset", (a) => a.deleteFlashAsset(ASSET_ID)],
    ["deleteFlashGallery", (a) => a.deleteFlashGallery(FLASH_ID)],
  ];

  it.each(cases)("%s refuses a signed-in CLIENT with a 403", async (_name, call) => {
    authMock.mockResolvedValue(client);
    const actions = await import("./actions");
    await expect(call(actions)).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
    expect(current.calls).toHaveLength(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it.each(cases)("%s redirects to /login with no session", async (_name, call) => {
    authMock.mockResolvedValue(null);
    const actions = await import("./actions");
    await expect(call(actions)).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(current.calls).toHaveLength(0);
  });
});

describe("createFlashGallery", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("inserts a PRIVATE gallery with an unguessable slug and no commercial fields", async () => {
    current = createRecordingDb({ insert: [[{ id: FLASH_ID }]] });
    const { createFlashGallery } = await import("./actions");

    const result = await createFlashGallery(
      { status: "idle" },
      form({ title: "  Regalo de boda ", sessionDate: "" }),
    );

    expect(result).toEqual({ status: "created", flashGalleryId: FLASH_ID });
    const [insert] = current.ofOp("insert");
    expect(insert!.table).toBe(flashGalleries);
    const values = insert!.values as Record<string, unknown>;
    expect(values.title).toBe("Regalo de boda");
    expect(values.sessionDate).toBeNull();
    // isPublic is never set by creation: the column default (false) applies.
    expect(values).not.toHaveProperty("isPublic");
    expect(String(values.publicSlug)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("gives two galleries different slugs", async () => {
    current = createRecordingDb({ insert: [[{ id: FLASH_ID }], [{ id: FLASH_ID }]] });
    const { createFlashGallery } = await import("./actions");
    await createFlashGallery({ status: "idle" }, form({ title: "A" }));
    await createFlashGallery({ status: "idle" }, form({ title: "B" }));
    const [first, second] = current.ofOp("insert");
    expect((first!.values as { publicSlug: string }).publicSlug).not.toBe(
      (second!.values as { publicSlug: string }).publicSlug,
    );
  });

  it("rejects a blank title and a malformed date without inserting", async () => {
    const { createFlashGallery } = await import("./actions");
    expect(await createFlashGallery({ status: "idle" }, form({ title: "   " }))).toMatchObject({
      status: "error",
    });
    expect(
      await createFlashGallery({ status: "idle" }, form({ title: "x", sessionDate: "mañana" })),
    ).toMatchObject({ status: "error" });
    expect(current.ofOp("insert")).toHaveLength(0);
  });

  it("rejects a calendar-impossible date instead of letting Postgres fail it", async () => {
    const { createFlashGallery } = await import("./actions");
    expect(
      await createFlashGallery({ status: "idle" }, form({ title: "x", sessionDate: "2026-02-31" })),
    ).toEqual({ status: "error", message: "La fecha no es válida." });
    expect(current.ofOp("insert")).toHaveLength(0);
  });
});

describe("setFlashGalleryPublic", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it.each([true, false])("writes isPublic=%s scoped to that one gallery", async (value) => {
    current = createRecordingDb({ update: [[{ id: FLASH_ID }]] });
    const { setFlashGalleryPublic } = await import("./actions");

    expect(await setFlashGalleryPublic(FLASH_ID, value)).toEqual({ ok: true });

    const [update] = current.ofOp("update");
    expect(update!.table).toBe(flashGalleries);
    expect(update!.set).toEqual({ isPublic: value });
    expect(update!.where!.sql).toContain('"flash_galleries"."id" = $1');
    expect(update!.where!.params).toEqual([FLASH_ID]);
  });

  it("reports a gallery that does not exist and rejects a non-uuid id before the db", async () => {
    current = createRecordingDb({ update: [[]] });
    const { setFlashGalleryPublic } = await import("./actions");
    expect(await setFlashGalleryPublic(FLASH_ID, true)).toMatchObject({ ok: false });
    current = createRecordingDb();
    expect(await setFlashGalleryPublic("not-a-uuid", true)).toMatchObject({ ok: false });
    expect(current.calls).toHaveLength(0);
  });
});

describe("updateFlashGalleryMeta", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("writes only title and date, scoped to one row, and revalidates all four readers", async () => {
    current = createRecordingDb({ update: [[{ id: FLASH_ID, publicSlug: "slug-abc" }]] });
    const { updateFlashGalleryMeta } = await import("./actions");

    const result = await updateFlashGalleryMeta(
      { status: "idle" },
      form({ flashGalleryId: FLASH_ID, title: "  Nuevo título ", sessionDate: "2026-10-18" }),
    );

    expect(result).toEqual({ status: "updated" });
    const [update] = current.ofOp("update");
    expect(update!.table).toBe(flashGalleries);
    // Exactly these two keys: `publicSlug` and `isPublic` must never enter the SET.
    expect(update!.set).toEqual({ title: "Nuevo título", sessionDate: "2026-10-18" });
    expect(update!.where!.sql).toContain('"flash_galleries"."id" = $1');
    expect(update!.where!.params).toEqual([FLASH_ID]);
    // `/flash/<slug>` comes from RETURNING, never from the posted form.
    expect(revalidatePathMock.mock.calls.map(([path]) => path)).toEqual([
      `/dashboard/flash/${FLASH_ID}`,
      "/dashboard/flash",
      "/flash/slug-abc",
      "/galleries",
    ]);
  });

  it("clears the date with an explicit null, never a dropped undefined", async () => {
    current = createRecordingDb({ update: [[{ id: FLASH_ID, publicSlug: "slug-abc" }]] });
    const { updateFlashGalleryMeta } = await import("./actions");

    await updateFlashGalleryMeta(
      { status: "idle" },
      form({ flashGalleryId: FLASH_ID, title: "Con fecha", sessionDate: "" }),
    );

    const [update] = current.ofOp("update");
    // `toEqual` with a present `null` key: an `undefined` date would be silently
    // dropped by drizzle's `.set()`, i.e. a success that clears nothing.
    expect(update!.set).toEqual({ title: "Con fecha", sessionDate: null });
  });

  const invalidCases: [string, Record<string, string>, string][] = [
    ["a blank title", { title: "   " }, "Escribe un título."],
    ["a title over 200 characters", { title: "x".repeat(201) }, "El título es muy largo."],
    ["a malformed date", { title: "x", sessionDate: "mañana" }, "La fecha no es válida."],
  ];

  it.each(invalidCases)(
    "rejects %s without writing or revalidating",
    async (_name, fields, message) => {
      const { updateFlashGalleryMeta } = await import("./actions");

      expect(
        await updateFlashGalleryMeta(
          { status: "idle" },
          form({ flashGalleryId: FLASH_ID, ...fields }),
        ),
      ).toEqual({ status: "error", message });
      expect(current.calls).toHaveLength(0);
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a title of exactly 200 characters", async () => {
    current = createRecordingDb({ update: [[{ id: FLASH_ID, publicSlug: "slug-abc" }]] });
    const { updateFlashGalleryMeta } = await import("./actions");
    const title = "x".repeat(200);

    expect(
      await updateFlashGalleryMeta({ status: "idle" }, form({ flashGalleryId: FLASH_ID, title })),
    ).toEqual({ status: "updated" });
    expect((current.ofOp("update")[0]!.set as { title: string }).title).toBe(title);
  });

  it("reports a gallery that does not exist and rejects a non-uuid id before the db", async () => {
    current = createRecordingDb({ update: [[]] });
    const { updateFlashGalleryMeta } = await import("./actions");

    expect(
      await updateFlashGalleryMeta(
        { status: "idle" },
        form({ flashGalleryId: FLASH_ID, title: "x" }),
      ),
    ).toEqual({ status: "error", message: "La galería no existe." });
    expect(revalidatePathMock).not.toHaveBeenCalled();

    current = createRecordingDb();
    expect(
      await updateFlashGalleryMeta(
        { status: "idle" },
        form({ flashGalleryId: "not-a-uuid", title: "x" }),
      ),
    ).toEqual({ status: "error", message: "Galería no válida." });
    expect(current.calls).toHaveLength(0);
  });
});

describe("attachFlashClients", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("inserts never-attached clients and re-attaches removed ones by clearing removedAt", async () => {
    current = createRecordingDb({
      select: [
        [{ id: FLASH_ID }], // gallery exists
        [{ id: "new-1" }, { id: "gone-1" }, { id: "active-1" }], // all real clients
        [
          { userId: "gone-1", removedAt: new Date("2026-01-01") },
          { userId: "active-1", removedAt: null },
        ],
      ],
    });
    const { attachFlashClients } = await import("./actions");

    const result = await attachFlashClients(
      { status: "idle" },
      form({ flashGalleryId: FLASH_ID, clientIds: ["new-1", "gone-1", "active-1", "new-1"] }),
    );

    expect(result.status).toBe("attached");
    const [insert] = current.ofOp("insert");
    expect(insert!.table).toBe(flashGalleryClients);
    expect(insert!.values).toEqual([{ flashGalleryId: FLASH_ID, userId: "new-1" }]);
    const [update] = current.ofOp("update");
    expect(update!.table).toBe(flashGalleryClients);
    expect(update!.set).toEqual({ removedAt: null });
    // Only the REMOVED client is touched, not the still-active one.
    expect(update!.where!.params).toEqual([FLASH_ID, "gone-1"]);
  });

  it("refuses ids that are not client accounts, writing nothing", async () => {
    current = createRecordingDb({ select: [[{ id: FLASH_ID }], [{ id: "client-a" }]] });
    const { attachFlashClients } = await import("./actions");

    const result = await attachFlashClients(
      { status: "idle" },
      form({ flashGalleryId: FLASH_ID, clientIds: ["client-a", "an-admin"] }),
    );

    expect(result).toEqual({ status: "error", message: "Elige clientes válidos." });
    expect(current.ofOp("insert")).toHaveLength(0);
    expect(current.ofOp("update")).toHaveLength(0);
  });

  it("restricts the lookup to role=client in SQL", async () => {
    current = createRecordingDb({ select: [[{ id: FLASH_ID }], []] });
    const { attachFlashClients } = await import("./actions");
    await attachFlashClients(
      { status: "idle" },
      form({ flashGalleryId: FLASH_ID, clientIds: ["x"] }),
    );
    const userLookup = current.ofOp("select")[1]!;
    expect(userLookup.where!.sql).toContain('"users"."role" = $');
    expect(userLookup.where!.params).toContain("client");
  });

  it("requires at least one client", async () => {
    const { attachFlashClients } = await import("./actions");
    const result = await attachFlashClients({ status: "idle" }, form({ flashGalleryId: FLASH_ID }));
    expect(result).toMatchObject({ status: "error", message: "Elige al menos un cliente." });
  });
});

describe("removeFlashClient", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("soft-removes ONE membership: stamps removedAt, never deletes", async () => {
    const { removeFlashClient } = await import("./actions");

    expect(await removeFlashClient(FLASH_ID, "client-a")).toEqual({ ok: true });

    expect(current.ofOp("delete")).toHaveLength(0);
    const [update] = current.ofOp("update");
    expect(update!.table).toBe(flashGalleryClients);
    expect((update!.set as { removedAt: unknown }).removedAt).toBeInstanceOf(Date);
    expect(update!.where!.sql).toContain('"flash_gallery_clients"."flash_gallery_id" = $1');
    expect(update!.where!.sql).toContain('"flash_gallery_clients"."user_id" = $2');
    expect(update!.where!.params).toEqual([FLASH_ID, "client-a"]);
  });
});

describe("deleteFlashAsset", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("deletes the row first, then BOTH r2 objects", async () => {
    current = createRecordingDb({
      select: [[{ id: ASSET_ID, flashGalleryId: FLASH_ID, finalKey: "flash/f/finals/a.png" }]],
    });
    const order: string[] = [];
    const realDelete = current.db.delete;
    current.db.delete = (table: unknown) => {
      order.push("db");
      return realDelete(table);
    };
    deleteObjectMock.mockImplementation(async (key: string) => {
      order.push(key);
    });
    const { deleteFlashAsset } = await import("./actions");

    expect(await deleteFlashAsset(ASSET_ID)).toEqual({ ok: true });

    const [del] = current.ofOp("delete");
    expect(del!.table).toBe(flashAssets);
    expect(del!.where!.params).toEqual([ASSET_ID]);
    expect(order).toEqual([
      "db",
      "flash/f/finals/a.png",
      `flash/${FLASH_ID}/display/${ASSET_ID}.webp`,
    ]);
  });

  it("still succeeds when an r2 delete fails (orphan costs storage, not correctness)", async () => {
    current = createRecordingDb({
      select: [[{ id: ASSET_ID, flashGalleryId: FLASH_ID, finalKey: "k" }]],
    });
    deleteObjectMock.mockRejectedValue(new Error("r2 down"));
    const { deleteFlashAsset } = await import("./actions");
    expect(await deleteFlashAsset(ASSET_ID)).toEqual({ ok: true });
  });

  it("deletes nothing for a photo that does not exist", async () => {
    current = createRecordingDb({ select: [[]] });
    const { deleteFlashAsset } = await import("./actions");
    expect(await deleteFlashAsset(ASSET_ID)).toMatchObject({ ok: false });
    expect(current.ofOp("delete")).toHaveLength(0);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("deleteFlashGallery", () => {
  beforeEach(() => authMock.mockResolvedValue(admin));

  it("deletes the gallery row and every photo's final and display object", async () => {
    current = createRecordingDb({
      select: [
        [
          { id: "p1", finalKey: "flash/f/finals/p1.jpg" },
          { id: "p2", finalKey: "flash/f/finals/p2.png" },
        ],
      ],
      delete: [[{ id: FLASH_ID }]],
    });
    const { deleteFlashGallery } = await import("./actions");

    expect(await deleteFlashGallery(FLASH_ID)).toEqual({ ok: true });

    const [del] = current.ofOp("delete");
    expect(del!.table).toBe(flashGalleries);
    expect(del!.where!.params).toEqual([FLASH_ID]);
    expect(deleteObjectMock.mock.calls.map((c) => c[0]).sort()).toEqual(
      [
        "flash/f/finals/p1.jpg",
        "flash/f/finals/p2.png",
        `flash/${FLASH_ID}/display/p1.webp`,
        `flash/${FLASH_ID}/display/p2.webp`,
      ].sort(),
    );
  });

  it("removes no objects when the gallery row did not exist", async () => {
    current = createRecordingDb({ select: [[{ id: "p1", finalKey: "k" }]], delete: [[]] });
    const { deleteFlashGallery } = await import("./actions");
    expect(await deleteFlashGallery(FLASH_ID)).toMatchObject({ ok: false });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});
