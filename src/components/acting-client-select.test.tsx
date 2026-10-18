// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActingClientSelect } from "./acting-client-select";

const replace = vi.fn();
let pathname = "/galleries/abc123";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

const MEMBERS = [
  { id: "client-a", label: "Ana" },
  { id: "client b", label: "Beto" },
];

afterEach(() => {
  cleanup();
  replace.mockReset();
  pathname = "/galleries/abc123";
});

describe("ActingClientSelect", () => {
  it("offers 'Nadie (solo mirar)' first, then the active members", () => {
    render(<ActingClientSelect members={MEMBERS} value={null} />);

    const options = [
      ...screen.getByRole("combobox", { name: "Actuar como" }).querySelectorAll("option"),
    ].map((option) => option.textContent);
    expect(options).toEqual(["Nadie (solo mirar)", "Ana", "Beto"]);
  });

  it("writes an encoded ?viewAs= for the chosen client", async () => {
    const user = userEvent.setup();
    render(<ActingClientSelect members={MEMBERS} value={null} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Actuar como" }), "client b");

    expect(replace).toHaveBeenCalledWith("/galleries/abc123?viewAs=client%20b");
  });

  it("clears the parameter for 'Nadie (solo mirar)'", async () => {
    const user = userEvent.setup();
    render(<ActingClientSelect members={MEMBERS} value="client-a" />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Actuar como" }),
      "Nadie (solo mirar)",
    );

    expect(replace).toHaveBeenCalledWith("/galleries/abc123");
  });
});
