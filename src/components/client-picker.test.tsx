// @vitest-environment jsdom
//
// Task #247 — the shared client picker. Every assertion below guards a
// behaviour that would otherwise pass review while being broken in a browser,
// which is why the file is about ROLES and SUBMITTED FORM DATA rather than
// about what the trigger paints.
//
// The fixture deliberately carries three shapes the real data has: an accented
// name, a fully uppercased accented name (so case- and accent-insensitivity are
// separately reachable), and a client with no name at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientPicker } from "./client-picker";

const LABEL = "Clientes (opcional)";

const CLIENTS = [
  { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
  { id: "u2", name: "ÁLVARO Ruiz", email: "alvaro@example.com" },
  { id: "u3", name: null, email: "beto@example.com" },
];

type User = ReturnType<typeof userEvent.setup>;

function renderPicker(clients = CLIENTS) {
  const submitSpy = vi.fn();
  const tree = (nextClients: typeof CLIENTS) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitSpy();
      }}
    >
      <ClientPicker id="picked" name="clientIds" label={LABEL} clients={nextClients} />
      <button type="submit">Enviar</button>
    </form>
  );
  const view = render(tree(clients));
  // Same element tree on `rerender`, so React reconciles and keeps the very
  // same `<form>` node — which is what the picker's `reset` listener is bound
  // to.
  return { ...view, submitSpy, form: view.container.querySelector("form")!, tree };
}

/** Opens the list. While it is open the rest of the page is `aria-hidden`
 * (Radix's modal `hideOthers`), so nothing outside it is queryable — that is
 * also why every test closes with Escape before touching the form. */
async function openPicker(user: User) {
  await user.click(screen.getByLabelText(LABEL));
}

function optionNames(): (string | null)[] {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}

afterEach(() => {
  cleanup();
});

