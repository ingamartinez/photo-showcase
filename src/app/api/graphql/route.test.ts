import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/graphql/context.ts,
// builder.ts, and every types/*.ts module) only resolves inside a real
// Next.js bundle — same mock every route suite in this codebase uses (see
// src/lib/auth-guards.test.ts).
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Ownership itself has its own dedicated, mutation-tested suite
// (gallery-access.test.ts). Mocked here for the SAME reason
// submit-selection/route.test.ts mocks it: this suite's job is proving the
// GraphQL layer calls it and honors the result — the epic's central risk
// (task #6) is a second, WEAKER copy of this check growing up next to the
// REST one, and the only way to prove there ISN'T one is to show every
// refusal here traces back to this exact function's answer.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

// Same reasoning for src/lib/galleries.ts's own read helpers — each has its
// own suite (galleries.test.ts); this suite only proves the resolvers call
// them and shape the response off what they return.
const getGalleryDetailMock = vi.fn();
const getGalleriesForClientMock = vi.fn();
const isGalleryVisibleToClientMock = vi.fn();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetail: (...args: [string]) => getGalleryDetailMock(...args),
  getGalleriesForClient: (...args: [string]) => getGalleriesForClientMock(...args),
  isGalleryVisibleToClient: (...args: [string]) => isGalleryVisibleToClientMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";

