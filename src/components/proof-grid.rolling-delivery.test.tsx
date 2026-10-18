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
    isSelected: n <= 5,
    proofUrl: `https://r2.example.com/proof-${n}`,
    hasFinal: n === 1,
    displayUrl: n === 1 ? "https://r2.example.com/display-1" : null,
    isExtra: false,
  }));
}

function entryFor(pick: SelectionPick): SelectionEntry {
  return {
    assetId: pick.assetId,
    claim: {
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
            state: pick.requestedAt ? "billed" : "degraded",
          },
        ]
      : [],
  };
}

function counterFor(picks: SelectionPick[], viewerId: string) {
  const counts = new Map<string, number>();
  for (const pick of picks) {
    if (!pick.pickedBy) continue;
    counts.set(pick.pickedBy.id, (counts.get(pick.pickedBy.id) ?? 0) + 1);
  }
  const own = picks.filter((pick) => pick.pickedBy?.id === viewerId);
  return {
    group: picks.length,
    viewer: {
      yours: own.filter((pick) => pick.requestedAt !== null).length,
      shared: 0,
      toSend: own.filter((pick) => pick.requestedAt === null).length,
    },
    people: [...counts].map(([userId, units]) => ({ userId, label: userId, units })),
    unattributed: picks.filter((pick) => pick.pickedBy === null).length,
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

describe("ProofGrid — rolling delivery (#244)", () => {
  it("freezes exactly the VIEWER's own sent picks, not somebody else's order", () => {
    renderGrid();

    const disabled = [1, 2, 3, 4, 5, 6].filter((n) => tileButton(n).disabled);

    // Only a1/a2 are Ana's sent picks. a5 is Beto's order and a3/a4 are
    // unsent; joining or removing a pick only ever touches the viewer's own
    // `asset_picks` row.
    expect(disabled).toEqual([1, 2]);
  });

  it("labels each pick por enviar / pedida / editada on its tile", () => {
    renderGrid();
    const grid = screen.getAllByRole("list").at(-1)!;

    expect(within(grid).getAllByText("Editada")).toHaveLength(1);
    expect(within(grid).getAllByText("Pedida")).toHaveLength(3);
    expect(within(grid).getAllByText("Por enviar")).toHaveLength(1);
  });

  it("groups the tray into Por enviar and Pedidas, with Editada only where the final is readable", () => {
    renderGrid();
    const tray = screen.getByRole("region", { name: "Fotos elegidas" });

    // The group headings carry their counts; the per-photo status lines do not.
    const headings = Array.from(tray.querySelectorAll("p")).map((p) => p.textContent?.trim());
    expect(headings).toContain("Por enviar (1)");
    expect(headings).toContain("Pedidas (4)");
    // Pedidas holds a1 (Editada), a2 and a5 (Pedida).
    expect(within(tray).getAllByText("Editada")).toHaveLength(1);
    expect(within(tray).getAllByText("Pedida")).toHaveLength(3);
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
    expect(screen.getAllByText(/Último envío:/).length).toBeGreaterThan(0);
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
    await user.click(screen.getByRole("button", { name: "Enviar 1 foto" }));

    await waitFor(() => expect(screen.getAllByText(/Último envío:/).length).toBeGreaterThan(0));
    // a3 is now ordered (frozen); the unpicked a6 and Beto's por-enviar a4 are
    // still open; nothing shows the #239 locked state.
    expect(tileButton(3).disabled).toBe(true);
    expect(tileButton(4).disabled).toBe(false);
    expect(tileButton(6).disabled).toBe(false);
    expect(screen.queryByText(/Enviaste tu selección/)).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar 0 fotos" })).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: "Enviar 1 foto" }));
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar 1 foto" })).toBeTruthy());
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

  // The owner's repro: a pick whose final is readable but that never got a
  // `requested_at` (it was submitted under the classic flow) read "Por enviar".
  it("a pick with a readable final and NO requestedAt reads Editada, on the tile and in the tray (Editada > Pedida > Por enviar)", () => {
    renderGrid({
      initialPicks: PICKS.map((p) => (p.assetId === "a1" ? { ...p, requestedAt: null } : p)),
    });
    const grid = screen.getAllByRole("list").at(-1)!;
    const tray = screen.getByRole("region", { name: "Fotos elegidas" });

    expect(within(grid).getAllByText("Editada")).toHaveLength(1);
    expect(within(grid).getAllByText("Por enviar")).toHaveLength(1);
    expect(within(tray).getAllByText("Editada")).toHaveLength(1);
    const headings = Array.from(tray.querySelectorAll("p")).map((p) => p.textContent?.trim());
    // a1 moved out of "Por enviar" (a3, a4 remain) into "Pedidas" (a1, a2, a5).
    expect(headings).toContain("Por enviar (1)");
    expect(headings).toContain("Pedidas (4)");
  });

  // A member migrated by updateRollingDelivery: unlocked, submitted_at kept.
  // Even a STALE snapshot that still carries their old client-submitted lock
  // must not bring back the classic "enviada/cerrada" copy.
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
    expect(screen.getByRole("button", { name: "Enviar 1 foto" })).toBeTruthy();
  });

  // Review 3: a member who ORDERED (submitted_at set) and was LATER locked by
  // the photographer has the same two timestamps as a classic submit. The
  // server says who locked (`lockedBy`); the client must not guess.
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
    expect(screen.queryByRole("button", { name: /Enviar \d+ foto/ })).toBeNull();
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
