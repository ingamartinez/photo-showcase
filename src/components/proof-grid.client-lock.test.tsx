// @vitest-environment jsdom
//
// Epic #239 / epic #250 S6 — the CLIENT side of per-person state after
// "choosing is asking, not owning".
//
// The OLD rule froze another person's pick on the board. S4/S5 made that
// structural on the server (a client PATCH only touches its own
// `asset_picks` row), so what is left to render is:
//   - the viewer's OWN submitted picks are frozen (degrado still removable);
//   - a person the PHOTOGRAPHER locked reads "cerrada" in the tray;
//   - a person who sent a pick reads "envió";
//   - the viewer's own lock freezes every control.
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProofGrid, SELECTION_POLL_INTERVAL_MS } from "./proof-grid";
import type { GalleryStatus, ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import { emptyShare } from "@/lib/quota-attribution";
import type { SelectionEntry, SelectionKind, ViewerLock } from "@/lib/selection-snapshot";
import { emptyProjection } from "@/test-support/selection-fixtures";

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

type FixturePick = {
  assetId: string;
  pickedBy: { id: string; label: string };
  submitted: boolean;
  kind?: SelectionKind;
};

function entryFor(pick: FixturePick): SelectionEntry {
  return {
    assetId: pick.assetId,
    claim: {
      claimedAt: "2026-10-15T12:00:00.000Z",
      resolvedKind: pick.kind ?? "edited",
      billedTo: pick.pickedBy,
      charge: "included",
      canEscalate: false,
    },
    picks: [
      {
        userId: pick.pickedBy.id,
        label: pick.pickedBy.label,
        kind: pick.kind ?? "edited",
        pickedAt: "2026-10-15T12:00:00.000Z",
        submittedAt: pick.submitted ? "2026-10-15T12:00:00.000Z" : null,
        state: pick.submitted ? "billed" : "degraded",
      },
    ],
  };
}

const PICKS: FixturePick[] = [
  { assetId: "a1", pickedBy: ANA, submitted: true },
  { assetId: "a2", pickedBy: BETO, submitted: true },
  { assetId: "a3", pickedBy: CARLA, submitted: true },
];

function counterFor(picks: FixturePick[], viewerId: string) {
  const counts = new Map<string, { label: string; units: number }>();
  for (const pick of picks) {
    const existing = counts.get(pick.pickedBy.id);
    if (existing) existing.units += 1;
    else counts.set(pick.pickedBy.id, { label: pick.pickedBy.label, units: 1 });
  }
  return {
    group: picks.length,
    viewer: {
      yours: picks.filter((pick) => pick.pickedBy.id === viewerId && pick.submitted).length,
      shared: 0,
      toSend: picks.filter((pick) => pick.pickedBy.id === viewerId && !pick.submitted).length,
      projection: emptyProjection(),
    },
    people: [...counts].map(([userId, { label, units }]) => ({
      userId,
      label,
      units,
      // Task #264 — this fixture is about lock state, not money; the
      // required share is the all-zero one, produced by the same module the
      // server uses.
      share: emptyShare(),
    })),
    unattributed: 0,
    unattributedShare: emptyShare(),
  };
}

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

function renderGrid(
  overrides: Partial<ComponentProps<typeof ProofGrid>> & {
    picks?: FixturePick[];
    lockedPickerIds?: string[];
  } = {},
) {
  const { picks = PICKS, lockedPickerIds = [], ...rest } = overrides;
  return render(
    <ProofGrid
      galleryId="g1"
      initialAssets={assets()}
      initialStatus="proofing"
      initialSubmittedAt={null}
      initialEntries={picks.map(entryFor)}
      initialQuota={computeQuota(picks.length, 0, TERMS)}
      initialCounter={counterFor(picks, ANA.id)}
      initialAdminLockedPickerIds={lockedPickerIds}
      viewerId={ANA.id}
      selectionTrayMode="by-person"
      allowsOriginalSelection={true}
      {...rest}
    />,
  );
}

/** What `GET /api/galleries/[galleryId]/selection` returns. */
function snapshotBody(
  overrides: {
    status?: GalleryStatus;
    submittedAt?: string | null;
    picks?: FixturePick[];
    viewerLock?: ViewerLock | null;
    lockedPickerIds?: string[];
  } = {},
) {
  const picks = overrides.picks ?? PICKS;
  return {
    status: overrides.status ?? "proofing",
    submittedAt: overrides.submittedAt ?? null,
    quota: computeQuota(picks.length, 0, TERMS),
    counter: counterFor(picks, ANA.id),
    entries: picks.map(entryFor),
    viewerLock: overrides.viewerLock ?? null,
    adminLockedPickerIds: overrides.lockedPickerIds ?? [],
    viewerSubmittedAt: null,
  };
}

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

describe("ProofGrid — per-person state after S6", () => {
  describe("viewer locked", () => {
    it("disables EVERY tile and offers no submit button", () => {
      renderGrid({ initialViewerLock: VIEWER_LOCK, lockedPickerIds: [ANA.id] });

      expect(disabledTiles()).toEqual([1, 2, 3, 4]);
      expect(screen.queryByRole("button", { name: /^Enviar/ })).toBeNull();
    });

    it("says THEIR selection was sent and the group is still choosing", () => {
      renderGrid({ initialViewerLock: VIEWER_LOCK, lockedPickerIds: [ANA.id] });

      expect(screen.getByText("¿Qué pasa ahora?")).toBeDefined();
      expect(screen.getByText(/Tu fotógrafo ya tiene tu selección/)).toBeDefined();
      expect(screen.getAllByText(/Los demás todavía están eligiendo/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/ya tiene la selección/)).toBeNull();
    });

    it("does not call a photographer-locked person a submitter", () => {
      renderGrid({
        initialViewerLock: { lockedAt: "2026-10-15T13:00:00.000Z", submittedAt: null },
        lockedPickerIds: [ANA.id],
      });

      expect(screen.getAllByText(/Tu fotógrafo cerró tu selección/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/la enviaste/)).toBeNull();
      expect(screen.queryByText(/Enviaste tu selección/)).toBeNull();
    });
  });

  describe("freeze is the viewer's own sent pick, not somebody else's lock", () => {
    it("freezes ONLY the viewer's own submitted pick; an admin lock on Beto does not touch the board", () => {
      renderGrid({ lockedPickerIds: [BETO.id] });

      // a1 is the viewer's own submitted pick. a2 (Beto, admin-locked) and
      // a3 (Carla) stay interactive — S4 made "you cannot edit somebody
      // else's row" structural on the server, so freezing it here would be
      // a UI lie that also blocks joining a claimed photo.
      expect(disabledTiles()).toEqual([1]);
      expect(tileButton(2).disabled).toBe(false);
      expect(screen.getByRole("button", { name: /^Enviar/ })).toBeDefined();
    });

    it("leaves the viewer's own UNSENT pick removable", () => {
      renderGrid({
        picks: [
          { assetId: "a1", pickedBy: ANA, submitted: false },
          { assetId: "a2", pickedBy: BETO, submitted: true },
        ],
      });

      expect(tileButton(1).disabled).toBe(false);
    });

    it("marks an admin-locked person 'cerrada' and a sender 'envió', by id not label", () => {
      renderGrid({ lockedPickerIds: [BETO.id] });

      const marker = screen.getByText("cerrada");
      expect(marker.parentElement?.textContent).toMatch(/Beto Ruiz/);
      // Ana and Carla sent picks, so they read "envió".
      expect(screen.getAllByText("envió")).toHaveLength(2);
    });

    it("keeps two people with the same display name apart when only one is admin-locked", () => {
      const twin1 = { id: "client-b", label: "Beto Ruiz" };
      const twin2 = { id: "client-c", label: "Beto Ruiz" };
      renderGrid({
        picks: [
          { assetId: "a1", pickedBy: twin1, submitted: true },
          { assetId: "a2", pickedBy: twin2, submitted: true },
        ],
        lockedPickerIds: [twin2.id],
      });

      const headers = screen
        .getAllByText(/Beto Ruiz/, { selector: "p" })
        .filter((node) => node.textContent?.includes("(1)"));
      expect(headers).toHaveLength(2);
      expect(headers.filter((header) => header.textContent?.includes("cerrada"))).toHaveLength(1);
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

      renderGrid({ initialViewerLock: VIEWER_LOCK, lockedPickerIds: [ANA.id] });
      expect(disabledTiles()).toEqual([1, 2, 3, 4]);

      await pollTick();

      // Only the viewer's own submitted pick stays frozen; the rest reopens.
      expect(disabledTiles()).toEqual([1]);
      expect(screen.getByRole("button", { name: /^Enviar/ })).toBeDefined();
      expect(screen.queryByText("¿Qué pasa ahora?")).toBeNull();
    });

    it("applies a snapshot's admin lock, relabelling that person 'cerrada'", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(jsonResponse(200, snapshotBody({ lockedPickerIds: [CARLA.id] }))),
        ),
      );

      renderGrid({ lockedPickerIds: [] });
      expect(screen.queryByText("cerrada")).toBeNull();

      await pollTick();

      expect(screen.getByText("cerrada")).toBeDefined();
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
      expect(screen.queryByRole("button", { name: /^Enviar/ })).toBeNull();
    });
  });

  describe("submit", () => {
    it("does not latch a local lock: a send asks for a fresh snapshot and follows the server", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith("/submit-selection")) {
          return Promise.resolve(
            jsonResponse(200, {
              status: "submitted",
              quota: computeQuota(3, 0, TERMS),
              submittedAt: "2026-10-15T13:00:00.000Z",
              gallerySelected: false,
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, snapshotBody()));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({
        picks: [
          { assetId: "a1", pickedBy: ANA, submitted: false },
          { assetId: "a2", pickedBy: BETO, submitted: true },
        ],
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Enviar/ }));
      });
      fireEvent.click(screen.getByRole("button", { name: /^Sí, enviar/ }));

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/submit-selection", {
        method: "POST",
      });
      // The refresh is what decides the state; nothing was latched locally.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection"));
      expect(screen.getByRole("button", { name: /^Enviar/ })).toBeDefined();
    });

    it("shows the gallery-wide 'tiene acceso' state when the server says it closed", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith("/submit-selection")) {
          return Promise.resolve(
            jsonResponse(200, {
              status: "submitted",
              quota: computeQuota(3, 0, TERMS),
              submittedAt: "2026-10-15T13:00:00.000Z",
              gallerySelected: true,
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(
            200,
            snapshotBody({ status: "selected", submittedAt: "2026-10-15T13:00:00.000Z" }),
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      // The viewer needs something "por enviar" for the button to be live
      // under order semantics (C9 counts their own unsent picks).
      renderGrid({
        picks: [
          { assetId: "a1", pickedBy: ANA, submitted: false },
          { assetId: "a2", pickedBy: BETO, submitted: true },
        ],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Enviar/ }));
      });
      fireEvent.click(screen.getByRole("button", { name: /^Sí, enviar/ }));

      await vi.waitFor(() => expect(screen.getByText(/tiene acceso/)).toBeDefined());
      expect(screen.queryByRole("button", { name: /^Enviar/ })).toBeNull();
    });
  });

  describe("server 409s", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    function refusingFetch(refusal: string | Record<string, unknown>, after: unknown) {
      const body = typeof refusal === "string" ? { error: refusal } : refusal;
      return vi.fn((url: string, init?: { method?: string }) => {
        if (init?.method === "PATCH") return Promise.resolve(jsonResponse(409, body));
        return Promise.resolve(jsonResponse(200, after));
      });
    }

    async function click(element: HTMLElement) {
      await act(async () => {
        fireEvent.click(element);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it("pick_locked is DELETED: it falls through to the generic sentence and does not refresh", async () => {
      // `pick_locked` protected somebody else's row under the single-owner
      // model. A PATCH can no longer address that row, so the code is gone
      // (route comment); an old server still answering it must not get the
      // calm lock copy or a refresh, because nothing about the board changed.
      const fetchMock = refusingFetch("pick_locked", snapshotBody({ lockedPickerIds: [CARLA.id] }));
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      expect(tileButton(3).disabled).toBe(false);
      await click(tileButton(3));

      expect(screen.getByText("No se pudo actualizar la selección.")).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalledWith("/api/galleries/g1/selection");
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
      await click(tileButton(3));

      expect(
        screen.getByText("Tu selección ya está cerrada, así que no se puede cambiar."),
      ).toBeDefined();
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
