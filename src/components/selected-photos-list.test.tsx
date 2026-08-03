// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedPhotosList, type SelectedPhotoListItem } from "./selected-photos-list";

afterEach(() => {
  cleanup();
});

function makeItem(
  id: string,
  originalFilename: string,
  selectionKind: SelectedPhotoListItem["selectionKind"] = "edited",
): SelectedPhotoListItem {
  return { id, originalFilename, selectionKind };
}

// Opens the collapsible so its <ol>/buttons are reachable the same way a
// real photographer would get to them — clicking the <summary>.
async function openDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/^Fotos seleccionadas/));
}

describe("SelectedPhotosList — zero case (acceptance criterion 5)", () => {
  it("renders nothing when there are no selected photos", () => {
    // No jest-dom is wired into this Vitest setup (no `setupFiles`), so
    // `toBeEmptyDOMElement` does not exist here — checking `innerHTML` is the
    // plain-DOM equivalent (see other test files' own comment on the same
    // constraint).
    const { container } = render(<SelectedPhotosList items={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("SelectedPhotosList — natural sort order (criterion 2)", () => {
  it("orders filenames numerically, IMG_2 before IMG_10, not lexicographically", async () => {
    const user = userEvent.setup();
    render(
      <SelectedPhotosList
        items={[
          makeItem("a", "IMG_10.JPG"),
          makeItem("b", "IMG_2.JPG"),
          makeItem("c", "IMG_1.JPG"),
        ]}
      />,
    );
    await openDetails(user);

    const items = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(items).toEqual(["IMG_1.JPG", "IMG_2.JPG", "IMG_10.JPG"]);
  });
});

describe("SelectedPhotosList — summary count", () => {
  it("shows the total count in the <summary>, closed by default", () => {
    render(<SelectedPhotosList items={[makeItem("a", "IMG_1.JPG"), makeItem("b", "IMG_2.JPG")]} />);

    const summary = screen.getByText("Fotos seleccionadas (2)");
    expect(summary.closest("details")?.hasAttribute("open")).toBe(false);
  });

  // A single-kind fixture makes `items.length` and `edited.length` (or
  // `original.length`) the SAME number, so it cannot tell "counts the whole
  // `items` array" apart from "counts one already-filtered group" — a 2-edited
  // fixture would still read "(2)" even if `summary.tsx:85` were mutated from
  // `items.length` to `edited.length`. Only a MIXED fixture, where the total
  // (3) differs from either group (2 and 1), can distinguish the two.
  it("counts the whole selection, not just one selectionKind group", () => {
    render(
      <SelectedPhotosList
        items={[
          makeItem("a", "IMG_1.JPG", "edited"),
          makeItem("b", "IMG_2.JPG", "edited"),
          makeItem("c", "IMG_3.JPG", "original"),
        ]}
      />,
    );

    expect(screen.getByText("Fotos seleccionadas (3)")).toBeDefined();
  });
});

describe("SelectedPhotosList — mixed selectionKind (criterion 4, mixed branch)", () => {
  it("splits into two headed groups when both edited and original are present", async () => {
    const user = userEvent.setup();
    render(
      <SelectedPhotosList
        items={[
          makeItem("a", "IMG_1.JPG", "edited"),
          makeItem("b", "IMG_2.JPG", "edited"),
          makeItem("c", "IMG_3.JPG", "original"),
        ]}
      />,
    );
    await openDetails(user);

    expect(screen.getByText("Para editar (2)")).toBeDefined();
    expect(screen.getByText("Entrega sin editar (1)")).toBeDefined();

    const groups = screen.getAllByRole("list");
    expect(groups).toHaveLength(2);
    expect(
      within(groups[0])
        .getAllByRole("listitem")
        .map((el) => el.textContent),
    ).toEqual(["IMG_1.JPG", "IMG_2.JPG"]);
    expect(
      within(groups[1])
        .getAllByRole("listitem")
        .map((el) => el.textContent),
    ).toEqual(["IMG_3.JPG"]);
  });

  it("renders two independent Copiar buttons in the mixed case", async () => {
    const user = userEvent.setup();
    render(
      <SelectedPhotosList
        items={[makeItem("a", "IMG_1.JPG", "edited"), makeItem("b", "IMG_2.JPG", "original")]}
      />,
    );
    await openDetails(user);

    expect(screen.getAllByRole("button", { name: "Copiar" })).toHaveLength(2);
  });
});

describe("SelectedPhotosList — single kind (criterion 4, common branch)", () => {
  it("renders one plain list, with no group headers, when every pick is `edited`", async () => {
    const user = userEvent.setup();
    render(
      <SelectedPhotosList
        items={[makeItem("a", "IMG_1.JPG", "edited"), makeItem("b", "IMG_2.JPG", "edited")]}
      />,
    );
    await openDetails(user);

    expect(screen.queryByText(/Para editar/)).toBeNull();
    expect(screen.queryByText(/Entrega sin editar/)).toBeNull();
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copiar" })).toHaveLength(1);
  });

  it("renders one plain list when every pick is `original`", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={[makeItem("a", "IMG_1.JPG", "original")]} />);
    await openDetails(user);

    expect(screen.queryByText(/Para editar/)).toBeNull();
    expect(screen.queryByText(/Entrega sin editar/)).toBeNull();
    expect(screen.getAllByRole("list")).toHaveLength(1);
  });
});

describe("SelectedPhotosList — copy button (criterion 3)", () => {
  // Two ordering traps here, both discovered by a failing mutation-proof run
  // (writeText call count staying 0 no matter what the mock did):
  //
  //   1. `vi.stubGlobal("navigator", ...)` replaces the WHOLE `navigator`
  //      object — jsdom's own `navigator` (which `userEvent`'s pointer
  //      simulation reads from) goes with it, and clicks silently stop
  //      reaching the button. Defining `clipboard` on the EXISTING
  //      `navigator` keeps everything else jsdom already wired up intact.
  //   2. `userEvent.setup()` ITSELF installs its own `navigator.clipboard`
  //      stub (`@testing-library/user-event`'s internal `ClipboardStub`,
  //      used for its own copy/paste key sequences) as a SIDE EFFECT of the
  //      call. Stubbing `navigator.clipboard` before `userEvent.setup()`
  //      runs gets silently overwritten by that internal stub — the
  //      component's `handleCopy` was calling a live `Clipboard` instance
  //      that resolves (or, for `writeText`, at least does not throw),
  //      never this suite's mock, so `writeText.mock.calls` stayed empty
  //      even on a passing render. `userEvent.setup()` first, this suite's
  //      `stubClipboard` after, makes this suite's stub the one still
  //      installed when the click fires.
  function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  afterEach(() => {
    // @ts-expect-error -- test-only cleanup of a property this suite defined.
    delete navigator.clipboard;
  });

  it("copies the exact filenames, one per line, with no numbering or decoration", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    stubClipboard(writeText);
    render(
      <SelectedPhotosList items={[makeItem("a", "IMG_10.JPG"), makeItem("b", "IMG_2.JPG")]} />,
    );
    await openDetails(user);

    await user.click(screen.getByRole("button", { name: "Copiar" }));

    expect(writeText).toHaveBeenCalledWith("IMG_2.JPG\nIMG_10.JPG");
  });

  it("copies only the edited group's filenames from its own Copiar button in the mixed case", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    stubClipboard(writeText);
    render(
      <SelectedPhotosList
        items={[makeItem("a", "IMG_1.JPG", "edited"), makeItem("b", "IMG_2.JPG", "original")]}
      />,
    );
    await openDetails(user);

    const [editedButton] = screen.getAllByRole("button", { name: "Copiar" });
    await user.click(editedButton);

    expect(writeText).toHaveBeenCalledWith("IMG_1.JPG");
  });

  it("shows an inline error and keeps the list visible when the clipboard call rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("no permission"));
    const user = userEvent.setup();
    stubClipboard(writeText);
    render(<SelectedPhotosList items={[makeItem("a", "IMG_1.JPG")]} />);
    await openDetails(user);

    await user.click(screen.getByRole("button", { name: "Copiar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no se pudo copiar/i);
    expect(screen.getByText("IMG_1.JPG")).toBeDefined();
  });
});
