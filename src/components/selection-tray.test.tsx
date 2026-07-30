// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectionTray } from "./selection-tray";
import type { SelectionPick } from "@/lib/selection-snapshot";

function pick(overrides: Partial<SelectionPick> = {}): SelectionPick {
  return {
    assetId: "a1",
    selectedAt: "2026-07-30T12:00:00.000Z",
    pickedBy: { id: "client-b", label: "Beto Ruiz" },
    ...overrides,
  };
}

function renderTray(overrides: Partial<ComponentProps<typeof SelectionTray>> = {}) {
  return render(
    <SelectionTray
      picks={[]}
      urls={{ a1: "https://r2.example.com/a1", a2: "https://r2.example.com/a2" }}
      filenamesByAssetId={{ a1: "IMG_0001.JPG", a2: "IMG_0002.JPG" }}
      viewerId="client-a"
      isLocked={false}
      isStale={false}
      onOpenAsset={() => {}}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SelectionTray", () => {
  it("stays visible with an explanation before anybody has picked anything", () => {
    // Decided rather than defaulted (task #95): a tray that materialised on
    // the first pick would shove the grid down the page at the exact moment
    // the client is aiming at a thumbnail, and a client who never sees it
    // beforehand has no idea their partner's picks will appear there.
    renderTray({ picks: [] });

    expect(screen.getByRole("region", { name: "Fotos elegidas" })).toBeDefined();
    expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();
  });

  it("shows each pick's thumbnail from the grid's own presigned URL map", () => {
    // Never a URL of its own: R2 objects stay private and there is exactly
    // one way to obtain bytes for an asset.
    const { container } = renderTray({ picks: [pick({ assetId: "a1" })] });

    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://r2.example.com/a1");
  });

  it("attributes another client's pick by name", () => {
    renderTray({ picks: [pick({ pickedBy: { id: "client-b", label: "Beto Ruiz" } })] });

    expect(screen.getByText("Beto Ruiz")).toBeDefined();
  });

  it("attributes the viewer's own pick as 'Vos'", () => {
    renderTray({ picks: [pick({ pickedBy: { id: "client-a", label: "Ana Pérez" } })] });

    expect(screen.getByText("Vos")).toBeDefined();
    expect(screen.queryByText("Ana Pérez")).toBeNull();
  });

  it("admits it does not know, rather than guessing, for a pick with no attribution", () => {
    renderTray({ picks: [pick({ pickedBy: null })] });

    expect(screen.getByText("Sin registro")).toBeDefined();
  });

  it("names the picker in each thumbnail's accessible label, not only visually", () => {
    renderTray({ picks: [pick({ assetId: "a1", pickedBy: { id: "client-b", label: "Beto" } })] });

    expect(
      screen.getByRole("button", { name: "Ver IMG_0001.JPG, elegida por Beto" }),
    ).toBeDefined();
  });

  it("renders the picks in the order it was given, oldest first", () => {
    renderTray({
      picks: [
        pick({ assetId: "a1", pickedBy: { id: "client-b", label: "Beto" } }),
        pick({ assetId: "a2", pickedBy: { id: "client-a", label: "Ana" } }),
      ],
    });

    const labels = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(labels).toEqual(["Beto", "Vos"]);
  });

  it("opens the lightbox for the clicked pick rather than changing the selection", async () => {
    // The one control that changes the shared selection stays on the tile in
    // the grid, where it has been since task #24 — the tray is a view.
    const onOpenAsset = vi.fn();
    renderTray({ picks: [pick({ assetId: "a2" })], onOpenAsset });

    await userEvent.click(screen.getByRole("button", { name: /IMG_0002\.JPG/ }));

    expect(onOpenAsset).toHaveBeenCalledWith("a2");
  });

  it("degrades to a labelled placeholder, not a broken image, for a pick this page never rendered", () => {
    // An asset the photographer uploaded after this page was rendered is in
    // the snapshot but has no presigned URL here. Stale-but-honest.
    const { container } = renderTray({ picks: [pick({ assetId: "unknown-asset" })] });

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText(/recargá para verla/i)).toBeDefined();
  });

  it("says the selection is already submitted once the gallery is locked", () => {
    renderTray({ picks: [pick()], isLocked: true });

    expect(screen.getByText(/la selección ya fue enviada/i)).toBeDefined();
    expect(screen.queryByText(/se actualiza sola/i)).toBeNull();
  });

  it("warns that the list may be out of date when the live connection is failing — WITHOUT hiding it", () => {
    // Stale-but-honest beats silently-wrong (task #95's own acceptance
    // criterion): the picks below the warning are the last thing the server
    // actually said, and blanking them would be strictly less useful.
    renderTray({ picks: [pick({ pickedBy: { id: "client-b", label: "Beto" } })], isStale: true });

    expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();
    expect(screen.getByText("Beto")).toBeDefined();
  });

  it("shows no connection warning while the live channel is healthy", () => {
    renderTray({ picks: [pick()], isStale: false });

    expect(screen.queryByText(/se perdió la conexión/i)).toBeNull();
  });

  it("announces changes politely, so a pick arriving from another session is not silent", () => {
    const { container } = renderTray({ picks: [pick()] });

    expect(container.querySelector("section")?.getAttribute("aria-live")).toBe("polite");
  });
});