describe("ClientPicker", () => {
  it("labels the trigger with the call site's own label", () => {
    renderPicker();

    const trigger = screen.getByLabelText(LABEL);
    expect(trigger.tagName).toBe("BUTTON");
    // The label is the trigger's ACCESSIBLE NAME — the count is carried by
    // `aria-describedby` instead, because a label association wins over
    // element content in the accessible-name computation.
    expect(screen.getByRole("button", { name: LABEL })).toBe(trigger);
  });

  it("opens a listbox of options, falling back to email for a client with no name", async () => {
    const user = userEvent.setup();
    renderPicker();

    await openPicker(user);

    // `getByRole("textbox")` is the criterion, and it is why the search is
    // `type="text"` rather than `type="search"` (which would be `searchbox`).
    expect(screen.getByRole("textbox")).toBeDefined();
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("aria-selected")).toBe("false");
    }
    expect(screen.getByRole("option", { name: "beto@example.com" })).toBeDefined();
  });

  it("filters case- and accent-insensitively", async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);
    const search = screen.getByRole("textbox");

    await user.type(search, "perez");
    expect(optionNames()).toEqual(["Ana Pérez"]);

    await user.clear(search);
    await user.type(search, "alvaro");
    expect(optionNames()).toEqual(["ÁLVARO Ruiz"]);

    // The owner's amendment: a client with no name is findable by email...
    await user.clear(search);
    await user.type(search, "BETO");
    expect(optionNames()).toEqual(["beto@example.com"]);

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Ningún cliente coincide.")).toBeDefined();
  });

  // The plan's literal criterion read "filter by `name ?? email`", which would
  // have made a NAMED client unfindable by their email. The owner amended it
  // (2026-10-17) to name OR email, and this is the assertion that pins the
  // amendment rather than the plan.
  it("finds a named client by their email address", async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    await user.type(screen.getByRole("textbox"), "ana@example.com");

    expect(optionNames()).toEqual(["Ana Pérez"]);
  });

  it("selects several clients in one open session and counts them on the trigger", async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole("option", { name: "Ana Pérez" }));
    await user.click(screen.getByRole("option", { name: "beto@example.com" }));

    expect(screen.getByRole("option", { name: "Ana Pérez" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      screen.getByRole("option", { name: "beto@example.com" }).getAttribute("aria-selected"),
    ).toBe("true");
    // Selecting does not close the list — that is what makes a multi-pick one
    // session rather than one open per client.
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.keyboard("{Escape}");

    // The count must be PERCEIVABLE, not just painted: the trigger's text is
    // not part of its accessible name (the `<label>` is), so the count rides
    // on `aria-describedby`.
    expect(screen.getByRole("button", { name: LABEL, description: /2/ })).toBeDefined();
  });

  // The single most dangerous failure mode in this component: the popover
  // portals to `document.body`, i.e. OUTSIDE the form. A picker that looked
  // perfect and posted nothing would pass every visual check.
  it("submits every selected id under `name`, in the client list's own order", async () => {
    const user = userEvent.setup();
    const { form } = renderPicker();
    await openPicker(user);

    // Third option first, then the first — the emitted order must not follow
    // click order, exactly like a native `<select multiple>`.
    await user.click(screen.getByRole("option", { name: "beto@example.com" }));
    await user.click(screen.getByRole("option", { name: "Ana Pérez" }));
    await user.keyboard("{Escape}");

    const hidden = form.querySelectorAll<HTMLInputElement>(
      'input[type="hidden"][name="clientIds"]',
    );
    expect([...hidden].map((input) => input.value)).toEqual(["u1", "u3"]);
    expect(new FormData(form).getAll("clientIds")).toEqual(["u1", "u3"]);
  });

  it("never submits on its own — not on a click, not on Enter in the search", async () => {
    const user = userEvent.setup();
    const { submitSpy } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole("option", { name: "Ana Pérez" }));
    await user.keyboard("{Enter}");
    expect(submitSpy).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("moves through the options with the arrow keys and selects with Enter", async () => {
    const user = userEvent.setup();
    renderPicker();
    await openPicker(user);

    const search = screen.getByRole("textbox");
    // Focus stays in the search input; the active row is announced through
    // `aria-activedescendant`, which is why the options themselves are not
    // focusable.
    expect(search.getAttribute("aria-activedescendant")).toBe("picked-opt-u1");

    await user.keyboard("{ArrowDown}");
    expect(search.getAttribute("aria-activedescendant")).toBe("picked-opt-u2");

    await user.keyboard("{Enter}");
    expect(screen.getByRole("option", { name: "ÁLVARO Ruiz" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPicker();
    const trigger = screen.getByLabelText(LABEL);

    await openPicker(user);
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // The trap this guards is subtle and only visible through the real path:
  // React 19 blanks a `<form action>`'s uncontrolled fields with `form.reset()`
  // after a submit, success OR error. React state is invisible to that call, so
  // without the picker's own `reset` listener it would be the ONE field that
  // survived a rejected submit holding selections the photographer no longer
  // sees anywhere else.
  it("clears its selection on the owning form's reset event", async () => {
    const user = userEvent.setup();
    const { form } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole("option", { name: "Ana Pérez" }));
    await user.keyboard("{Escape}");
    expect(form.querySelectorAll('input[name="clientIds"]')).toHaveLength(1);

    act(() => {
      form.reset();
    });

    expect(form.querySelectorAll('input[name="clientIds"]')).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: LABEL, description: "Elegir clientes" }),
    ).toBeDefined();
  });

  // Epic #125's rule 2: "a counter that lies is worse than one that is absent".
  // A page refresh can shrink `clients` (a client stops being eligible); an id
  // that is no longer listed must not post and must not be counted.
  it("drops a selected id that is no longer in the list, from both the count and the form", async () => {
    const user = userEvent.setup();
    const { form, rerender, tree } = renderPicker();
    await openPicker(user);

    await user.click(screen.getByRole("option", { name: "Ana Pérez" }));
    await user.click(screen.getByRole("option", { name: "ÁLVARO Ruiz" }));
    await user.keyboard("{Escape}");
    expect(form.querySelectorAll('input[name="clientIds"]')).toHaveLength(2);

    rerender(tree(CLIENTS.slice(1)));

    const hidden = form.querySelectorAll<HTMLInputElement>(
      'input[type="hidden"][name="clientIds"]',
    );
    expect([...hidden].map((input) => input.value)).toEqual(["u2"]);
    expect(
      screen.getByRole("button", { name: LABEL, description: /1 cliente seleccionado/ }),
    ).toBeDefined();
  });
});
