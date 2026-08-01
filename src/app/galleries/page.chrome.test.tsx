// @vitest-environment jsdom
//
// Same reasoning as src/app/galleries/[publicSlug]/page.chrome.test.tsx for
// `@/lib/auth-guards`: it is mocked wholesale so this file can hand the page
// a session object directly, without a real Auth.js round trip.
//
// `@/lib/galleries`, unlike `@/lib/auth-guards`, is mocked only PARTIALLY —
// `vi.importActual` pulls in the REAL `formatGalleryIndexHeading`/
// `formatGalleryIndexLede`/`formatClientGalleryCardState`/`formatSessionDate`,
// and only `getGalleriesForClient` (the DB-touching read) is replaced. This
// is deliberate, not an oversight: task #143's own acceptance criterion is
// that the display heading names the SESSION's signed-in client and degrades
// well when it doesn't have one, and a test that reimplemented
// `formatGalleryIndexHeading`'s copy here (the way this file used to
// reimplement `formatGalleryStatus`, before this task) would only prove the
// fake agrees with itself — it would stay green even if the real function's
// null-name branch regressed to `undefined, acá está...`. Running the REAL
// function is what makes this a pin rather than a tautology; see
// galleries.test.ts for the corresponding unit tests on each function in
// isolation.
//
// page.test.ts (node environment) proves the session guard is real and that
// the query is scoped to the session's own user id; this file is the other
// half — the only place that proves each gallery's title/state/session
// date/photo count are actually wired into markup, that the client's own
// name reaches the display heading, and that the empty state renders when
// the client has no galleries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Session } from "next-auth";
import ClientGalleriesPage from "./page";
import type { ClientGalleryListItem } from "@/lib/galleries";

const requireSessionMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireSession: () => requireSessionMock() }));

const getGalleriesForClientMock = vi.fn<() => Promise<ClientGalleryListItem[]>>();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getGalleriesForClient: () => getGalleriesForClientMock(),
  };
});

// Task #180: `@/lib/r2` is server-only (it constructs an `S3Client` lazily
// off `r2Env()`, see r2.ts's own header) — mocked wholesale here, same
// reasoning and same deterministic-fake shape as
// src/app/galleries/[publicSlug]/page.chrome.test.tsx's own mock of this
// module. Real presigning is proven in src/lib/r2.test.ts; this file's own
// job is whether the PAGE calls it for a gallery's cover key and renders the
// result.
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string) => `https://r2.example.com/${key}?presigned=1`,
  storedKey: (key: string) => key,
}));

/** A minimal `ClientGalleryListItem`, `coverProofKey: null` by default (the
 * ordinary, no-cover-picked-yet state, task #180's own framing) — every
 * fixture in this file that does not care about the cover starts here so a
 * future required field does not have to be hand-added to every literal in
 * this file one by one. */
function galleryListItem(overrides: Partial<ClientGalleryListItem> = {}): ClientGalleryListItem {
  return {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "proofing",
    sessionDate: "2026-08-01",
    photoCount: 24,
    coverProofKey: null,
    ...overrides,
  };
}

