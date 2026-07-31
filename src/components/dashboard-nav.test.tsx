// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DashboardNav, isNavItemCurrent } from "./dashboard-nav";

// The one thing this component needs from the router. Mocked rather than
// wrapped in a real app-router context because the pathname IS the input
// under test — every case below is "given this URL, which destination is
// current", and a mock is the only way to say "given this URL".
const usePathnameMock = vi.fn<() => string | null>();

vi.mock("next/navigation", () => ({
  usePathname: () => usePathnameMock(),
}));

beforeEach(() => {
  usePathnameMock.mockReset();
  usePathnameMock.mockReturnValue("/dashboard");
});

afterEach(() => {
  cleanup();
});

describe("isNavItemCurrent", () => {
  it("marks Panel current on /dashboard itself", () => {
    expect(isNavItemCurrent("/dashboard", "/dashboard")).toBe(true);
  });

  // The reason this function exists instead of a bare `startsWith`:
  // "/dashboard" prefixes every route in the segment, so a prefix match
  // would mark Panel current on every single screen.
  it.each(["/dashboard/clients", "/dashboard/galleries", "/dashboard/galleries/g-1"])(
    "does NOT mark Panel current on %s",
    (pathname) => {
      expect(isNavItemCurrent(pathname, "/dashboard")).toBe(false);
    },
  );

  it("keeps a section current on its own child routes", () => {
    expect(isNavItemCurrent("/dashboard/galleries/g-1", "/dashboard/galleries")).toBe(true);
    expect(isNavItemCurrent("/dashboard/galleries", "/dashboard/galleries")).toBe(true);
  });

  // The boundary is the "/", not the string prefix: a sibling route whose
  // name merely starts with another destination's must not steal it.
  it("does not claim a sibling route that only shares a string prefix", () => {
    expect(isNavItemCurrent("/dashboard/galleries-archivo", "/dashboard/galleries")).toBe(false);
  });

  it("keeps the sections independent of each other", () => {
    expect(isNavItemCurrent("/dashboard/clients", "/dashboard/galleries")).toBe(false);
    expect(isNavItemCurrent("/dashboard/galleries", "/dashboard/clients")).toBe(false);
  });
});

describe("DashboardNav", () => {
  it("renders exactly one navigation landmark holding all three destinations", () => {
    render(<DashboardNav />);

    // Epic #125's hard rule for the shell: the phone tab bar and the desktop
    // sidebar are ONE element relocated by CSS. A second, breakpoint-specific
    // copy of this markup would show up here as a second navigation landmark
    // (and as six links instead of three), which is exactly the duplication
    // that would let one of the two copies rot unnoticed.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);

    const nav = screen.getByRole("navigation", { name: "Principal" });
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.textContent)).toEqual(["Panel", "Clientes", "Galerías"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard",
      "/dashboard/clients",
      "/dashboard/galleries",
    ]);
    expect(nav.contains(links[0]!)).toBe(true);
  });

  // No jest-dom is wired into this Vitest setup (no `setupFiles`), so
  // `toHaveAttribute` does not exist here — reading the attribute is the
  // honest equivalent. Same reasoning as src/components/gallery-client-row
  // .test.tsx:294-299.
  function currentAttributeOf(name: string): string | null {
    return screen.getByRole("link", { name }).getAttribute("aria-current");
  }

  it("marks the current route, and only it, with aria-current=page", () => {
    usePathnameMock.mockReturnValue("/dashboard/galleries/g-1");
    render(<DashboardNav />);

    expect(currentAttributeOf("Galerías")).toBe("page");
    expect(currentAttributeOf("Panel")).toBeNull();
    expect(currentAttributeOf("Clientes")).toBeNull();
  });

  it("moves the marker to Clientes on the clients screen", () => {
    usePathnameMock.mockReturnValue("/dashboard/clients");
    render(<DashboardNav />);

    expect(currentAttributeOf("Clientes")).toBe("page");
    expect(currentAttributeOf("Galerías")).toBeNull();
    expect(currentAttributeOf("Panel")).toBeNull();
  });

  // The current item reads as raised, not brass-washed: the mock's status
  // palette is deliberately NOT the brand accent
  // (design/system/dashboard.html:82-91), and the only brass on a current
  // item is its icon (:186, :527-528). A background of `--accent` here would
  // be the exact mistake that rule exists to prevent.
  it("indicates the current item with the raised surface, never an accent fill", () => {
    usePathnameMock.mockReturnValue("/dashboard/clients");
    render(<DashboardNav />);

    const current = screen.getByRole("link", { name: "Clientes" });
    expect(current.className).toContain("lg:bg-[var(--app-raised)]");
    expect(current.className).not.toContain("bg-accent");
  });
});
