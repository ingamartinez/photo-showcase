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
    getGalleriesForClientMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 24,
      },
    ]);

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
      {
        id: "g1",
        title: "Sesión de compromiso",
        publicSlug: "s1",
        status: "selected",
        sessionDate: "2026-03-14",
        photoCount: 13,
      },
      {
        id: "g2",
        title: "Retrato — invierno",
        publicSlug: "s2",
        status: "delivered",
        sessionDate: "2024-07-02",
        photoCount: 20,
      },
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
    getGalleriesForClientMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 24,
      },
    ]);

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
    getGalleriesForClientMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 24,
      },
    ]);

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
      {
        id: "g1",
        title: "Sesión de verano",
        publicSlug: "s1",
        status: "delivered",
        sessionDate: "2026-06-01",
        photoCount: 30,
      },
      {
        id: "g2",
        title: "Cumpleaños",
        publicSlug: "s2",
        status: "proofing",
        sessionDate: "2026-07-01",
        photoCount: 15,
      },
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
});
