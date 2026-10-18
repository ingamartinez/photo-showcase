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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofGrid } from "./proof-grid";
import type { ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import type { SelectionEntry, SelectionKind } from "@/lib/selection-snapshot";

type SelectionPick = {
  assetId: string;
  selectedAt: string | null;
  pickedBy: { id: string; label: string } | null;
  selectionKind: SelectionKind;
  requestedAt?: string | null;
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

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
    isSelected: n === 1 || n === 2 || n === 5,
    proofUrl: `https://r2.example.com/proof-${n}`,
    hasFinal: n === 1,
    displayUrl: n === 1 ? "https://r2.example.com/display-1" : null,
    isExtra: false,
  }));
}

function entryFor(pick: SelectionPick): SelectionEntry {
  return {
    assetId: pick.assetId,
    claim:
      pick.requestedAt === null
        ? null
        : {
            claimedAt: pick.selectedAt,
            resolvedKind: pick.selectionKind,
            billedTo: pick.pickedBy,
            charge: "included",
          },
    picks: pick.pickedBy
      ? [
          {
            userId: pick.pickedBy.id,
            label: pick.pickedBy.label,
            kind: pick.selectionKind,
            pickedAt: pick.selectedAt ?? "2026-10-16T08:00:00.000Z",
            submittedAt: pick.requestedAt ?? null,
            state: pick.requestedAt ? "billed" : "cart",
          },
        ]
      : [],
  };
}

function counterFor(picks: SelectionPick[], viewerId: string) {
  const claimed = picks.filter((pick) => pick.requestedAt !== null && pick.pickedBy);
  const counts = new Map<string, number>();
  for (const pick of claimed) {
    counts.set(pick.pickedBy!.id, (counts.get(pick.pickedBy!.id) ?? 0) + 1);
  }
  const own = picks.filter((pick) => pick.pickedBy?.id === viewerId);
  return {
    group: claimed.length,
    viewer: {
      yours: own.filter((pick) => pick.requestedAt !== null).length,
      shared: 0,
      toSend: own.filter((pick) => pick.requestedAt === null).length,
    },
    people: [...counts].map(([userId, units]) => ({ userId, label: userId, units })),
    unattributed: 0,
  };
}

