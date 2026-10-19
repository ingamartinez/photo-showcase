// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitConfirmSheet } from "./submit-confirm-sheet";
import type { SubmitProjection } from "@/lib/selection-snapshot";

// Task #268 — the sheet's own promises: the four recap rows and the OQ2
// originals/total rows, the accessible name/description, initial focus on the
// way OUT, Escape and the cancel button closing without a POST, a trapped Tab,
// and the background scroll lock.
const projection: SubmitProjection = {
  passToYou: 2,
  alreadyRequested: 1,
  after: {
    included: 1,
    extras: 3,
    originals: 0,
    extrasSurchargeCop: 15_000,
    originalsSurchargeCop: 0,
    surchargeCop: 15_000,
  },
  extraUnitPriceCop: 5_000,
};

/** The `dd` beside a recap `dt`, with the formatter's NBSP normalised to a
 * plain space (the browser renders it as one; `toBe` would not). */
function row(label: string): string {
  const dt = screen.getByText(label);
  return (dt.parentElement?.querySelector("dd")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function trigger() {
  return <button type="button">Enviar las 5</button>;
}

function sheet(overrides: Partial<Parameters<typeof SubmitConfirmSheet>[0]> = {}) {
  return (
    <SubmitConfirmSheet
      open
      onOpenChange={vi.fn()}
      unsentCount={5}
      includedPhotos={13}
      projection={projection}
      onConfirm={vi.fn()}
      trigger={trigger()}
      {...overrides}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SubmitConfirmSheet — the recap", () => {
  it("renders the four rows with the server's own numbers and formatter", () => {
    render(sheet());

    expect(row("Vas a enviar")).toBe("5 fotos");
    expect(row("Pasan a tu nombre")).toBe("2");
    expect(row("Ya las pidió otra persona")).toBe("1");
    expect(row("Extra sobre las 13 incluidas, al enviar")).toBe("3 × $ 5.000 = $ 15.000");
  });

  it("uses the singulars for one photo", () => {
    render(sheet({ unsentCount: 1 }));

    expect(screen.getByText("¿Envías esta foto?")).toBeDefined();
    expect(row("Vas a enviar")).toBe("1 foto");
    expect(screen.getByRole("button", { name: "Sí, enviar la foto" })).toBeDefined();
  });

  it("adds an originals row, and a total row only when extras and originals coexist", () => {
    render(
      sheet({
        projection: {
          ...projection,
          after: {
            ...projection.after,
            originals: 2,
            originalsSurchargeCop: 4_000,
            surchargeCop: 19_000,
          },
        },
      }),
    );

    expect(row("Originales, al enviar")).toBe("2 originales · $ 4.000");
    expect(row("Total, al enviar")).toBe("$ 19.000");
  });

  it("omits the originals and total rows when there are no originals", () => {
    render(sheet());

    expect(screen.queryByText("Originales, al enviar")).toBeNull();
    expect(screen.queryByText("Total, al enviar")).toBeNull();
  });

  it("omits the projection rows entirely when there is no subject", () => {
    render(sheet({ projection: null }));

    expect(screen.queryByText("Pasan a tu nombre")).toBeNull();
    expect(screen.queryByText("Ya las pidió otra persona")).toBeNull();
    // The send itself is still described.
    expect(screen.getByText("Vas a enviar")).toBeDefined();
  });

  it("is named by its title and described by the warning block", () => {
    render(sheet());

    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("¿Envías estas 5?");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "Lo que envíes ya no lo puedes sacar tú.",
    );
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "escríbele a tu fotógrafo",
    );
  });
});

describe("SubmitConfirmSheet — focus and dismissal", () => {
  it("puts initial focus on 'Seguir eligiendo', never on the send button", async () => {
    render(sheet());

    await waitFor(() => expect(document.activeElement?.textContent).toBe("Seguir eligiendo"));
  });

  it("closes on Escape without confirming", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(sheet({ onOpenChange, onConfirm }));

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes with 'Seguir eligiendo' without confirming", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(sheet({ onOpenChange, onConfirm }));

    await user.click(screen.getByRole("button", { name: "Seguir eligiendo" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(sheet());
    const dialog = screen.getByRole("dialog");

    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("SubmitConfirmSheet — scroll lock", () => {
  it("locks the body while open and restores it on close", () => {
    const { rerender } = render(sheet());
    expect(document.body.style.overflow).toBe("hidden");

    rerender(sheet({ open: false }));
    expect(document.body.style.overflow).toBe("");
  });
});
