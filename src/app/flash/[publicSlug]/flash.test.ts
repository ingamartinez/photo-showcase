// Gate + behavior tests for the flash link page and its four binary routes.
// The same access function backs all of them, so the gate matrix runs once per
// route (display, final, zip) and og-image/page have their own public-only cases.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { createRecordingDb } from "@/lib/test/recording-db";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

let current = createRecordingDb();
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (current.db as Record<string | symbol, unknown>)[prop] }),
}));

const getObjectStreamMock = vi.fn();
const getObjectSizeMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string, options?: { contentDisposition?: string }) =>
    `https://r2.example.com/${key}?cd=${encodeURIComponent(options?.contentDisposition ?? "")}`,
  storedKey: (key: string) => key,
  flashDisplayKey: (g: string, a: string) => `flash/${g}/display/${a}.webp`,
  getObjectStream: (...args: unknown[]) => getObjectStreamMock(...args),
  getObjectSize: (...args: unknown[]) => getObjectSizeMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ID = "33333333-3333-4333-8333-333333333333";

const gallery = (isPublic: boolean) => ({
  id: GALLERY_ID,
  title: "Cumple de Sofi",
  publicSlug: "slug",
  isPublic,
  sessionDate: null,
});
const asset = (id = ASSET_ID) => ({
  id,
  flashGalleryId: GALLERY_ID,
  originalFilename: "DSC_0001.JPG",
  finalKey: `flash/${GALLERY_ID}/finals/${id}.jpg`,
  displayWidth: 1600,
  displayHeight: 1067,
  sortOrder: 0,
});

const sessionOf = (role: "admin" | "client") =>
  ({ user: { id: "u-1", role }, expires: "x" }) as Session;

const request = () => new NextRequest("http://localhost:3300/flash/slug/x");
const ctx = { params: Promise.resolve({ publicSlug: "slug", assetId: ASSET_ID }) };

type Handler = (r: NextRequest, c: typeof ctx) => Promise<Response>;
const routes: { name: string; load: () => Promise<Handler>; tail: unknown[][] }[] = [
  {
    name: "display",
    load: async () => (await import("./display/[assetId]/route")).GET as Handler,
    tail: [[asset()]],
  },
  {
    name: "final",
    load: async () => (await import("./final/[assetId]/route")).GET as Handler,
    tail: [[asset()]],
  },
  {
    name: "zip",
    load: async () => (await import("./zip/route")).GET as unknown as Handler,
    tail: [[asset()]],
  },
];

beforeEach(() => {
  authMock.mockReset();
  getObjectStreamMock.mockReset();
  getObjectStreamMock.mockImplementation(() => new ReadableStream());
  getObjectSizeMock.mockReset();
  getObjectSizeMock.mockResolvedValue(10);
  current = createRecordingDb();
});

describe.each(routes)("shared access gate — $name route", ({ load, tail }) => {
  const run = async (selects: unknown[][]) => {
    current = createRecordingDb({ select: selects });
    return (await load())(request(), ctx);
  };

  it("public gallery, no session: OK", async () => {
    const res = await run([[gallery(true)], ...tail]);
    expect(res.status).toBeLessThan(400);
  });

  it("private gallery, no session: 404", async () => {
    authMock.mockResolvedValue(null);
    expect((await run([[gallery(false)], ...tail])).status).toBe(404);
  });

  it("private gallery, client not assigned: 404", async () => {
    authMock.mockResolvedValue(sessionOf("client"));
    expect((await run([[gallery(false)], [], ...tail])).status).toBe(404);
  });

  it("private gallery, assigned client: OK", async () => {
    authMock.mockResolvedValue(sessionOf("client"));
    const res = await run([[gallery(false)], [{ userId: "u-1" }], ...tail]);
    expect(res.status).toBeLessThan(400);
  });

  it("private gallery, REMOVED client: 404, because the assignment lookup filters removed_at", async () => {
    authMock.mockResolvedValue(sessionOf("client"));
    // A removed client matches no row once the removed_at IS NULL filter applies.
    const res = await run([[gallery(false)], [], ...tail]);
    expect(res.status).toBe(404);
    expect(current.ofOp("select")[1]!.where!.sql).toContain("removed_at");
  });

  it("private gallery, admin: OK", async () => {
    authMock.mockResolvedValue(sessionOf("admin"));
    const res = await run([[gallery(false)], ...tail]);
    expect(res.status).toBeLessThan(400);
  });

  it("missing gallery and private gallery are the same bodiless 404", async () => {
    authMock.mockResolvedValue(null);
    const missing = await run([[]]);
    const hidden = await run([[gallery(false)], ...tail]);
    expect(missing.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(await missing.text()).toBe(await hidden.text());
  });
});

describe("display / final routes", () => {
  it("display redirects to the presigned derivative key, never caching it", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset()]] });
    const { GET } = await import("./display/[assetId]/route");
    const res = await GET(request(), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`flash/${GALLERY_ID}/display/${ASSET_ID}.webp`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("final redirects with an attachment disposition named for the photo", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset()]] });
    const { GET } = await import("./final/[assetId]/route");
    const res = await GET(request(), ctx);
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain(`finals/${ASSET_ID}.jpg`);
    expect(decodeURIComponent(location)).toContain('attachment; filename="dsc-0001.jpg"');
  });

  it("an asset id that is not a uuid is a 404 without touching the db", async () => {
    const { GET } = await import("./final/[assetId]/route");
    const res = await GET(request(), {
      params: Promise.resolve({ publicSlug: "slug", assetId: "nope" }),
    });
    expect(res.status).toBe(404);
    expect(current.calls).toHaveLength(0);
  });

  it("an asset that belongs to another gallery is a 404 (lookup is scoped by gallery id)", async () => {
    current = createRecordingDb({ select: [[gallery(true)], []] });
    const { GET } = await import("./final/[assetId]/route");
    const res = await GET(request(), ctx);
    expect(res.status).toBe(404);
    expect(current.ofOp("select")[1]!.where!.params).toEqual(
      expect.arrayContaining([GALLERY_ID, ASSET_ID]),
    );
  });
});