function renderGrid(
  overrides: Partial<ComponentProps<typeof ProofGrid>> & {
    initialPicks?: SelectionPick[];
    initialLockedPickerIds?: string[];
    initialSubmittedPickerIds?: string[];
  } = {},
) {
  const {
    initialPicks = PICKS,
    initialLockedPickerIds = [],
    initialSubmittedPickerIds: _legacySubmitted,
    ...rest
  } = overrides;
  return render(
    <ProofGrid
      galleryId="g1"
      initialAssets={assets()}
      initialStatus="proofing"
      initialSubmittedAt={null}
      initialEntries={initialPicks.map(entryFor)}
      initialQuota={computeQuota(initialPicks.length, 0, TERMS)}
      initialCounter={counterFor(initialPicks, ANA.id)}
      initialAdminLockedPickerIds={initialLockedPickerIds}
      viewerId={ANA.id}
      selectionTrayMode="flat"
      allowsOriginalSelection={false}
      rollingDelivery
      finalsOpen
      {...rest}
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

describe("ProofGrid — rolling delivery (#244), now on universal order semantics", () => {
  it("freezes exactly the VIEWER's own sent picks, not somebody else's order", () => {
    renderGrid();

    const disabled = [1, 2, 3, 4, 5, 6].filter((n) => tileButton(n).disabled);

    // Only a1/a2 are Ana's sent picks. a5 is Beto's order, a3/a4 are unsent
    // carts, and joining or removing only ever touches the viewer's own row.
    expect(disabled).toEqual([1, 2]);
  });

  it("labels every tile from the viewer's state: Editada > Por enviar (own cart) > Pedida", () => {
    renderGrid();
    const grid = screen.getAllByRole("list").at(-1)!;

    expect(within(grid).getAllByText("Editada")).toHaveLength(1); // a1
    expect(within(grid).getAllByText("Pedida")).toHaveLength(2); // a2, a5
    expect(within(grid).getAllByText("Por enviar")).toHaveLength(1); // a3
  });

  it("groups the tray into Por enviar and Pedidas for every gallery, with Editada only where the final is readable", () => {
    renderGrid();
    const tray = screen.getByRole("region", { name: "Fotos elegidas" });

    const headings = Array.from(tray.querySelectorAll("p")).map((p) => p.textContent?.trim());
    expect(headings).toContain("Por enviar (1)");
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

  it("counts only THIS person's por-enviar photos and shows the last send", () => {
    renderGrid({ initialViewerSubmittedAt: ORDERED_AT });

    // Ana has one por enviar (a3); Beto's a4 does not count for her.
    expect(screen.getByRole("button", { name: "Enviar la foto" })).toBeTruthy();
    expect(screen.getAllByText(/Último envío:/).length).toBeGreaterThan(0);
  });

  it("disables the submit button at zero por enviar", () => {
    renderGrid({
      initialPicks: PICKS.filter((p) => p.requestedAt !== null || p.pickedBy?.id !== ANA.id),
    });

    expect(
      (screen.getByRole("button", { name: "Enviar las 0" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("submitting orders the por-enviar photos WITHOUT locking: the grid stays interactive and the order is shown", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const afterPicks = PICKS.map((p) =>
      p.assetId === "a3" ? { ...p, requestedAt: ORDERED_AT } : p,
    );
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/submit-selection")) {
        return Promise.resolve(
          jsonResponse(200, {
            status: "submitted",
            quota: computeQuota(5, 0, TERMS),
            submittedAt: "2026-10-16T12:00:00.000Z",
            gallerySelected: false,
            requestedCount: 1,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          status: "proofing",
          submittedAt: null,
          entries: afterPicks.map(entryFor),
          counter: counterFor(afterPicks, ANA.id),
          quota: computeQuota(5, 0, TERMS),
          viewerLock: null,
          adminLockedPickerIds: [],
          viewerSubmittedAt: "2026-10-16T12:00:00.000Z",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    renderGrid();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Enviar la foto" }));

    await waitFor(() => expect(screen.getAllByText(/Último envío:/).length).toBeGreaterThan(0));
    // a3 is now ordered (frozen); the unpicked a6 and Beto's por-enviar a4 are
    // still open; nothing shows the #239 locked state.
    expect(tileButton(3).disabled).toBe(true);
    expect(tileButton(4).disabled).toBe(false);
    expect(tileButton(6).disabled).toBe(false);
    expect(screen.queryByText(/Enviaste tu selección/)).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar las 0" })).toBeTruthy();
  });

  it("an idempotent already_submitted 200 (nothing stamped) does NOT mark the por-enviar photos as ordered", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/submit-selection")) {
          return Promise.resolve(
            jsonResponse(200, {
              status: "already_submitted",
              quota: computeQuota(5, 0, TERMS),
              submittedAt: "2026-10-16T12:00:00.000Z",
              gallerySelected: false,
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            status: "proofing",
            submittedAt: null,
            entries: PICKS.map(entryFor),
            counter: counterFor(PICKS, ANA.id),
            quota: computeQuota(5, 0, TERMS),
            viewerLock: null,
            adminLockedPickerIds: [],
            viewerSubmittedAt: null,
          }),
        );
      }),
    );
    renderGrid();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar la foto" }));
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Enviar la foto" })).toBeTruthy(),
    );
    expect(tileButton(3).disabled).toBe(false);
    expect(screen.queryByText(/Último envío:/)).toBeNull();
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

  it("a pick with a readable final and NO requestedAt reads Editada, on the tile and in the tray", () => {
    renderGrid({
      initialPicks: PICKS.map((p) => (p.assetId === "a1" ? { ...p, requestedAt: null } : p)),
    });
    const grid = screen.getAllByRole("list").at(-1)!;
    const tray = screen.getByRole("region", { name: "Fotos elegidas" });

    expect(within(grid).getAllByText("Editada")).toHaveLength(1);
    expect(within(grid).getAllByText("Por enviar")).toHaveLength(1);
    expect(within(tray).getAllByText("Editada")).toHaveLength(1);
    const headings = Array.from(tray.querySelectorAll("p")).map((p) => p.textContent?.trim());
    // Task #267 — this expectation USED to read "Por enviar (1)" / "Pedidas
    // (3)", pinning the very exclusion the owner reported as a bug: a1's
    // pick is unsent, so submit sends it, so it belongs to "Por enviar" even
    // though its final is already readable. The readable tag survives (it
    // still says "Editada", which is true and useful), but the SECTION is
    // decided by whether the viewer still has to send, not by the final.
    expect(headings).toContain("Por enviar (2)"); // a1 + a3
    expect(headings).toContain("Pedidas (2)"); // a2 + a5
  });

  // Task #267 — the owner's live report, reproduced as a fixture: the
  // counter says "4 por enviar", the button says "Enviar las 4", and the tray
  // listed "Por enviar (2)". The two missing ones were unsent picks on assets
  // that another client had already ordered and whose final was therefore
  // readable — excluded from `unsent` by the readable check and folded into
  // "Pedidas" (or, on a gallery with no claim at all, nowhere). The tray's
  // group must hold EXACTLY what submit sends.
  it("lists in 'Por enviar' every pick the Enviar button counts, readable finals included", () => {
    const picks = [
      pick("a1", ANA, null), // readable final, still unsent
      pick("a2", ANA, null), // readable final, still unsent
      pick("a3", ANA, null), // no final at all
      pick("a4", ANA, null), // no final at all
    ];
    renderGrid({
      initialPicks: picks,
      initialAssets: [1, 2, 3, 4].map((n) => ({
        id: `a${n}`,
        originalFilename: `IMG_000${n}.JPG`,
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: false,
        proofUrl: `https://r2.example.com/proof-${n}`,
        hasFinal: n === 1 || n === 2,
        displayUrl: n === 1 || n === 2 ? `https://r2.example.com/display-${n}` : null,
        isExtra: false,
      })),
      initialCounter: counterFor(picks, ANA.id),
    });

    const tray = screen.getByRole("region", { name: "Fotos elegidas" });
    const headings = Array.from(tray.querySelectorAll("p")).map((p) => p.textContent?.trim());
    expect(headings).toContain("Por enviar (4)");
    // Nothing is claimed yet, so there is no "Pedidas" section to fold them
    // into — the pre-fix bug hid them outright in exactly this shape.
    expect(headings.some((heading) => heading?.startsWith("Pedidas") ?? false)).toBe(false);
    // One row per pick: no duplication into a second section either.
    expect(within(tray).getAllByRole("listitem")).toHaveLength(4);

    // The bar's own count is the server's `counter.viewer.toSend`; the tray
    // header must agree with it, which is the whole point of the fix.
    const counterLine = screen
      .getByText(/entre todos/)
      .closest("p")
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    expect(counterLine).toContain("4 por enviar");
    expect(screen.getByRole("button", { name: "Enviar las 4" })).toBeTruthy();
  });

  it("a client-submitted member never sees the classic enviada/cerrada copy, even with a stale viewerLock", () => {
    const stale = {
      lockedAt: "2026-10-10T10:00:00.000Z",
      submittedAt: "2026-10-10T10:00:00.000Z",
      lockedBy: "client" as const,
    };
    renderGrid({
      initialViewerLock: stale,
      initialLockedPickerIds: [ANA.id],
      initialSubmittedPickerIds: [ANA.id],
      initialViewerSubmittedAt: stale.submittedAt,
    });
    const text = document.body.textContent ?? "";

    expect(text).not.toMatch(/ya fue enviada|quedó cerrada|cerrada|Enviaste tu selección/i);
    expect(text).not.toContain("¿Qué pasa ahora?");
    expect(text).toMatch(/Último envío/);
    expect(text).toMatch(/seguir eligiendo/);
    expect(tileButton(3).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Enviar la foto" })).toBeTruthy();
  });

  it("a member who ordered and was then locked by the photographer keeps the photographer-locked copy and frozen tiles", () => {
    renderGrid({
      initialViewerLock: {
        lockedAt: "2026-10-13T10:00:00.000Z",
        submittedAt: "2026-10-12T10:00:00.000Z",
        lockedBy: "admin",
      },
      initialLockedPickerIds: [ANA.id],
      initialSubmittedPickerIds: [],
      initialViewerSubmittedAt: "2026-10-12T10:00:00.000Z",
    });
    const text = document.body.textContent ?? "";

    expect(text).toMatch(/Tu fotógrafo cerró tu selección/);
    expect([1, 2, 3, 4, 5, 6].filter((n) => tileButton(n).disabled)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(screen.queryByRole("button", { name: /^Enviar/ })).toBeNull();
  });

  it("an ADMIN-locked member under the flag still gets the photographer-locked copy", () => {
    renderGrid({
      initialViewerLock: {
        lockedAt: "2026-10-11T10:00:00.000Z",
        submittedAt: null,
        lockedBy: "admin",
      },
      initialLockedPickerIds: [ANA.id],
    });
    const text = document.body.textContent ?? "";

    expect(text).toMatch(/Tu fotógrafo cerró tu selección/);
    expect(tileButton(3).disabled).toBe(true);
  });

  it("flag OFF still uses the universal order split, but shows no finals UI in proofing", () => {
    renderGrid({
      rollingDelivery: false,
      initialAssets: assets().map((asset) => ({ ...asset, hasFinal: false, displayUrl: null })),
    });

    // Order semantics are mandatory now; only the finals half of the flag is
    // opt-in (epic #250 decision 11).
    expect(screen.getAllByText("Por enviar").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pedida").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar la foto" })).toBeTruthy();
  });
});
