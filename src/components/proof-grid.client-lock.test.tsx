// @vitest-environment jsdom
//
// Epic #239 / task #241 — the CLIENT side of the per-person selection lock.
// Every fixture here is a GROUP gallery with three clients and DISTINCT picks
// (Ana = the viewer, Beto = locked, Carla = still choosing), because a uniform
// fixture ("everybody picked the same") cannot tell "this tile is frozen
// because Beto submitted" from "every tile is frozen" — the identity bug this
// suite exists to catch.
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProofGrid, SELECTION_POLL_INTERVAL_MS } from "./proof-grid";
import type { GalleryStatus, ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import type { SelectionPick, ViewerLock } from "@/lib/selection-snapshot";

const TERMS = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ANA = { id: "client-a", label: "Ana Pérez" };
const BETO = { id: "client-b", label: "Beto Ruiz" };
const CARLA = { id: "client-c", label: "Carla Gil" };

function pick(assetId: string, pickedBy: { id: string; label: string }): SelectionPick {
  return {
    assetId,
    selectedAt: "2026-10-15T12:00:00.000Z",
    pickedBy,
    selectionKind: "edited",
  };
}

// a1 -> Ana (viewer), a2 -> Beto, a3 -> Carla, a4 -> nobody.
const PICKS = [pick("a1", ANA), pick("a2", BETO), pick("a3", CARLA)];

function assets(): ProofAsset[] {
  return [1, 2, 3, 4].map((n) => ({
    id: `a${n}`,
    originalFilename: `IMG_000${n}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: n <= 3,
    proofUrl: `https://r2.example.com/original-${n}`,
    hasFinal: false,
    displayUrl: null,
    isExtra: false,
  }));
}

const VIEWER_LOCK: ViewerLock = {
  lockedAt: "2026-10-15T13:00:00.000Z",
  submittedAt: "2026-10-15T13:00:00.000Z",
};

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
      selectionTrayMode="by-person"
      allowsOriginalSelection={true}
      {...overrides}
    />,
  );
}

/** What `GET /api/galleries/[galleryId]/selection` returns. */
function snapshotBody(
  overrides: {
    status?: GalleryStatus;
    picks?: SelectionPick[];
    viewerLock?: ViewerLock | null;
    lockedPickerIds?: string[];
    submittedPickerIds?: string[];
  } = {},
) {
  const picks = overrides.picks ?? PICKS;
  return {
    status: overrides.status ?? "proofing",
    submittedAt: null,
    quota: computeQuota(picks.length, 0, TERMS),
    picks,
    viewerLock: overrides.viewerLock ?? null,
    lockedPickerIds: overrides.lockedPickerIds ?? [],
    submittedPickerIds: overrides.submittedPickerIds ?? overrides.lockedPickerIds ?? [],
  };
}

/** The per-tile pick button. */
function tileButton(n: number) {
  const name = `IMG_000${n}.JPG`;
  return (screen.queryByRole("button", { name: `Quitar de seleccionadas: ${name}` }) ??
    screen.getByRole("button", { name: `Seleccionar: ${name}` })) as HTMLButtonElement;
}

