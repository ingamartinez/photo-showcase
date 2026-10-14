import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { createRecordingDb } from "@/lib/test/recording-db";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

let current = createRecordingDb();
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => (current.db as Record<string | symbol, unknown>)[prop] }),
}));

import {
  canViewFlashGallery,
  getFirstFlashAsset,
  getFlashGalleriesForClient,
  listFlashAssets,
  resolveFlashGallery,
  resolvePublicFlashGallery,
} from "./flash-access";

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const privateGallery = { id: GALLERY_ID, publicSlug: "s", isPublic: false };
const publicGallery = { ...privateGallery, isPublic: true };
const client = { user: { id: "c-1", role: "client" }, expires: "x" } as Session;
const admin = { user: { id: "a-1", role: "admin" }, expires: "x" } as Session;

beforeEach(() => {
  authMock.mockReset();
  current = createRecordingDb();
});

describe("canViewFlashGallery (pure gate)", () => {
  const none = { isAdmin: false, isAssignedClient: false };
  it("allows a public gallery with no viewer at all", () => {
    expect(canViewFlashGallery({ isPublic: true }, null)).toBe(true);
  });
  it("refuses a private gallery with no viewer", () => {
    expect(canViewFlashGallery({ isPublic: false }, null)).toBe(false);
  });
  it("refuses a private gallery to a signed-in client who is not assigned", () => {
    expect(canViewFlashGallery({ isPublic: false }, none)).toBe(false);
  });
  it("allows a private gallery to an actively assigned client", () => {
    expect(canViewFlashGallery({ isPublic: false }, { ...none, isAssignedClient: true })).toBe(
      true,
    );
  });
  it("allows a private gallery to an admin", () => {
    expect(canViewFlashGallery({ isPublic: false }, { ...none, isAdmin: true })).toBe(true);
  });
});

describe("resolveFlashGallery", () => {
  it("returns null for a slug that does not exist", async () => {
    current = createRecordingDb({ select: [[]] });
    expect(await resolveFlashGallery("nope")).toBeNull();
  });

  it("serves a public gallery without any session lookup", async () => {
    current = createRecordingDb({ select: [[publicGallery]] });
    expect(await resolveFlashGallery("s")).toEqual(publicGallery);
    expect(authMock).not.toHaveBeenCalled();
  });

  it("refuses a private gallery to a visitor with no session", async () => {
    authMock.mockResolvedValue(null);
    current = createRecordingDb({ select: [[privateGallery]] });
    expect(await resolveFlashGallery("s")).toBeNull();
  });

  it("refuses a private gallery to a client who is not assigned", async () => {
    authMock.mockResolvedValue(client);
    current = createRecordingDb({ select: [[privateGallery], []] });
    expect(await resolveFlashGallery("s")).toBeNull();
  });

  it("allows an assigned client, matching on gallery id, user id and removed_at IS NULL", async () => {
    authMock.mockResolvedValue(client);
    current = createRecordingDb({ select: [[privateGallery], [{ userId: "c-1" }]] });
    expect(await resolveFlashGallery("s")).toEqual(privateGallery);
    const viewerQuery = current.ofOp("select")[1]!;
    // A REMOVED client has removed_at set, so this exact filter is what
    // revokes access: the double returns whatever it is scripted with, the SQL
    // is the proof.
    expect(viewerQuery.where!.sql).toContain('"flash_gallery_clients"."removed_at" is null');
    expect(viewerQuery.where!.params).toEqual(expect.arrayContaining([GALLERY_ID, "c-1"]));
  });

  it("allows an admin without an assignment lookup", async () => {
    authMock.mockResolvedValue(admin);
    current = createRecordingDb({ select: [[privateGallery]] });
    expect(await resolveFlashGallery("s")).toEqual(privateGallery);
    expect(current.ofOp("select")).toHaveLength(1);
  });
});

describe("resolvePublicFlashGallery", () => {
  it("refuses a private gallery even to an admin session (previews are public-only)", async () => {
    authMock.mockResolvedValue(admin);
    current = createRecordingDb({ select: [[privateGallery]] });
    expect(await resolvePublicFlashGallery("s")).toBeNull();
  });
  it("returns a public gallery", async () => {
    current = createRecordingDb({ select: [[publicGallery]] });
    expect(await resolvePublicFlashGallery("s")).toEqual(publicGallery);
  });
});

describe("getFlashGalleriesForClient", () => {
  it("scopes to the given user and ACTIVE assignments only (removed_at IS NULL)", async () => {
    const row = { id: GALLERY_ID, title: "t", publicSlug: "s", sessionDate: null };
    current = createRecordingDb({ select: [[row]] });
    expect(await getFlashGalleriesForClient("c-1")).toEqual([row]);
    const query = current.ofOp("select")[0]!;
    expect(query.where!.sql).toContain('"flash_gallery_clients"."removed_at" is null');
    expect(query.where!.sql).toContain('"flash_gallery_clients"."user_id" = $1');
    expect(query.where!.params).toEqual(["c-1"]);
  });
});

describe("photo ordering", () => {
  const expected = [
    '"flash_assets"."sort_order" asc',
    '"flash_assets"."created_at" asc',
    '"flash_assets"."id" asc',
  ];
  it("lists photos by sortOrder, then createdAt, then id", async () => {
    await listFlashAssets(GALLERY_ID);
    expect(current.ofOp("select")[0]!.orderBy).toEqual(expected);
  });
  it("picks the first photo with the same tiebreakers", async () => {
    await getFirstFlashAsset(GALLERY_ID);
    expect(current.ofOp("select")[0]!.orderBy).toEqual(expected);
  });
});
