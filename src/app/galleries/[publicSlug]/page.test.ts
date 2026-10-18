import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import ClientGalleryPage from "./page";
import type { GalleryDetail } from "@/lib/galleries";
import { computeQuota, type GalleryQuotaSnapshot } from "@/lib/quota";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

const getGalleryDetailBySlugMock = vi.fn();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getGalleryDetailBySlug: (...args: unknown[]) => getGalleryDetailBySlugMock(...args),
  };
});

// Real R2 is never touched here — `getPresignedUrl` is a local signature,
// proven for real in src/lib/r2.test.ts.
const getPresignedUrlMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
  // Task #89: the page presigns this key for a delivered gallery's edited
  // assets. Deterministic fake, same treatment as every other key builder in
  // this app's route tests.
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
  // Task #78: identity fake — the page re-attaches the `R2Key` brand to
  // `asset.proofKey` via `storedKey` before calling `getPresignedUrl`.
  storedKey: (key: string) => key,
}));

// Task #94: ownership itself moved to src/lib/gallery-access.ts's
// `isGalleryOwner`, which has its own dedicated, mutation-tested suite
// (gallery-access.test.ts). Mocked here with a realistic default (admin, or
// the session that owns `client-a`'s gallery, is an owner — anyone else
// isn't), so this suite keeps testing exactly its own job: does this PAGE
// call `isGalleryOwner` and honor its result.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
const resolveViewAsMock = vi.fn();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
  // Task #139: a plain re-implementation of the real predicate (admin, full
  // stop) — this module is mocked wholesale, not via `importActual`, same
  // reasoning as `isGalleryOwner` above. The real function's own suite is
  // gallery-access.test.ts; this file's own concern is authorization and the
  // notFound()/forbidden() branches, not this banner's gate.
  isAdminPreviewingClientGallery: (session: Session) => session.user.role === "admin",
  // Epic #250 S6 — own subject, no view-as by default.
  resolveViewAs: (...args: unknown[]) => resolveViewAsMock(...args),
}));

// Task #95: the collaborative tray's first paint. Mocked for the same reason
// `@/lib/gallery-access` is — it reaches Postgres, and it has its own
// dedicated suite (src/lib/gallery-selection.test.ts). What THIS suite cares
// about is that the page reads it only AFTER the ownership and visibility
// gates have passed, which the guard tests below prove by asserting it was
// never called at all on a refused request.
const getGallerySelectionMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@/lib/gallery-selection", () => ({
  getGallerySelection: (...args: unknown[]) => getGallerySelectionMock(...args),
}));

// Epic #239: the per-client lock snapshot, mocked for the same reason —
// proven for real in src/lib/gallery-client-locks.test.ts.
const getSelectionLockSnapshotMock =
  vi.fn<(galleryId: string, viewerId: string) => Promise<unknown>>();
vi.mock("@/lib/gallery-client-locks", () => ({
  getSelectionLockSnapshot: (...args: [string, string]) => getSelectionLockSnapshotMock(...args),
}));