function disabledTiles(): number[] {
  return [1, 2, 3, 4].filter((n) => tileButton(n).disabled);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProofGrid — per-person lock (epic #239, task #241)", () => {
  describe("viewer locked, gallery still proofing", () => {
    it("disables EVERY tile and offers no submit button", () => {
      renderGrid({
        initialViewerLock: VIEWER_LOCK,
        initialLockedPickerIds: [ANA.id],
      });

      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
    });

    it("says THEIR selection was sent and the group is still choosing, never that the photographer has 'la selección'", () => {
      renderGrid({
        initialViewerLock: VIEWER_LOCK,
        initialLockedPickerIds: [ANA.id],
      });

      expect(screen.getByText("¿Qué pasa ahora?")).toBeDefined();
      expect(
        screen.getByText(/Tu fotógrafo ya tiene tu selección — la enviaste el .* \(1 foto tuya\)/),
      ).toBeDefined();
      expect(screen.getAllByText(/Los demás todavía están eligiendo/).length).toBeGreaterThan(0);
      // The gallery-wide wording would claim the group's selection is in.
      expect(screen.queryByText(/ya tiene la selección/)).toBeNull();
      expect(screen.queryByText(/está editando/)).toBeNull();
      // The panel's own line agrees.
      expect(screen.getByText(/Enviaste tu selección/)).toBeDefined();
    });

    it("does not call a photographer-locked person a submitter", () => {
      renderGrid({
        initialViewerLock: { lockedAt: "2026-10-15T13:00:00.000Z", submittedAt: null },
        initialLockedPickerIds: [ANA.id],
      });

      expect(screen.getAllByText(/Tu fotógrafo cerró tu selección/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/la enviaste/)).toBeNull();
      expect(screen.queryByText(/Enviaste tu selección/)).toBeNull();
    });

    it("the TRAY note for a photographer-locked viewer agrees with the panel, and never says 'enviada'", () => {
      renderGrid({
        initialViewerLock: { lockedAt: "2026-10-15T13:00:00.000Z", submittedAt: null },
        initialLockedPickerIds: [ANA.id],
      });

      expect(
        screen.getByText("Tu fotógrafo cerró tu selección. Los demás todavía están eligiendo."),
      ).toBeDefined();
      expect(screen.queryByText(/Tu selección ya fue enviada/)).toBeNull();
    });

    it("keeps the TRAY note 'enviada' for a viewer who submitted themselves", () => {
      renderGrid({
        initialViewerLock: VIEWER_LOCK,
        initialLockedPickerIds: [ANA.id],
        initialSubmittedPickerIds: [ANA.id],
      });

      expect(
        screen.getByText("Tu selección ya fue enviada. Los demás todavía están eligiendo."),
      ).toBeDefined();
    });
  });

  describe("another client locked, viewer still choosing", () => {
    it("freezes ONLY the locked person's picks; the viewer's own, Carla's and unpicked tiles stay live", () => {
      renderGrid({ initialLockedPickerIds: [BETO.id] });

      // a2 is Beto's. a1 (mine), a3 (Carla, still choosing) and a4 (nobody's)
      // must remain enabled — a "lock everything" bug would also pass a test
      // that only looked at a2.
      expect(disabledTiles()).toEqual([2]);
      expect(screen.getByRole("button", { name: "Enviar selección" })).toBeDefined();
    });

    it("marks the locked person's tray group 'envió', and nobody else's", () => {
      renderGrid({
        initialLockedPickerIds: [BETO.id],
        initialSubmittedPickerIds: [BETO.id],
      });

      const marker = screen.getByText("envió");
      expect(marker.parentElement?.textContent).toMatch(/Beto Ruiz/);
      expect(screen.getAllByText("envió")).toHaveLength(1);
    });

    it("marks a photographer-locked person 'cerrada' in the tray, not 'envió', and still freezes their picks", () => {
      renderGrid({ initialLockedPickerIds: [BETO.id], initialSubmittedPickerIds: [] });

      const marker = screen.getByText("cerrada");
      expect(marker.parentElement?.textContent).toMatch(/Beto Ruiz/);
      expect(screen.queryByText("envió")).toBeNull();
      expect(disabledTiles()).toEqual([2]);
    });

    it("freezes the locked person's photo in the lightbox too, but not the others'", () => {
      renderGrid({ initialLockedPickerIds: [BETO.id] });

      fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0002.JPG" }));
      expect((screen.getByRole("button", { name: "Elegida" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      // And the type control is not offered on a frozen pick.
      expect(screen.queryByRole("group", { name: /Tipo de foto/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
      fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0003.JPG" }));
      expect((screen.getByRole("button", { name: "Elegida" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(screen.getByRole("group", { name: /Tipo de foto/ })).toBeDefined();
    });
  });

  describe("submitting", () => {
    function submitFetch(body: Record<string, unknown>) {
      return vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            status: "submitted",
            quota: computeQuota(3, 0, TERMS),
            submittedAt: "2026-10-15T13:00:00.000Z",
            ...body,
          }),
        ),
      );
    }

    it("locks the viewer at once with no reload while the gallery stays proofing for the others", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.stubGlobal("fetch", submitFetch({ gallerySelected: false }));

      renderGrid({ initialLockedPickerIds: [BETO.id], initialSubmittedPickerIds: [BETO.id] });
      expect(disabledTiles()).toEqual([2]);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Enviar selección" }));
      });

      await vi.waitFor(() => expect(screen.getByText("¿Qué pasa ahora?")).toBeDefined());
      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
      expect(screen.getAllByText(/Los demás todavía están eligiendo/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/ya tiene la selección/)).toBeNull();
      // The viewer joined the 'envió' markers (Beto was already there).
      expect(screen.getAllByText("envió")).toHaveLength(2);
    });

    it("single-client gallery: the same submit ends in the gallery-wide 'tiene acceso' state, as before", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.stubGlobal("fetch", submitFetch({ gallerySelected: true }));

      renderGrid({ initialPicks: [pick("a1", ANA)] });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Enviar selección" }));
      });

      await vi.waitFor(() => expect(screen.getByText(/tiene acceso/)).toBeDefined());
      expect(screen.getByText(/Tu fotógrafo ya tiene la selección/)).toBeDefined();
      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
    });

    it("keeps the button disabled when the viewer has no picks of their own, even though the group does", () => {
      renderGrid({ initialPicks: [pick("a2", BETO), pick("a3", CARLA)] });

      expect(
        (screen.getByRole("button", { name: "Enviar selección" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it("puts the viewer's OWN count, not the group's, in the confirmation", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      vi.stubGlobal("fetch", vi.fn());

      renderGrid({
        initialPicks: [pick("a1", ANA), pick("a2", ANA), pick("a3", CARLA)],
      });
      fireEvent.click(screen.getByRole("button", { name: "Enviar selección" }));

      const message = confirmSpy.mock.calls[0]?.[0] as string;
      expect(message).toMatch(/¿Cerrar tu selección \(2 fotos tuyas\)\?/);
    });

    it("an admin previewing the page gets a note, not a submit button", () => {
      renderGrid({ isAdminPreview: true });

      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
      expect(
        screen.getByText(/Vista previa: el envío de la selección es solo para clientes/),
      ).toBeDefined();
    });
  });

  describe("live convergence", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    async function pollTick() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SELECTION_POLL_INTERVAL_MS);
      });
    }

    it("reopens the viewer's controls with no reload when a snapshot says they are no longer locked", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(jsonResponse(200, snapshotBody({ viewerLock: null })))),
      );

      renderGrid({ initialViewerLock: VIEWER_LOCK, initialLockedPickerIds: [ANA.id] });
      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();

      await pollTick();

      expect(disabledTiles()).toEqual([]);
      expect(screen.getByRole("button", { name: "Enviar selección" })).toBeDefined();
      expect(screen.queryByText("¿Qué pasa ahora?")).toBeNull();
      expect(screen.queryByText("envió")).toBeNull();
    });

    it("freezes a person's picks when a snapshot reports they submitted", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(jsonResponse(200, snapshotBody({ lockedPickerIds: [CARLA.id] }))),
        ),
      );

      renderGrid();
      expect(disabledTiles()).toEqual([]);

      await pollTick();

      expect(disabledTiles()).toEqual([3]);
    });

    it("relabels a person 'envió' -> 'cerrada' with no reload when a snapshot says the photographer closed them", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            jsonResponse(200, snapshotBody({ lockedPickerIds: [BETO.id], submittedPickerIds: [] })),
          ),
        ),
      );

      renderGrid({ initialLockedPickerIds: [BETO.id], initialSubmittedPickerIds: [BETO.id] });
      expect(screen.getByText("envió")).toBeDefined();

      await pollTick();

      expect(screen.getByText("cerrada")).toBeDefined();
      expect(screen.queryByText("envió")).toBeNull();
    });

    it("locks the viewer when the snapshot carries their lock (an admin locked them)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            jsonResponse(
              200,
              snapshotBody({
                viewerLock: { lockedAt: "2026-10-15T13:00:00.000Z", submittedAt: null },
                lockedPickerIds: [ANA.id],
              }),
            ),
          ),
        ),
      );

      renderGrid();
      await pollTick();

      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
    });
  });

  describe("server 409s", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    /** Answers the PATCH with `refusal` and the snapshot GET with `after`. */
    function refusingFetch(refusal: string, after: ReturnType<typeof snapshotBody>) {
      return vi.fn((url: string, init?: { method?: string }) => {
        if (init?.method === "PATCH") {
          return Promise.resolve(jsonResponse(409, { error: refusal }));
        }
        return Promise.resolve(jsonResponse(200, after));
      });
    }

    async function click(element: HTMLElement) {
      await act(async () => {
        fireEvent.click(element);
      });
      // Let the follow-up snapshot fetch settle.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it("pick_locked: a calm message, then a snapshot refresh that freezes the photo", async () => {
      // Carla's pick looked free when the viewer clicked; she had just submitted.
      const fetchMock = refusingFetch("pick_locked", snapshotBody({ lockedPickerIds: [CARLA.id] }));
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      expect(tileButton(3).disabled).toBe(false);

      await click(tileButton(3));

      expect(screen.getByText(/ya envió su selección, así que no se puede cambiar/)).toBeDefined();
      expect(screen.queryByText(/No se pudo actualizar/)).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
      // The refresh landed: Carla's photo is frozen, the viewer's is not.
      expect(disabledTiles()).toEqual([3]);
    });

    it("client_selection_locked: a calm message, then a refresh that locks the viewer", async () => {
      const fetchMock = refusingFetch(
        "client_selection_locked",
        snapshotBody({
          viewerLock: { lockedAt: "2026-10-15T13:00:00.000Z", submittedAt: null },
          lockedPickerIds: [ANA.id],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      await click(tileButton(1));

      // The bottom bar that normally carries the message is gone once locked,
      // so the message must still be readable in the locked layout.
      expect(
        screen.getByText("Tu selección ya está cerrada, así que no se puede cambiar."),
      ).toBeDefined();
      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
    });

    it("any other failure keeps the generic message and does NOT refetch", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: "boom" })));
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      await click(tileButton(3));

      expect(screen.getByText("No se pudo actualizar la selección.")).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
