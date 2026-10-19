// @vitest-environment jsdom
//
// jsdom has no layout and no CSS cascade, so this file stubs the ONE thing the
// component reads — the resolved `grid-template-columns` of its `<ul>` — and
// keeps every other computed property delegated to jsdom's real implementation
// (Testing Library's own role-visibility check reads `display` through the
// same function, so a blanket fake would make `hidden` invisible to the
// queries that exist to prove it).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { countGridColumns, GalleryClientList } from "./gallery-client-list";

let tracks = "";
let fireResize: () => void = () => {};

function stubGrid(value: string) {
  tracks = value;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        fireResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = real(element, pseudo);
    if (!(element instanceof HTMLUListElement)) return style;
    return new Proxy(style, {
      get: (target, property) => {
        if (property === "gridTemplateColumns") return tracks;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CSSStyleDeclaration;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tracks = "";
  fireResize = () => {};
});

function items(count: number, renderRow: (index: number) => ReactNode = renderPlainRow) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `c${index + 1}`,
    row: renderRow(index),
  }));
}

function renderPlainRow(index: number) {
  return <p>{`Cliente ${index + 1}`}</p>;
}

function rows() {
  return Array.from(document.querySelectorAll("li"));
}

describe("countGridColumns", () => {
  it("counts the resolved px tracks a browser serializes an auto-fill grid into", () => {
    expect(countGridColumns("300px 300px 300px")).toBe(3);
    expect(countGridColumns("  196.5px   196.5px  ")).toBe(2);
    expect(countGridColumns("343px")).toBe(1);
  });

  // The sentinel. Anything this function cannot READ must be reported as
  // unmeasured (`null`), never as "one column" — a fallback of `1` would drop
  // into `2 * columns` and hide rows on a grid nobody actually measured.
  it.each([
    ["an empty value (jsdom, no stylesheet)", ""],
    ["an unresolved template", "repeat(auto-fill, minmax(190px, 1fr))"],
    ["no template at all", "none"],
    ["a keyword track", "auto"],
  ])("returns null — never a count — for %s", (_label, value) => {
    expect(countGridColumns(value)).toBeNull();
  });
});

describe("GalleryClientList — the unmeasured sentinel", () => {
  // (a) the real jsdom environment: `ResizeObserver` does not exist and
  // `getComputedStyle(ul).gridTemplateColumns` is `""`. This is the exact
  // combination every existing page-level test renders under.
  it("renders every item and no toggle when nothing can be measured at all", () => {
    render(<GalleryClientList items={items(7)} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Ver todos/ })).toBeNull();
  });

  // (b)–(d): ResizeObserver present, but the resolved value is not a list of
  // px tracks. Still unmeasured, still everything, still no toggle.
  it.each([
    ["the resolved value is empty", ""],
    ["the template is unresolved", "repeat(auto-fill, minmax(190px, 1fr))"],
    ["the container has no template", "none"],
  ])("renders every item and no toggle when %s", (_label, value) => {
    stubGrid(value);

    render(<GalleryClientList items={items(7)} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Ver todos/ })).toBeNull();
  });
});

describe("GalleryClientList — two rows, measured in columns", () => {
  it("shows only the first two grid rows while collapsed, and starts collapsed", () => {
    stubGrid("300px 300px 300px");

    render(<GalleryClientList items={items(7)} />);

    // 3 columns x 2 rows = 6 cells. Role queries exclude the hidden rows, and
    // the seventh `<li>` is hidden by ATTRIBUTE (not by a class), which is
    // `display: none`: out of the tab order and out of the accessibility tree.
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(rows()).toHaveLength(7);
    expect(rows()[5]?.hidden).toBe(false);
    expect(rows()[6]?.hidden).toBe(true);
  });

  it("renders no toggle when exactly two rows are filled", () => {
    stubGrid("300px 300px 300px");

    render(<GalleryClientList items={items(6)} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /Ver todos|Mostrar menos/ })).toBeNull();
  });

  it("re-counts the visible rows when the grid resolves to fewer columns", () => {
    stubGrid("300px 300px 300px");
    render(<GalleryClientList items={items(7)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);

    tracks = "300px 300px";
    act(() => fireResize());

    // 2 columns x 2 rows = 4 cells.
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(rows()[4]?.hidden).toBe(true);
  });

  // More columns than two rows' worth of clients: the toggle must count what
  // it is hiding, not just announce the action.
  it("carries the hidden count in the toggle, and drops it once expanded", async () => {
    stubGrid("300px 300px 300px");
    const user = userEvent.setup();
    render(<GalleryClientList items={items(10)} />);

    await user.click(screen.getByRole("button", { name: "Ver todos (4)" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /Ver todos/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar menos" })).toBeDefined();
  });
});

describe("GalleryClientList — the disclosure", () => {
  it("is a real button that names its state, controls the list, and works from the keyboard", async () => {
    stubGrid("300px 300px 300px");
    const user = userEvent.setup();
    render(<GalleryClientList items={items(7)} />);

    const list = screen.getByRole("list", { name: "Clientes de la galería" });
    const toggle = screen.getByRole("button", { name: "Ver todos (1)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);

    // Keyboard, not a pointer: tab to the toggle and toggle it with Enter.
    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    // Same element, different state — the toggle is not remounted.
    expect(screen.getByRole("button", { name: "Mostrar menos" })).toBe(toggle);

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  // Hidden, NOT unmounted: each row owns a `useActionState` for resend,
  // removal and the selection actions, so a collapse must not discard it.
  it("keeps a hidden row's own state across collapse and expand", async () => {
    stubGrid("300px 300px 300px");
    const user = userEvent.setup();

    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount((current) => current + 1)}>
          {`Contador ${count}`}
        </button>
      );
    }

    render(<GalleryClientList items={items(7, (index) => (index === 6 ? <Counter /> : null))} />);

    await user.click(screen.getByRole("button", { name: "Ver todos (1)" }));
    await user.click(screen.getByRole("button", { name: "Contador 0" }));
    await user.click(screen.getByRole("button", { name: "Contador 1" }));
    expect(screen.getByRole("button", { name: "Contador 2" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Mostrar menos" }));
    expect(screen.queryByRole("button", { name: /Contador/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Ver todos (1)" }));
    // Unmounting on collapse would have reset this to "Contador 0".
    expect(screen.getByRole("button", { name: "Contador 2" })).toBeDefined();
  });
});
