// @vitest-environment jsdom
//
// Same reasoning as src/app/galleries/[publicSlug]/page.chrome.test.tsx:
// jsdom cannot resolve the bare `import "server-only"` pulled in
// transitively by src/lib/auth-guards.ts and src/lib/galleries.ts, even with
// `vi.mock("server-only", ...)`. So both of those modules are mocked
// wholesale here.
//
// page.test.ts (node environment) proves the session guard is real and that
// the query is scoped to the session's own user id; this file is the other
// half — the only place that proves each gallery's title/status/session
// date/photo count are actually wired into markup, and that the empty state
// renders when the client has no galleries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Session } from "next-auth";
import ClientGalleriesPage from "./page";
import type { ClientGalleryListItem } from "@/lib/galleries";

const requireSessionMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireSession: () => requireSessionMock() }));

const getGalleriesForClientMock = vi.fn<() => Promise<ClientGalleryListItem[]>>();
vi.mock("@/lib/galleries", () => ({
  getGalleriesForClient: () => getGalleriesForClientMock(),
  formatGalleryStatus: (status: string) => {
    const labels: Record<string, string> = {
      draft: "Borrador",
      proofing: "En pruebas",
      selected: "Selección enviada",
      delivered: "Entregada",
      archived: "Archivada",
    };
    return labels[status] ?? status;
  },
  formatSessionDate: (sessionDate: string) => {
    const [year, month, day] = sessionDate.split("-");
    return `${day}/${month}/${year}`;
  },
}));

beforeEach(() => {
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue({
    user: { id: "client-a", role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getGalleriesForClientMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ClientGalleriesPage chrome", () => {
  it("renders each gallery's title, status, session date and photo count, linked by publicSlug", async () => {
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
    expect(within(listItem).getByText("En pruebas")).toBeDefined();
    expect(within(listItem).getByText(/01\/08\/2026/)).toBeDefined();
    expect(within(listItem).getByText("24 fotos")).toBeDefined();
    expect(within(listItem).getByRole("link")).toHaveProperty(
      "href",
      expect.stringContaining("/galleries/abc123"),
    );

    expect(screen.queryByText("Todavía no tenés ninguna galería.")).toBeNull();
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
    getGalleriesForClientMock.mockResolvedValue([]);

    const element = await ClientGalleriesPage();
    render(element);

    expect(screen.getByText("Todavía no tenés ninguna galería.")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