function clientASession(): Session {
  return {
    user: { id: "client-a", role: "client", email: "a@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientBSession(): Session {
  return {
    user: { id: "client-b", role: "client", email: "b@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function galleryDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: GALLERY_ID,
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "proofing",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    clients: [{ id: "client-a", name: "Ana Ruiz", email: "a@example.com" }],
    package: { id: 1, name: "Boda" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [
      {
        id: "asset-1",
        originalFilename: "IMG_0001.jpg",
        proofKey: "proofs/asset-1.webp",
        proofWidth: 1200,
        proofHeight: 800,
        isSelected: false,
        sortOrder: 0,
        finalKey: null,
        isEdited: false,
      },
    ],
    selectionSubmittedAt: null,
    ...overrides,
  };
}

function graphqlRequest(query: string, variables?: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3300/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

type GraphQLResponseBody = {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
};

async function bodyOf(response: Response): Promise<GraphQLResponseBody> {
  return (await response.json()) as GraphQLResponseBody;
}

beforeEach(() => {
  authMock.mockReset();
  isGalleryOwnerMock.mockReset();
  getGalleryDetailMock.mockReset();
  getGalleriesForClientMock.mockReset();
  isGalleryVisibleToClientMock.mockReset();
  isGalleryVisibleToClientMock.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/graphql — the `gallery` field's auth gate", () => {
  it("returns null, not an error, for an unauthenticated caller — no private data leaks", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ gallery(id: "${GALLERY_ID}") { id title } }`));

    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ gallery: null });
    // The session check happens before ANY ownership lookup — an
    // unauthenticated caller never even reaches `isGalleryOwner`.
    expect(isGalleryOwnerMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in client who does not own the gallery, and never fetches its detail", async () => {
    // THE acceptance criterion this task exists to prove: a client with a
    // perfectly valid session and another client's gallery id gets nothing.
    // MUTATION-PROVEN: deleting the `if (!(await isGalleryOwner(...)))
    // return null;` guard in src/lib/graphql/types/query.ts makes this
    // assertion fail with `data.gallery` populated instead of `null` — see
    // this task's own report for the observed RED output.
    authMock.mockResolvedValue(clientBSession());
    isGalleryOwnerMock.mockResolvedValue(false);
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ gallery(id: "${GALLERY_ID}") { id title } }`));

    const body = await bodyOf(response);
    expect(body.data).toEqual({ gallery: null });
    expect(isGalleryOwnerMock).toHaveBeenCalledWith(
      GALLERY_ID,
      expect.objectContaining({
        user: expect.objectContaining({ id: "client-b" }),
      }),
    );
    // Fails closed BEFORE spending a query on the gallery's own detail.
    expect(getGalleryDetailMock).not.toHaveBeenCalled();
  });

  it("serves the gallery to a client who owns it", async () => {
    authMock.mockResolvedValue(clientASession());
    isGalleryOwnerMock.mockResolvedValue(true);
    getGalleryDetailMock.mockResolvedValue(galleryDetail());
    const { POST } = await import("./route");

    const response = await POST(
      graphqlRequest(
        `{ gallery(id: "${GALLERY_ID}") { id title status publicSlug clients { name email } package { name } assets { id proofKey } includedPhotosSnapshot extraPhotoPriceCopSnapshot } }`,
      ),
    );

    const body = await bodyOf(response);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      gallery: {
        id: GALLERY_ID,
        title: "Boda Ana y Beto",
        status: "proofing",
        publicSlug: "abc123",
        clients: [{ name: "Ana Ruiz", email: "a@example.com" }],
        package: { name: "Boda" },
        assets: [{ id: "asset-1", proofKey: "proofs/asset-1.webp" }],
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
      },
    });
  });

  it("hides a DRAFT gallery from its own client, same visibility gate the REST page uses", async () => {
    authMock.mockResolvedValue(clientASession());
    isGalleryOwnerMock.mockResolvedValue(true);
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "draft" }));
    isGalleryVisibleToClientMock.mockReturnValue(false);
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ gallery(id: "${GALLERY_ID}") { id } }`));

    const body = await bodyOf(response);
    expect(body.data).toEqual({ gallery: null });
    expect(isGalleryVisibleToClientMock).toHaveBeenCalledWith("draft");
  });

  it("lets an admin read a DRAFT gallery, bypassing the client-only visibility gate entirely", async () => {
    authMock.mockResolvedValue(adminSession());
    isGalleryOwnerMock.mockResolvedValue(true);
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "draft" }));
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ gallery(id: "${GALLERY_ID}") { id status } }`));

    const body = await bodyOf(response);
    expect(body.data).toEqual({ gallery: { id: GALLERY_ID, status: "draft" } });
    // Admin never even calls the client-only gate — same short-circuit the
    // selection route's own two-gate comment documents.
    expect(isGalleryVisibleToClientMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed gallery id before touching the database at all", async () => {
    authMock.mockResolvedValue(clientASession());
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ gallery(id: "not-a-uuid") { id } }`));

    const body = await bodyOf(response);
    expect(body.data).toEqual({ gallery: null });
    expect(isGalleryOwnerMock).not.toHaveBeenCalled();
    expect(getGalleryDetailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/graphql — the `galleries` field", () => {
  it("returns an empty list, not an error, for an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ galleries { id } }`));

    const body = await bodyOf(response);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ galleries: [] });
    expect(getGalleriesForClientMock).not.toHaveBeenCalled();
  });

  it("lists only the signed-in client's own galleries, resolved to full detail", async () => {
    authMock.mockResolvedValue(clientASession());
    getGalleriesForClientMock.mockResolvedValue([{ id: GALLERY_ID }, { id: OTHER_GALLERY_ID }]);
    getGalleryDetailMock.mockImplementation(async (id: string) =>
      galleryDetail({ id, title: id === GALLERY_ID ? "Boda Ana y Beto" : "Quince de Sofía" }),
    );
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ galleries { id title } }`));

    const body = await bodyOf(response);
    expect(getGalleriesForClientMock).toHaveBeenCalledWith("client-a");
    expect(body.data).toEqual({
      galleries: [
        { id: GALLERY_ID, title: "Boda Ana y Beto" },
        { id: OTHER_GALLERY_ID, title: "Quince de Sofía" },
      ],
    });
  });

  it("drops a gallery id that no longer resolves to a detail row, rather than erroring", async () => {
    authMock.mockResolvedValue(clientASession());
    getGalleriesForClientMock.mockResolvedValue([{ id: GALLERY_ID }, { id: OTHER_GALLERY_ID }]);
    getGalleryDetailMock.mockImplementation(async (id: string) =>
      id === GALLERY_ID ? galleryDetail() : null,
    );
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ galleries { id } }`));

    const body = await bodyOf(response);
    expect(body.data).toEqual({ galleries: [{ id: GALLERY_ID }] });
  });
});

describe("POST /api/graphql — introspection (task #30's third acceptance criterion)", () => {
  it("is disabled in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ __schema { queryType { name } } }`));

    const body = await bodyOf(response);
    expect(body.errors?.[0]?.message).toMatch(/introspection has been disabled/i);
    expect(body.data).toBeUndefined();
  });

  it("stays enabled outside production", async () => {
    authMock.mockResolvedValue(null);
    const { POST } = await import("./route");

    const response = await POST(graphqlRequest(`{ __schema { queryType { name } } }`));

    const body = await bodyOf(response);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ __schema: { queryType: { name: "Query" } } });
  });
});
