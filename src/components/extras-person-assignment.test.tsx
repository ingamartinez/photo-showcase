// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ExtrasPersonAssignment,
  type ExtraItem,
  type ExtraPerson,
} from "@/components/extras-person-assignment";
import type { AssignExtraToPersonState } from "@/app/dashboard/galleries/actions";

// The server action is mocked at the module boundary — same shape
// selection-tray-mode-control.test.tsx uses for its own action. This suite
// owns the COMPONENT: what it renders, when it renders nothing, and what it
// actually submits. The action's own rules (membership, isExtra, the billing
// boundary) are covered in actions.assign-extra.test.ts.
const actionMock =
  vi.fn<
    (state: AssignExtraToPersonState, formData: FormData) => Promise<AssignExtraToPersonState>
  >();
vi.mock("@/app/dashboard/galleries/actions", () => ({
  assignExtraToPerson: (...args: [AssignExtraToPersonState, FormData]) => actionMock(...args),
}));

const PEOPLE: ExtraPerson[] = [
  { id: "u-ana", label: "Ana Pérez" },
  { id: "u-beto", label: "Beto Gómez" },
];

function extra(overrides: Partial<ExtraItem> = {}): ExtraItem {
  return {
    id: "a1",
    originalFilename: "DSC_0001.JPG",
    deliveredFor: null,
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  actionMock.mockReset();
  actionMock.mockResolvedValue({ status: "updated" });
});

describe("ExtrasPersonAssignment", () => {
  it("submits the chosen person together with the asset id", async () => {
    const user = userEvent.setup();
    render(<ExtrasPersonAssignment extras={[extra()]} people={PEOPLE} />);

    await user.selectOptions(screen.getByLabelText("DSC_0001.JPG"), "u-beto");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(actionMock).toHaveBeenCalledTimes(1);
    const [, formData] = actionMock.mock.calls[0] as [AssignExtraToPersonState, FormData];
    expect(formData.get("assetId")).toBe("a1");
    expect(formData.get("deliveredFor")).toBe("u-beto");
  });

  // The "clear it" path has to be as reachable as setting one — an admin who
  // attributed the wrong person must be able to undo it, and a `<select>`
  // cannot submit a real `null`.
  it("submits an empty value for 'Sin asignar', which the action reads as clearing it", async () => {
    const user = userEvent.setup();
    render(<ExtrasPersonAssignment extras={[extra({ deliveredFor: "u-ana" })]} people={PEOPLE} />);

    await user.selectOptions(screen.getByLabelText("DSC_0001.JPG"), "");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const [, formData] = actionMock.mock.calls[0] as [AssignExtraToPersonState, FormData];
    expect(formData.get("deliveredFor")).toBe("");
  });

  it("starts each row on the person already assigned to it", () => {
    render(
      <ExtrasPersonAssignment
        extras={[
          extra({ id: "a1", originalFilename: "ONE.JPG", deliveredFor: "u-beto" }),
          extra({ id: "a2", originalFilename: "TWO.JPG", deliveredFor: null }),
        ]}
        people={PEOPLE}
      />,
    );

    expect((screen.getByLabelText("ONE.JPG") as HTMLSelectElement).value).toBe("u-beto");
    // An unattributed extra shows "Sin asignar", NOT whichever client happens
    // to sort first — a wrong name is worse than an admitted blank.
    expect((screen.getByLabelText("TWO.JPG") as HTMLSelectElement).value).toBe("");
  });

  // One form per row: assigning a person to ONE photo must not re-submit
  // every other row's attribution along with it.
  it("submits only the row whose button was pressed", async () => {
    const user = userEvent.setup();
    render(
      <ExtrasPersonAssignment
        extras={[
          extra({ id: "a1", originalFilename: "ONE.JPG" }),
          extra({ id: "a2", originalFilename: "TWO.JPG" }),
        ]}
        people={PEOPLE}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "Guardar" })[1]!);

    expect(actionMock).toHaveBeenCalledTimes(1);
    const [, formData] = actionMock.mock.calls[0] as [AssignExtraToPersonState, FormData];
    expect(formData.get("assetId")).toBe("a2");
  });

  it("renders nothing when there are no extras", () => {
    const { container } = render(<ExtrasPersonAssignment extras={[]} people={PEOPLE} />);
    expect(container.innerHTML).toBe("");
  });

  // Reachable: a gallery can carry extras while having no attached clients
  // (a draft that was never attached). An empty picker there reads as a
  // broken control rather than an absent one.
  it("renders nothing when the gallery has no people to assign to", () => {
    const { container } = render(<ExtrasPersonAssignment extras={[extra()]} people={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("surfaces the action's own error message", async () => {
    actionMock.mockResolvedValue({
      status: "error",
      message: "Esa persona no es cliente de esta galería.",
    });
    const user = userEvent.setup();
    render(<ExtrasPersonAssignment extras={[extra()]} people={PEOPLE} />);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Esa persona no es cliente de esta galería.",
    );
  });
});