describe("zip route", () => {
  it("streams an attachment named for the gallery with every photo, in order", async () => {
    current = createRecordingDb({
      select: [[gallery(true)], [asset(), asset(SECOND_ID)]],
    });
    const { GET } = await import("./zip/route");
    const res = await GET(request(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="cumple-de-sofi-fotos.zip"',
    );
    expect(getObjectSizeMock).toHaveBeenCalledTimes(2);
    expect(current.ofOp("select")[1]!.orderBy).toEqual([
      '"flash_assets"."sort_order" asc',
      '"flash_assets"."created_at" asc',
      '"flash_assets"."id" asc',
    ]);
  });

  it("refuses with 502 when a stored final is missing, before any byte is streamed", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset()]] });
    getObjectSizeMock.mockRejectedValue(new Error("gone"));
    const { GET } = await import("./zip/route");
    const res = await GET(request(), ctx);
    expect(res.status).toBe(502);
    expect(getObjectStreamMock).not.toHaveBeenCalled();
  });
});

describe("og-image route", () => {
  const ogCtx = { params: Promise.resolve({ publicSlug: "slug" }) };
  const load = async () => (await import("./og-image/route")).GET;

  it("serves the FIRST photo's display derivative from the stable route", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset()]] });
    const res = await (await load())(request(), ogCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(getObjectStreamMock).toHaveBeenCalledWith(
      `flash/${GALLERY_ID}/display/${ASSET_ID}.webp`,
    );
    // "First" is decided in SQL by sortOrder, createdAt, id (ties are real).
    expect(current.ofOp("select")[1]!.orderBy).toEqual([
      '"flash_assets"."sort_order" asc',
      '"flash_assets"."created_at" asc',
      '"flash_assets"."id" asc',
    ]);
  });

  it("serves whichever photo the ordering puts first (reordering changes the image)", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset(SECOND_ID)]] });
    await (
      await load()
    )(request(), ogCtx);
    expect(getObjectStreamMock).toHaveBeenCalledWith(
      `flash/${GALLERY_ID}/display/${SECOND_ID}.webp`,
    );
  });

  it("404s for a private gallery, even to a signed-in admin, and never opens R2", async () => {
    authMock.mockResolvedValue(sessionOf("admin"));
    current = createRecordingDb({ select: [[gallery(false)], [asset()]] });
    expect((await (await load())(request(), ogCtx)).status).toBe(404);
    expect(getObjectStreamMock).not.toHaveBeenCalled();
  });

  it("404s for a public gallery with no photos", async () => {
    current = createRecordingDb({ select: [[gallery(true)], []] });
    expect((await (await load())(request(), ogCtx)).status).toBe(404);
  });
});

describe("page", () => {
  const pageParams = { params: Promise.resolve({ publicSlug: "slug" }) };

  it("generateMetadata shares title and image for a public gallery", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset()]] });
    const { generateMetadata } = await import("./page");
    const meta = await generateMetadata(pageParams);
    expect(meta.openGraph).toMatchObject({
      title: "Cumple de Sofi",
      images: [{ url: "/flash/slug/og-image", width: 1600, height: 1067 }],
    });
  });

  it("generateMetadata for a private gallery leaks nothing and skips the photo query", async () => {
    current = createRecordingDb({ select: [[gallery(false)], [asset()]] });
    const { generateMetadata } = await import("./page");
    const meta = await generateMetadata(pageParams);
    expect(meta).toEqual({ robots: { index: false, follow: false } });
    expect(current.ofOp("select")).toHaveLength(1);
  });

  it("notFound() for a private gallery with no session", async () => {
    authMock.mockResolvedValue(null);
    current = createRecordingDb({ select: [[gallery(false)]] });
    const { default: Page } = await import("./page");
    await expect(Page(pageParams)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("renders the grid with display + download links and a zip button for a public gallery", async () => {
    current = createRecordingDb({ select: [[gallery(true)], [asset()]] });
    const { default: Page } = await import("./page");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await Page(pageParams));
    expect(html).toContain(`/flash/slug/display/${ASSET_ID}`);
    expect(html).toContain(`/flash/slug/final/${ASSET_ID}`);
    expect(html).toContain("/flash/slug/zip");
    expect(html).toContain("Cumple de Sofi");
  });
});
