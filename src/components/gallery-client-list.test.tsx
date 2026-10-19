// @vitest-environment jsdom
//
// jsdom has no layout and no CSS cascade, so this file stubs the ONE thing the
// component reads — the resolved `grid-template-columns` of its `<ul>` — and
// keeps every other computed property delegated to jsdom's real implementation
// (Testing Library's own role-visibility check reads `display` through the
// same function, so a blanket fake would make `hidden` invisible to the
// queries that exist to prove it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { countGridColumns, GalleryClientList } from "./gallery-client-list";
import { GalleryClientRow } from "./gallery-client-row";
import type {
  RemoveGalleryClientState,
  ResendGalleryAccessEmailState,
} from "@/app/dashboard/galleries/actions";

// The list's own tests need the REAL `<GalleryClientRow>` for the portal
// regression below (a plain paragraph has no menu to leak), and that row
// imports the server actions — mocked here for the same reason
// `gallery-client-row.test.tsx` mocks them: `@/lib/auth-guards` behind them is
// "server-only" and unresolvable under jsdom.
const removeGalleryClientMock =
  vi.fn<
    (state: RemoveGalleryClientState, formData: FormData) => Promise<RemoveGalleryClientState>
  >();
const resendGalleryAccessEmailMock =
  vi.fn<
    (
      state: ResendGalleryAccessEmailState,
      formData: FormData,
    ) => Promise<ResendGalleryAccessEmailState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  removeGalleryClient: (...args: [RemoveGalleryClientState, FormData]) =>
    removeGalleryClientMock(...args),
  resendGalleryAccessEmail: (...args: [ResendGalleryAccessEmailState, FormData]) =>
    resendGalleryAccessEmailMock(...args),
}));

let tracks = "";
const resizeCallbacks: ResizeObserverCallback[] = [];

/** Fire every observer the component subscribed. It has to be EVERY one,
 * not "the last constructed": Radix's Popper (behind the row's "Acciones"
 * menu) registers a `ResizeObserver` of its own, and a stub that kept only the
 * newest callback fired Popper's instead of the list's — which is how the
 * regression test below first missed the very resize it is about. */
function fireResize() {
  for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
}

function stubGrid(value: string) {
  tracks = value;
  resizeCallbacks.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
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
  resizeCallbacks.length = 0;
});

beforeEach(() => {
  removeGalleryClientMock.mockReset();
  removeGalleryClientMock.mockResolvedValue({ status: "idle" });
  resendGalleryAccessEmailMock.mockReset();
  resendGalleryAccessEmailMock.mockResolvedValue({ status: "idle" });
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

// Task #273, review round 1 — the CRITICAL finding. The row's "Acciones" menu
// is a Radix portal rendered into `document.body`, so the `hidden` attribute
// on the `<li>` this list owns cannot reach it: an OPEN menu on a row that a
// narrower viewport pushed behind the toggle used to stay on screen, stay
// keyboard-focusable, stay in the accessibility tree, and still fire
// "Reenviar acceso" for a client nobody could see. The resize tests above use
// plain paragraphs and counters, which is why they never reached it; this one
// drives the REAL row, with its real menu, through the list.
describe("GalleryClientList — a hidden row's open menu (review round 1)", () => {
  const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

  function realClientRows(count: number) {
    return Array.from({ length: count }, (_unused, index) => {
      const client = {
        id: `u${index + 1}`,
        name: `Cliente ${index + 1}`,
        email: `cliente${index + 1}@example.com`,
      };
      return {
        id: client.id,
        row: (
          <GalleryClientRow
            galleryId={GALLERY_ID}
            client={client}
            status="proofing"
            removable
            resendable
          />
        ),
      };
    });
  }

  it("closes the menu a column reduction orphans, hands focus to the disclosure, and keeps that row's own state", async () => {
    resendGalleryAccessEmailMock.mockResolvedValue({
      status: "resent",
      message: "Le reenviamos el enlace de acceso a cliente7@example.com.",
    });
    stubGrid("300px 300px 300px 300px");
    const user = userEvent.setup();
    render(<GalleryClientList items={realClientRows(8)} />);

    // Four columns x two rows holds all eight: nothing hidden, no toggle, and
    // client 7 is on screen — where the reviewer's repro opens its menu.
    expect(rows()).toHaveLength(8);
    expect(rows()[7]?.hidden).toBe(false);
    expect(screen.queryByRole("button", { name: /Ver todos/ })).toBeNull();

    // Give client 7 state of its own that only a MOUNTED row can keep: a
    // resent result and an open inline confirmation.
    await user.click(screen.getByRole("button", { name: "Acciones para Cliente 7" }));
    await user.click(screen.getByRole("menuitem", { name: "Reenviar acceso" }));
    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: "Acciones para Cliente 7" }));
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDefined();

    // Leave the menu OPEN: the exact state the review reproduced the defect in.
    await user.click(screen.getByRole("button", { name: "Acciones para Cliente 7" }));
    expect(screen.getByRole("menu")).toBeDefined();

    // The viewport narrows to three columns: six cells, so clients 7 and 8 are
    // now surplus and their `<li>`s get `hidden`.
    tracks = "300px 300px 300px";
    act(() => fireResize());

    expect(rows()[7]?.hidden).toBe(true);

    // The portal is GONE, not merely parented to a hidden `<li>` — all three
    // of these read the live document, where an orphaned menu would be.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Acciones para Cliente 7" })).toBeNull();

    // Focus did not fall to `<body>`: it went to the disclosure that hid the
    // row, which is still there and is the way back.
    const toggle = screen.getByRole("button", { name: "Ver todos (2)" });
    expect(document.activeElement).toBe(toggle);

    // The reviewer's exploit, replayed: arrow-key towards the menu, then try to
    // activate "Reenviar acceso". There is no menu to enter and no action to
    // fire — the resend count stays at the one resend above.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(toggle);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(resendGalleryAccessEmailMock).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(resendGalleryAccessEmailMock).toHaveBeenCalledTimes(1);

    // Hidden, NEVER unmounted: client 7 comes back with the state it had — the
    // resent result and the confirmation it left open — and its menu did not
    // reopen by itself.
    await user.click(toggle);

    expect(rows()[7]?.hidden).toBe(false);
    expect(
      screen.getByText("Le reenviamos el enlace de acceso a cliente7@example.com."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDefined();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Acciones para Cliente 7" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
