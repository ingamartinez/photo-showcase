// @vitest-environment jsdom
//
// Task #244 — the CLIENT side of rolling delivery: finals show as soon as they
// are readable, picks split into "Por enviar" and "Pedidas", and "Enviar"
// places an order instead of locking. The fixture is a GROUP gallery with
// DISTINCT picks and finals on only SOME of them, because a uniform fixture
// cannot tell "this pick is frozen because it was ordered" from "everything is
// frozen" (the identity bug the #239 suite documents).
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProofGrid } from "./proof-grid";
import type { ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import type { SelectionPick } from "@/lib/selection-snapshot";

const TERMS = {
  includedPhotosSnapshot: 0,
  extraPhotoPriceCopSnapshot: 9_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 0,
};

const ANA = { id: "client-a", label: "Ana Pérez" };
const BETO = { id: "client-b", label: "Beto Ruiz" };
const ORDERED_AT = "2026-10-16T09:00:00.000Z";

function pick(
  assetId: string,
  pickedBy: { id: string; label: string },
  requestedAt: string | null,
): SelectionPick {
  return {
    assetId,
    selectedAt: "2026-10-16T08:00:00.000Z",
    pickedBy,
    selectionKind: "edited",
    requestedAt,
  };
}

// a1: Ana, ordered, final READY      -> "Editada"
// a2: Ana, ordered, no final yet     -> "Pedida"
// a3: Ana, still por enviar          -> removable
// a4: Beto, still por enviar         -> removable by anyone (shared board)
// a5: Beto, ordered, no final        -> "Pedida"
// a6: nobody picked it
const PICKS = [
  pick("a1", ANA, ORDERED_AT),
  pick("a2", ANA, ORDERED_AT),
  pick("a3", ANA, null),
  pick("a4", BETO, null),
  pick("a5", BETO, ORDERED_AT),
];

function assets(): ProofAsset[] {
  return [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `a${n}`,
    originalFilename: `IMG_000${n}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: n <= 5,
    proofUrl: `https://r2.example.com/proof-${n}`,
    hasFinal: n === 1,
    displayUrl: n === 1 ? "https://r2.example.com/display-1" : null,
    isExtra: false,
  }));
}

function renderGrid(overrides: Partial<ComponentProps<typeof ProofGrid>> = {}) {
  return render(
    <ProofGrid
      galleryId="g1"
      initialAssets={assets()}
      initialStatus="proofing"
      initialSubmittedAt={null}
      initialPicks={PICKS}
      viewerId={ANA.id}
      {...TERMS}
      selectionTrayMode="flat"
      allowsOriginalSelection={false}
      rollingDelivery
      finalsOpen
      {...overrides}
    />,
  );
}

