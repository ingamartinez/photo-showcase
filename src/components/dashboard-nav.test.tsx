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
  //
  // HOVER IS THE SAME RULE (dashboard.html:527) and needs its own POSITIVE
  // assertion, not just the negative one below. `not.toContain("bg-accent")`
  // does catch a literal `lg:hover:bg-accent` — verified by mutation — but it
  // is blind to the two nearest ways to get brass in here anyway: writing it
  // as an arbitrary value (`lg:hover:bg-[var(--accent)]`, which contains no
  // "bg-accent" substring at all, and was measured GREEN against the negative
  // assertion alone) or simply deleting the hover treatment. Naming the class
  // that must BE there closes both; a rule asserted only by what it forbids
  // can always be broken by spelling the same thing differently.
  it("indicates the current item with the raised surface, never an accent fill", () => {
    usePathnameMock.mockReturnValue("/dashboard/clients");
    render(<DashboardNav />);

    const current = screen.getByRole("link", { name: "Clientes" });
    // `lg:bg-app-raised` since #175 — the same token, reached through the
    // `@theme` alias instead of an arbitrary value. Asserted as whole class
    // tokens: `toContain("lg:bg-app-raised")` alone would also be satisfied by
    // `lg:bg-app-raised-something`, and more to the point it would keep
    // passing if tailwind-merge dropped one of them and left the other.
    expect(current.className.split(/\s+/)).toContain("lg:bg-app-raised");
    expect(current.className.split(/\s+/)).toContain("lg:hover:bg-app-raised");
    expect(current.className).not.toContain("bg-accent");
  });

  // #175 migrated this component off `text-[length:var(--app-text-*)]`. The
  // `length:` hint in those strings was not decoration: it was what told
  // tailwind-merge the class was a SIZE. Named aliases carry no such hint, so
  // twMerge reads `text-app-micro` as a text colour unless src/lib/utils.ts
  // teaches it otherwise — and this component then hands `cn()` a size and a
  // colour in the same call, so the size is DELETED from the rendered
  // className. Nothing throws; the item just renders at the inherited size.
  //
  // src/lib/utils.test.ts pins the merge behaviour in isolation. This asserts
  // it on the actual rendered element, which is what also catches the class
  // surviving cn() but being dropped from the markup for any other reason.
  it("keeps the app font sizes on the rendered item, both current and not", () => {
    usePathnameMock.mockReturnValue("/dashboard/clients");
    render(<DashboardNav />);

    for (const name of ["Clientes", "Panel"]) {
      const classes = screen.getByRole("link", { name }).className.split(/\s+/);

      expect(classes, `${name} lost its phone font size`).toContain("text-app-micro");
      expect(classes, `${name} lost its desktop font size`).toContain("lg:text-app-base");
    }
  });

  // The sidebar reads in source order: wordmark, nav, account. It briefly did
  // not — the mock's `order: -1` (owner-confirmed slip, 2026-07-31) put the
  // nav above the studio's own name, and this component carried
  // `lg:order-first` to match it.
  //
  // Asserted on the class rather than on the DOM, deliberately: the DOM order
  // never changed, so ANY assertion about element order would have passed
  // just as happily before the fix as after it — which would make it a test
  // that reads as if it guards this and does not. `order-*` is CSS-only and
  // jsdom computes no layout, so the class list is the honest place to say
  // "nothing here overrides source order".
  it("does not reorder the sidebar away from source order", () => {
    render(<DashboardNav />);

    expect(screen.getByRole("navigation").className).not.toMatch(/(^|[:\s])-?order-/);
  });
});
