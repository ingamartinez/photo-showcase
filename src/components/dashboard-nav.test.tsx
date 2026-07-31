// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DashboardNav, isNavItemCurrent, PENDING_COUNT_POLL_INTERVAL_MS } from "./dashboard-nav";

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
  // `<DashboardNav>` now fetches on mount (task #174's polling hook) —
  // stubbed to a rejection by default so every test in this file that does
  // NOT care about the badge (all of the ones above the "pending-review
  // badge" describe block below) never issues a real, unmocked `fetch()`
  // call. The rejection is swallowed by the hook's own `catch` (see its doc
  // comment), so this changes nothing observable for those tests — no
  // badge ever renders because `count` never leaves `null`.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("fetch not stubbed for this test"))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

  // #175 migrated this component off the `length:`-hinted arbitrary values.
  // That hint was not decoration: it was what told
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

// ============================================================================
// Task #174 — the pending-review badge, and what keeps it TRUE
// ============================================================================
//
// The epic's own rule (#125, quoting this task): "a counter that lies is
// worse than a counter that is missing". Rendering "3" once, on mount, would
// satisfy a test that only checks the first paint and would satisfy NOTHING
// this task actually asked for — the whole point of #174 is that the number
// must track reality WHILE the tab stays open, in both directions (a client
// submitting from elsewhere, an admin delivering from here). Every test
// below that matters drives the REAL poll loop on fake timers, at the REAL
// cadence (`PENDING_COUNT_POLL_INTERVAL_MS`, imported rather than hand-copied
// — same reason `proof-grid.test.tsx` imports `SELECTION_POLL_INTERVAL_MS`),
// and asserts on what a SECOND tick does to the badge, not only on what the
// first one does.
describe("DashboardNav — pending-review badge (task #174)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  /** The Galerías `<a>`, found by its stable `href` rather than by accessible
   * name — once the badge renders, the sr-only sentence beside the digit
   * becomes PART of that name (same accessible-name algorithm a screen
   * reader uses), so matching on "Galerías" alone would stop finding it the
   * moment this task's own feature works. */
  function galleriasLink(): HTMLElement {
    const link = screen
      .getAllByRole("link")
      .find((candidate) => candidate.getAttribute("href") === "/dashboard/galleries");
    if (!link) throw new Error("Galerías link not found");
    return link;
  }

  // `span`, not the bare `[aria-hidden="true"]` attribute alone: the Icon
  // right before it (an inline SVG) carries the same attribute, and a
  // selector that matched either would find the icon FIRST and read its
  // (empty) textContent instead of the badge's.
  function badgeDigitOf(link: HTMLElement): string | null {
    return link.querySelector('span[aria-hidden="true"]')?.textContent ?? null;
  }

  /** Lets a `fetch` already issued by the mount-time poll resolve, without
   * advancing any interval — the initial fetch fires synchronously inside
   * `useEffect`, not on a timer, so there is no interval tick to advance yet. */
  async function flushMountPoll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function onePollTick() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_COUNT_POLL_INTERVAL_MS);
    });
  }

  it("shows no badge before the first response lands — never a guessed zero", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(<DashboardNav />);

    expect(badgeDigitOf(galleriasLink())).toBeNull();
  });

  it("shows the server's count on the Galerías item once the first poll resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { count: 2 }))),
    );

    render(<DashboardNav />);
    await flushMountPoll();

    const link = galleriasLink();
    expect(badgeDigitOf(link)).toBe("2");
    expect(link.textContent).toContain("2 selecciones esperando");
  });

  it("shows nothing on Panel or Clientes — the count is about Galerías specifically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { count: 4 }))),
    );

    render(<DashboardNav />);
    await flushMountPoll();

    for (const name of ["Panel", "Clientes"]) {
      const link = screen.getAllByRole("link").find((candidate) => candidate.textContent === name);
      if (!link) throw new Error(`${name} link not found`);
      expect(badgeDigitOf(link)).toBeNull();
    }
  });

  it("shows no badge once the count is confirmed at zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { count: 0 }))),
    );

    render(<DashboardNav />);
    await flushMountPoll();

    expect(badgeDigitOf(galleriasLink())).toBeNull();
  });

  // THE test this task's own acceptance criteria are actually about: the
  // number must change AFTER mount, without a reload, in response to
  // something that happened elsewhere — not merely render correctly once.
  //
  // MUTATION-PROVEN (see this slice's own report): removing the `setInterval`
  // call from `usePendingSelectionCount` (so only the mount-time fetch ever
  // fires) turns this RED — the badge stays on "2" forever instead of
  // dropping to nothing, because nothing ever asks the server again.
  it("STALENESS: updates the badge on the NEXT poll tick when the server's count changed", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        // First call (mount): 2 pending. Second call (one interval tick
        // later): 0 — e.g. the photographer delivered both while this tab
        // stayed open, the exact "other direction" #174's acceptance
        // criteria name explicitly.
        return Promise.resolve(jsonResponse(200, { count: call === 1 ? 2 : 0 }));
      }),
    );

    render(<DashboardNav />);
    await flushMountPoll();
    expect(badgeDigitOf(galleriasLink())).toBe("2");

    await onePollTick();

    expect(badgeDigitOf(galleriasLink())).toBeNull();
  });

  it("goes the OTHER way too: a poll tick reporting a HIGHER count grows the badge", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        // First call (mount): nothing pending. Second call: a client
        // submitted from a DIFFERENT tab while this one stayed open — the
        // direction the epic's own decisive argument is about (a Route
        // Handler running in the CLIENT's session cannot reach this tab any
        // other way than this tab asking again).
        return Promise.resolve(jsonResponse(200, { count: call === 1 ? 0 : 1 }));
      }),
    );

    render(<DashboardNav />);
    await flushMountPoll();
    expect(badgeDigitOf(galleriasLink())).toBeNull();

    await onePollTick();

    const link = galleriasLink();
    expect(badgeDigitOf(link)).toBe("1");
    expect(link.textContent).toContain("1 selección esperando");
  });

  it("keeps the last known count rather than blanking it on a failed tick", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve(jsonResponse(200, { count: 3 }));
        return Promise.reject(new Error("offline"));
      }),
    );

    render(<DashboardNav />);
    await flushMountPoll();
    expect(badgeDigitOf(galleriasLink())).toBe("3");

    await onePollTick();

    // Stale-but-honest: a network blip must not read as "nothing pending".
    expect(badgeDigitOf(galleriasLink())).toBe("3");
  });

  // A DIFFERENT failure path than the one above: a RESOLVED, non-ok response
  // (the doc comment's own example — a 401 because the session expired
  // mid-tab), not a rejected fetch. The two are handled by different lines
  // (`if (!response.ok) return;` vs. the `catch`), so a test that only ever
  // exercises the rejection leaves the `!response.ok` branch completely
  // unguarded — this is that branch's own test.
  it("keeps the last known count when a tick answers 401 (session expired mid-tab)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve(jsonResponse(200, { count: 3 }));
        return Promise.resolve(jsonResponse(401, { error: "unauthorized" }));
      }),
    );

    render(<DashboardNav />);
    await flushMountPoll();
    expect(badgeDigitOf(galleriasLink())).toBe("3");

    await onePollTick();

    // A 401 must read exactly like the offline case above — the last known
    // count, not a blanked badge that would falsely claim "nothing pending"
    // while galleries actually wait (epic #125's own rule).
    expect(badgeDigitOf(galleriasLink())).toBe("3");
  });

  it("does not poll while the tab is hidden, and catches up the moment it becomes visible again", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        return Promise.resolve(jsonResponse(200, { count: call === 1 ? 0 : 2 }));
      }),
    );

    render(<DashboardNav />);
    await flushMountPoll();
    expect(badgeDigitOf(galleriasLink())).toBeNull();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await onePollTick();
    // Backgrounded: the interval tick above must not have issued a second
    // request while `document.hidden` was true.
    expect(call).toBe(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(badgeDigitOf(galleriasLink())).toBe("2");
  });
});