beforeEach(() => {
  authMock.mockReset();
  resolveViewAsMock.mockReset();
  resolveViewAsMock.mockImplementation(async (session: Session) => ({
    ok: true,
    subjectId: session.user.role === "admin" ? null : session.user.id,
  }));
  getSelectionLockSnapshotMock.mockReset();
  getSelectionLockSnapshotMock.mockResolvedValue({
    viewerLock: null,
    lockedPickerIds: [],
    submittedPickerIds: [],
  });
  getGallerySelectionMock.mockReset();
  getGallerySelectionMock.mockResolvedValue(viewFor([]));
  getGalleryDetailBySlugMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-proof-url");
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockImplementation(
    async (_galleryId, session) => session.user.role === "admin" || session.user.id === "client-a",
  );
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client", userId = "client-a"): Session {
  return {
    user: { id: userId, role, email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const SLUG = "abc123def456";

function galleryDetail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: SLUG,
    status: "proofing",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    clients: [{ id: "client-a", name: "Ana Pérez", email: "ana@example.com" }],
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    extraPhotoPriceTiersSnapshot: null,
    originalPhotoPriceCopSnapshot: 2_000,
    termsOverridden: false,
    selectionTrayMode: "flat",
    allowsOriginalSelection: false,
    rollingDelivery: false,
    assets: [],
    selectionSubmittedAt: null,
    ...overrides,
  };
}

function paramsFor(publicSlug: string) {
  return { params: Promise.resolve({ publicSlug }) };
}

type LegacyPick = {
  assetId: string;
  selectedAt?: string | null;
  pickedBy: { id: string; label: string } | null;
  selectionKind?: "edited" | "original";
};

const DEFAULT_TERMS = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

/** Adapts the pre-S6 fixture shape (a flat list of claimed picks) to the S6
 * wire shape, computing the server's quota/counter exactly as
 * `buildGallerySelection` would for these fixtures. */
function viewFor(
  picks: LegacyPick[],
  terms: GalleryQuotaSnapshot = DEFAULT_TERMS,
  lock: {
    viewerLock: {
      lockedAt: string;
      submittedAt: string | null;
      lockedBy?: "client" | "admin";
    } | null;
    adminLockedPickerIds: string[];
    viewerSubmittedAt: string | null;
  } = { viewerLock: null, adminLockedPickerIds: [], viewerSubmittedAt: null },
) {
  const entries = picks.map((pick) => ({
    assetId: pick.assetId,
    claim: {
      claimedAt: pick.selectedAt ?? null,
      resolvedKind: pick.selectionKind ?? ("edited" as const),
      billedTo: pick.pickedBy,
      charge: "included" as const,
    },
    picks: pick.pickedBy
      ? [
          {
            userId: pick.pickedBy.id,
            label: pick.pickedBy.label,
            kind: pick.selectionKind ?? ("edited" as const),
            pickedAt: pick.selectedAt ?? "2026-07-30T12:00:00.000Z",
            submittedAt: pick.selectedAt ?? null,
            state: "billed" as const,
          },
        ]
      : [],
  }));
  const edited = picks.filter((pick) => (pick.selectionKind ?? "edited") === "edited").length;
  const original = picks.length - edited;
  const quota = computeQuota(edited, original, terms);
  const counts = new Map<string, number>();
  for (const pick of picks) {
    if (!pick.pickedBy) continue;
    counts.set(pick.pickedBy.id, (counts.get(pick.pickedBy.id) ?? 0) + 1);
  }
  return {
    entries,
    quota,
    counter: {
      group: picks.length,
      viewer: { yours: counts.get("client-a") ?? 0, shared: 0, toSend: 0 },
      people: [...counts].map(([userId, units]) => ({ userId, label: userId, units })),
      unattributed: picks.filter((pick) => pick.pickedBy === null).length,
    },
    lock,
  };
}

describe("ClientGalleryPage", () => {
  it("resolves for the owning client with an existing, proofing gallery", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    expect(getGalleryDetailBySlugMock).toHaveBeenCalledWith(SLUG);
  });

  it("resolves for an admin session regardless of who the gallery's clients are", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({ clients: [{ id: "someone-else", name: null, email: "x@example.com" }] }),
    );

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(getGalleryDetailBySlugMock).not.toHaveBeenCalled();
  });

  it("404s when no gallery matches the slug", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(null);

    await expect(ClientGalleryPage(paramsFor("does-not-exist"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  // The task's headline security acceptance criterion, restated for the
  // slug-keyed route: another client's slug in the URL yields 403 — an
  // unguessable slug only stops enumeration, it is not authorization by
  // itself (src/lib/galleries.ts's own comment on getGalleryDetailBySlug).
  it("403s a signed-in client who does not own this gallery, even though they have its slug", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-b"));
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({ clients: [{ id: "client-a", name: "Ana Pérez", email: "ana@example.com" }] }),
    );

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  // Task #94's core acceptance criterion — "a SECOND client attached to the
  // same gallery is just as much an owner as the first" — is proven for
  // REAL against the actual `gallery_clients` query in
  // src/lib/gallery-access.test.ts ("allows a SECOND client attached to the
  // same gallery, not just the first"). This page never reads
  // `gallery.clients` itself (see page.tsx: ownership is decided entirely by
  // `isGalleryOwner(gallery.id, session)`), so a test here that stubs
  // `isGalleryOwnerMock` to unconditionally resolve `true` cannot exercise
  // that acceptance criterion no matter what the `clients` fixture contains
  // — it would pass identically with `client-b` removed from the array
  // entirely. What this test CAN prove, and does, is the review's own
  // finding: that the page calls `isGalleryOwner` with the gallery's OWN id,
  // never anything the caller supplied — the same shortcut
  // src/lib/asset-access.ts's header comment warns never to take.
  it("resolves when isGalleryOwner approves, calling it with the gallery's OWN id and the acting session", async () => {
    const session = sessionFor("client", "client-b");
    authMock.mockResolvedValue(session);
    isGalleryOwnerMock.mockResolvedValue(true);
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ id: "g1" }));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    expect(isGalleryOwnerMock).toHaveBeenCalledWith("g1", session);
  });

  // A draft gallery is still being assembled — must never be visible to a
  // client, even the one who legitimately owns it.
  it("404s a draft gallery for its own owning client", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status: "draft" }));

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  // Admins bypass the draft gate — they need to be able to preview a
  // gallery before publishing it.
  it("lets an admin view a draft gallery", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status: "draft" }));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
  });

  it.each(["proofing", "selected", "delivered"] as const)(
    "renders a %s gallery for its owning client",
    async (status) => {
      authMock.mockResolvedValue(sessionFor("client", "client-a"));
      getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status }));

      await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    },
  );

  // Epic #239 / S6 — the lock and the counter now come from the ONE
  // `getGallerySelection` read, and are handed to <ProofGrid> untouched.
  it("reads the selection once for this gallery and subject and hands its lock and counter to <ProofGrid>", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    const lock = {
      viewerLock: {
        lockedAt: "2026-10-15T10:00:00.000Z",
        submittedAt: "2026-10-15T10:00:00.000Z",
        lockedBy: "client" as const,
      },
      adminLockedPickerIds: ["client-a"],
      viewerSubmittedAt: "2026-10-15T10:00:00.000Z",
    };
    getGallerySelectionMock.mockResolvedValue(viewFor([], DEFAULT_TERMS, lock));

    const tree = await ClientGalleryPage(paramsFor(SLUG));

    expect(getGallerySelectionMock).toHaveBeenCalledWith("g1", DEFAULT_TERMS, "client-a");
    const found: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props && "initialAdminLockedPickerIds" in props) found.push(props);
      if (props) walk(props.children);
    };
    walk(tree);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      initialViewerLock: lock.viewerLock,
      initialAdminLockedPickerIds: lock.adminLockedPickerIds,
      initialViewerSubmittedAt: lock.viewerSubmittedAt,
    });
  });

  it("forbids a CLIENT that sends a view-as parameter", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    resolveViewAsMock.mockResolvedValue({ ok: false, error: "view_as_admin_only" });

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  it("views as an active member for an admin: subject id reaches the read, viewerId and the remount key", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    resolveViewAsMock.mockResolvedValue({ ok: true, subjectId: "client-b" });

    const tree = await ClientGalleryPage({
      ...paramsFor(SLUG),
      searchParams: Promise.resolve({ viewAs: "client-b" }),
    });

    expect(resolveViewAsMock).toHaveBeenCalledWith(expect.anything(), "g1", "client-b");
    expect(getGallerySelectionMock).toHaveBeenCalledWith("g1", expect.any(Object), "client-b");
    const found: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props && "viewAsId" in props) found.push(props);
      if (props) walk(props.children);
    };
    walk(tree);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ viewerId: "client-b", viewAsId: "client-b" });
  });

  it("404s an admin view-as for a removed / unknown member", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    resolveViewAsMock.mockResolvedValue({ ok: false, error: "view_as_not_member" });

    await expect(
      ClientGalleryPage({
        ...paramsFor(SLUG),
        searchParams: Promise.resolve({ viewAs: "gone" }),
      }),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("presigns a proof URL for every asset in the gallery", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({
        assets: [
          {
            id: "a1",
            originalFilename: "IMG_0001.JPG",
            proofKey: "galleries/g1/proofs/a1.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: false,
            sortOrder: 0,
            finalKey: null,
            isEdited: false,
            selectionKind: "edited",
            isExtra: false,
            deliveredFor: null,
          },
          {
            id: "a2",
            originalFilename: "IMG_0002.JPG",
            proofKey: "galleries/g1/proofs/a2.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: false,
            sortOrder: 1,
            finalKey: null,
            isEdited: false,
            selectionKind: "edited",
            isExtra: false,
            deliveredFor: null,
          },
        ],
      }),
    );

    await ClientGalleryPage(paramsFor(SLUG));

    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a1.webp");
    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a2.webp");
  });
});