function tileButton(n: number) {
  const name = `IMG_000${n}.JPG`;
  return (screen.queryByRole("button", { name: `Quitar de seleccionadas: ${name}` }) ??
    screen.getByRole("button", { name: `Seleccionar: ${name}` })) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProofGrid — rolling delivery (#244)", () => {
  it("freezes exactly the ORDERED picks (any picker's) and leaves por-enviar picks and unpicked photos interactive", () => {
    renderGrid();

    const disabled = [1, 2, 3, 4, 5, 6].filter((n) => tileButton(n).disabled);

    // a1, a2 (Ana's orders) and a5 (Beto's order); NOT a3/a4 (por enviar) and
    // NOT a6 (unpicked).
    expect(disabled).toEqual([1, 2, 5]);
  });

  it("labels each pick por enviar / pedida / editada on its tile", () => {
    renderGrid();
    const grid = screen.getAllByRole("list").at(-1)!;

    expect(within(grid).getAllByText("Editada")).toHaveLength(1);
    expect(within(grid).getAllByText("Pedida")).toHaveLength(2);
    expect(within(grid).getAllByText("Por enviar")).toHaveLength(2);
  });

  it("groups the tray into Por enviar and Pedidas, with Editada only where the final is readable", () => {
    renderGrid();
    const tray = screen.getByRole("region", { name: "Fotos elegidas" });

    // The group headings carry their counts; the per-photo status lines do not.
    const headings = Array.from(tray.querySelectorAll("p")).map((p) => p.textContent?.trim());
    expect(headings).toContain("Por enviar (2)");
    expect(headings).toContain("Pedidas (3)");
    // Pedidas holds a1 (Editada), a2 and a5 (Pedida).
    expect(within(tray).getAllByText("Editada")).toHaveLength(1);
    expect(within(tray).getAllByText("Pedida")).toHaveLength(2);
  });

  it("offers the readable final's download and a zip of exactly the readable finals", () => {
    renderGrid();

    expect(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Descargar: IMG_0002.JPG" })).toBeNull();
    expect(screen.getByText(/1 foto editada ya disponible/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Descargar todo/ })).toBeTruthy();
  });

  it("shows the unwatermarked display derivative for the readable final and proofs for the rest", () => {
    renderGrid();
    const srcs = Array.from(document.querySelectorAll("li img")).map((img) =>
      img.getAttribute("src"),
    );

    expect(srcs).toContain("https://r2.example.com/display-1");
    expect(srcs).toContain("https://r2.example.com/proof-2");
    expect(srcs).not.toContain("https://r2.example.com/proof-1");
  });

  it("the submit button counts only THIS person's por-enviar photos, and shows the last send", () => {
    renderGrid({ initialViewerSubmittedAt: ORDERED_AT });

    // Ana has one por enviar (a3); Beto's a4 does not count for her.
    expect(screen.getByRole("button", { name: "Enviar 1 foto" })).toBeTruthy();
    expect(screen.getByText(/Último envío:/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
  });

  it("disables the submit button at zero por enviar", () => {
    renderGrid({
      initialPicks: PICKS.filter((p) => p.requestedAt !== null || p.pickedBy?.id !== ANA.id),
    });

    expect(
      (screen.getByRole("button", { name: "Enviar 0 fotos" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("submitting orders the por-enviar photos WITHOUT locking: the grid stays interactive and the order is shown", async () => {
    vi.stubGlobal("confirm", () => true);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "submitted",
        quota: computeQuota(5, 0, TERMS),
        submittedAt: "2026-10-16T12:00:00.000Z",
        gallerySelected: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderGrid();

    fireEvent.click(screen.getByRole("button", { name: "Enviar 1 foto" }));

    await waitFor(() => expect(screen.getByText(/Último envío:/)).toBeTruthy());
    // a3 is now ordered (frozen); the unpicked a6 and Beto's por-enviar a4 are
    // still open; nothing shows the #239 locked state.
    expect(tileButton(3).disabled).toBe(true);
    expect(tileButton(4).disabled).toBe(false);
    expect(tileButton(6).disabled).toBe(false);
    expect(screen.queryByText(/Enviaste tu selección/)).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar 0 fotos" })).toBeTruthy();
  });

  it("explains a refused removal of an ordered photo in the owner's words", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "already_requested" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderGrid();

    fireEvent.click(tileButton(3));

    await waitFor(() =>
      expect(
        screen.getAllByText("Esta foto ya fue pedida; para quitarla escríbele a tu fotógrafo.")
          .length,
      ).toBeGreaterThan(0),
    );
  });

  it('never uses the word "carrito" anywhere in the rendered client UI', () => {
    renderGrid({ initialViewerSubmittedAt: ORDERED_AT });

    expect(document.body.textContent ?? "").not.toMatch(/carrito/i);
  });

  it("an admin preview of a DRAFT gallery with the flag on shows no finals UI (the page says finals are closed)", () => {
    renderGrid({ initialStatus: "draft", finalsOpen: false, isAdminPreview: true });

    expect(screen.queryByRole("button", { name: /Descargar:/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Descargar todo/ })).toBeNull();
    expect(screen.queryByText("Editada")).toBeNull();
    expect(screen.queryByText(/editada ya disponible/)).toBeNull();
  });

  it("flag OFF: no order labels, no download in proofing, locked-submit copy untouched", () => {
    renderGrid({
      rollingDelivery: false,
      initialAssets: assets().map((asset) => ({ ...asset, hasFinal: false, displayUrl: null })),
    });

    expect(screen.queryByText("Por enviar")).toBeNull();
    expect(screen.queryByText("Pedida")).toBeNull();
    expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar selección" })).toBeTruthy();
  });
});
