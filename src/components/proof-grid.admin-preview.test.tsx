// @vitest-environment jsdom
//
// Epic #250 S7 — the admin preview's acting client (decision 12). The route
// refuses an admin PATCH without `actingClientId` (409 `admin_cannot_pick`)
// and refuses a CLIENT that sends it (400), so the two bodies are proven here
// by key, not by "it didn't crash".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProofGrid } from "./proof-grid";
import type { ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import type { SelectionEntry } from "@/lib/selection-snapshot";
import { ANA, BETO, counter, entry, pick } from "@/test-support/selection-fixtures";

const A = ANA.id;
const B = BETO.id;

const TERMS = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function assets(): ProofAsset[] {
  return [1, 2].map((n) => ({
    id: `a${n}`,
    originalFilename: `IMG_000${n}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    proofUrl: `https://r2.example.com/proof-${n}`,
    hasFinal: false,
    displayUrl: null,
    isExtra: false,
  }));
}

// Beto has one cart on a2; a1 is free.
const ENTRIES: SelectionEntry[] = [entry("a2", null, [pick(B, BETO.label, "cart")])];

function renderGrid(
  overrides: {
    viewerId?: string;
    actingClientId?: string | null;
    readOnly?: boolean;
    initialStatus?: "proofing" | "selected";
    entries?: SelectionEntry[];
    initialViewerLock?: import("@/lib/selection-snapshot").ViewerLock | null;
    fetchMock?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const {
    viewerId = B,
    actingClientId = B,
    readOnly = false,
    initialStatus = "proofing",
    entries = ENTRIES,
    initialViewerLock = null,
    fetchMock,
  } = overrides;
  if (fetchMock) vi.stubGlobal("fetch", fetchMock);
  return render(
    <ProofGrid
      galleryId="g1"
      initialAssets={assets()}
      initialStatus={initialStatus}
      initialSubmittedAt={null}
      initialEntries={entries}
      initialQuota={computeQuota(1, 0, TERMS)}
      initialCounter={counter({ group: 0 })}
      initialViewerLock={initialViewerLock}
      viewerId={viewerId}
      actingClientId={actingClientId}
      readOnly={readOnly}
      isAdminPreview
      selectionTrayMode="flat"
      allowsOriginalSelection
      finalsOpen={false}
    />,
  );
}

function toggle(filename: string): HTMLButtonElement {
  return screen.getByRole("button", {
    name: new RegExp(`^(Seleccionar|Quitar de seleccionadas): ${filename}$`),
  }) as HTMLButtonElement;
}

function responseFor(assetId: string, entryBody: SelectionEntry | null) {
  return jsonResponse(200, {
    asset: { id: assetId, isSelected: entryBody !== null, selectionKind: "edited" },
    entry: entryBody,
    quota: computeQuota(1, 0, TERMS),
    counter: counter({ group: 0 }),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProofGrid — admin acting client (S7)", () => {
  it("puts actingClientId on BOTH the toggle and the type body", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("/selection")
          ? responseFor("a1", entry("a1", { billedTo: BETO }, [pick(B, BETO.label, "degraded")]))
          : responseFor("a2", ENTRIES[0]!),
      ),
    );
    renderGrid({ fetchMock });

    fireEvent.click(toggle("IMG_0001.JPG"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(firstCall[1].body)).toEqual({
      selected: true,
      actingClientId: B,
    });

    // The type control renders for Beto's own cart on a2.
    fireEvent.click(screen.getByRole("button", { name: "Marcar como editada: IMG_0002.JPG" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, { body: string }];
    expect(JSON.parse(secondCall[1].body)).toEqual({
      selectionKind: "edited",
      actingClientId: B,
    });
  });

  it("readOnly disables every pick control and issues zero requests", async () => {
    const fetchMock = vi.fn();
    renderGrid({ readOnly: true, actingClientId: null, fetchMock });

    expect(toggle("IMG_0001.JPG").disabled).toBe(true);
    expect(toggle("IMG_0002.JPG").disabled).toBe(true);
    fireEvent.click(toggle("IMG_0001.JPG"));
    fireEvent.click(toggle("IMG_0002.JPG"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a CLIENT body never carries the actingClientId key at all", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(responseFor("a1", null)));
    renderGrid({
      viewerId: A,
      actingClientId: null,
      readOnly: false,
      entries: [],
      fetchMock,
    });

    fireEvent.click(toggle("IMG_0001.JPG"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["selected"]);
  });

  it("acting ignores the subject's viewerLock but still refuses a non-proofing gallery", () => {
    renderGrid({
      initialViewerLock: {
        lockedAt: "2026-10-17T12:00:00.000Z",
        submittedAt: "2026-10-17T12:00:00.000Z",
        lockedBy: "client",
      },
    });
    // Decision 12 exempts the admin from the per-client lock: the write is
    // the correction tool. The gallery is still proofing, so the control is
    // live.
    expect(toggle("IMG_0002.JPG").disabled).toBe(false);
    cleanup();

    renderGrid({ initialStatus: "selected" });
    // `actOnBehalf` refuses a non-proofing gallery, so the client freezes here.
    expect(toggle("IMG_0002.JPG").disabled).toBe(true);
  });
});