function sessionWithName(name: string | null | undefined): Session {
  return {
    user: { id: "client-a", role: "client", email: "ana@example.com", name },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

beforeEach(() => {
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue(sessionWithName("Ana"));
  getGalleriesForClientMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ClientGalleriesPage chrome", () => {
  it("renders each gallery's title, client-language state, session date and photo count, linked by publicSlug", async () => {
    getGalleriesForClientMock.mockResolvedValue([galleryListItem()]);

    const element = await ClientGalleriesPage();
    render(element);

    const listItem = screen.getByText("Boda Ana y Beto").closest("li")!;
    // "Te toca elegir" (client language), never "En pruebas" (the studio's
    // own workflow word, `formatGalleryStatus` — a deliberately different
    // function, see src/lib/galleries.ts's comment on
    // `formatClientGalleryCardState`).
    expect(within(listItem).getByText("Te toca elegir")).toBeDefined();
    expect(within(listItem).getByText(/01\/08\/2026/)).toBeDefined();
    expect(within(listItem).getByText(/24 fotos/)).toBeDefined();
    expect(within(listItem).getByRole("link")).toHaveProperty(
      "href",
      expect.stringContaining("/galleries/abc123"),
    );

    expect(screen.queryByText("Todavía no tenés ninguna galería.")).toBeNull();
  });

  it("distinguishes a gallery waiting on the studio from one ready to download", async () => {
    getGalleriesForClientMock.mockResolvedValue([
      galleryListItem({
        id: "g1",
        title: "Sesión de compromiso",
        publicSlug: "s1",
        status: "selected",
        sessionDate: "2026-03-14",
        photoCount: 13,
      }),
      galleryListItem({
        id: "g2",
        title: "Retrato — invierno",
        publicSlug: "s2",
        status: "delivered",
        sessionDate: "2024-07-02",
        photoCount: 20,
      }),
    ]);

    const element = await ClientGalleriesPage();
    render(element);

    // Different words, not just different colours — a screen reader (or a
    // colour-blind client) must be able to tell them apart from the text
    // alone.
    expect(screen.getByText("Alejo está editando")).toBeDefined();
    expect(screen.getByText("Lista para descargar")).toBeDefined();
  });

  it("names the signed-in client in the display heading (client.html:597-600)", async () => {
    requireSessionMock.mockResolvedValue(sessionWithName("Ana"));
    getGalleriesForClientMock.mockResolvedValue([galleryListItem()]);

    const element = await ClientGalleriesPage();
    const { container } = render(element);

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("Ana, acá está");
    expect(heading?.textContent).toContain("todo tu trabajocon el estudio.");
  });

  // The added acceptance criterion this task shipped alongside (2026-07-31):
  // a hand-created client row may have no name at all. This MUST degrade to
  // a dignified sentence, never a literal "undefined"/"null" spliced into
  // the heading — see src/lib/galleries.ts's own comment on
  // `formatGalleryIndexHeading` for the reasoning.
  it("degrades to a name-less heading, never `undefined`, when session.user.name is null", async () => {
    requireSessionMock.mockResolvedValue(sessionWithName(null));
    getGalleriesForClientMock.mockResolvedValue([galleryListItem()]);

    const element = await ClientGalleriesPage();
    const { container } = render(element);

    const heading = container.querySelector("h1");
    expect(heading?.textContent).not.toMatch(/undefined|null/i);
    expect(heading?.textContent).toContain("Acá está");
  });

  it("also degrades the empty-state heading when the client has no name", async () => {
    requireSessionMock.mockResolvedValue(sessionWithName(undefined));
    getGalleriesForClientMock.mockResolvedValue([]);

    const element = await ClientGalleriesPage();
    render(element);

    expect(screen.getByText("Todavía no tenés ninguna galería.")).toBeDefined();
    expect(screen.queryByText(/undefined|null/i)).toBeNull();
  });

  it("renders one row per gallery, in the order the query returned them", async () => {
    const galleries: ClientGalleryListItem[] = [
      galleryListItem({
        id: "g1",
        title: "Sesión de verano",
        publicSlug: "s1",
        status: "delivered",
        sessionDate: "2026-06-01",
        photoCount: 30,
      }),
      galleryListItem({
        id: "g2",
        title: "Cumpleaños",
        publicSlug: "s2",
        status: "proofing",
        sessionDate: "2026-07-01",
        photoCount: 15,
      }),
    ];
    getGalleriesForClientMock.mockResolvedValue(galleries);

    const element = await ClientGalleriesPage();
    const { container } = render(element);

    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Sesión de verano")).toBeDefined();
    expect(within(items[1] as HTMLElement).getByText("Cumpleaños")).toBeDefined();
  });

  it("renders the empty state when the client has no galleries yet", async () => {
    requireSessionMock.mockResolvedValue(sessionWithName(null));
    getGalleriesForClientMock.mockResolvedValue([]);

    const element = await ClientGalleriesPage();
    render(element);

    expect(screen.getByText("Todavía no tenés ninguna galería.")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // Task #180: the cover photo, and its degrade. Two things this describe
  // block proves that a weaker "the card renders" assertion would not:
  // (1) a gallery WITH a cover actually renders an <img> presigned from its
  // own `coverProofKey`, in the mock's 16:10 box; (2) a gallery WITHOUT one
  // renders NO <img> at all and falls back to #143's original bordered card
  // — not a collapsed card, not a broken image, not an empty photo box.
  describe("gallery cover photo (task #180)", () => {
    it("renders the cover photo in a reserved 16:10 box, presigned from the gallery's own coverProofKey", async () => {
      getGalleriesForClientMock.mockResolvedValue([
        galleryListItem({ coverProofKey: "galleries/g1/proofs/a1.webp" }),
      ]);

      const element = await ClientGalleriesPage();
      const { container } = render(element);

      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe(
        "https://r2.example.com/galleries/g1/proofs/a1.webp?presigned=1",
      );
      expect(img?.parentElement?.className).toContain("aspect-[16/10]");
    });

    // Review finding on task #180: Tailwind's `from-*`/`via-*`/`to-*`
    // gradient utilities compile to FIXED 0%/50%/100% stops, which is NOT
    // the mock's own 8%/62%/100% (client.html:153-156) and composites to
    // ~1.04:1 contrast behind the meta line against a bright photo — well
    // under WCAG 1.4.3. Pinned as the literal gradient string (not just
    // "contains rgba(7,7,9...)") because the WRONG utility-class shape would
    // also contain that substring and this test must fail if it regresses
    // back to it. The real composited-pixel proof (real Chromium, a
    // blown-out white photo, WCAG relative luminance) lives in this task's
    // own commit message / PR description — jsdom cannot composite a
    // gradient over an image, so this is the closest this suite can pin
    // without a real browser.
    it("uses the mock's own gradient stops, not Tailwind's default 0/50/100", async () => {
      getGalleriesForClientMock.mockResolvedValue([
        galleryListItem({ coverProofKey: "galleries/g1/proofs/a1.webp" }),
      ]);

      const { container } = render(await ClientGalleriesPage());

      const scrim = container.querySelector('[aria-hidden="true"]');
      expect(scrim?.className).toContain(
        "bg-[linear-gradient(to_top,rgba(7,7,9,0.92)_8%,rgba(7,7,9,0.15)_62%,transparent)]",
      );
    });

    // The other half of the same review finding: `#143`'s `text-fg-mute`
    // (correct for its SOLID-background fallback card) was silently shared
    // onto the photo variant too via one `cardText` fragment, composing to
    // ~1.04:1 there. Mutation-proof: hardcoding `metaTextClass` back to a
    // single `"text-fg-mute"` in page.tsx turns the FIRST assertion below
    // red; hardcoding it to `"text-fg-dim"` turns the SECOND red.
    it("uses --fg-dim for the meta line over a photo, and --fg-mute for the bordered fallback", async () => {
      getGalleriesForClientMock.mockResolvedValue([
        galleryListItem({ id: "g1", coverProofKey: "galleries/g1/proofs/a1.webp" }),
        galleryListItem({ id: "g2", publicSlug: "s2", coverProofKey: null }),
      ]);

      const { container } = render(await ClientGalleriesPage());
      const items = container.querySelectorAll("li");
      const withCoverMeta = within(items[0] as HTMLElement).getByText(/fotos/);
      const noCoverMeta = within(items[1] as HTMLElement).getByText(/fotos/);

      expect(withCoverMeta.className).toContain("text-fg-dim");
      expect(withCoverMeta.className).not.toContain("text-fg-mute");
      expect(noCoverMeta.className).toContain("text-fg-mute");
      expect(noCoverMeta.className).not.toContain("text-fg-dim");
    });

    // THE degrade this task's own acceptance criterion demands: no cover
    // picked yet (the ordinary state for a fresh gallery) must not collapse
    // the card or leave a broken hole. Mutation-proof: removing the
    // `coverUrl ? ... : ...` branch in page.tsx and always taking the photo
    // path would render a broken/empty <img> here instead of nothing —
    // turning this test red.
    it("renders NO <img> at all, and keeps the text-forward card, when no cover has been picked yet", async () => {
      getGalleriesForClientMock.mockResolvedValue([galleryListItem({ coverProofKey: null })]);

      const element = await ClientGalleriesPage();
      const { container } = render(element);

      expect(container.querySelector("img")).toBeNull();
      // The fallback card is exactly #143's original: title and meta line
      // still render, inside a bordered (not photo) card.
      expect(screen.getByText("Boda Ana y Beto")).toBeDefined();
      const link = screen.getByRole("link");
      expect(link.className).toContain("border-line-2");
    });

    it("renders a mix of photo and text-forward cards side by side without breaking either", async () => {
      getGalleriesForClientMock.mockResolvedValue([
        galleryListItem({
          id: "g1",
          title: "Con portada",
          publicSlug: "s1",
          coverProofKey: "galleries/g1/proofs/cover.webp",
        }),
        galleryListItem({
          id: "g2",
          title: "Sin portada",
          publicSlug: "s2",
          coverProofKey: null,
        }),
      ]);

      const element = await ClientGalleriesPage();
      const { container } = render(element);

      expect(container.querySelectorAll("img")).toHaveLength(1);
      expect(screen.getByText("Con portada")).toBeDefined();
      expect(screen.getByText("Sin portada")).toBeDefined();
    });
  });
});
