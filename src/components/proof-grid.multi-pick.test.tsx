// @vitest-environment jsdom
//
// Epic #250 S7 — the six viewer-relative rows of the tile state matrix
// (design/system/client.html, D11 §2), plus the local entry merge, the
// server-only counter line, the universal order labels and the refusal queue.
//
// This file is deliberately SEPARATE from proof-grid.test.tsx: that suite's
// fixtures predate multi-pick and spell "picked" as `asset.isSelected`. The
// whole point of this slice is that the toggle is the VIEWER'S pick — so these
// tests build real `SelectionEntry` wires with `selection-fixtures.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProofGrid } from "./proof-grid";
import type { ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import type { SelectionEntry } from "@/lib/selection-snapshot";
import {
  ANA,
  BETO,
  SARA,
  counter,
  entry,
  pick,
  emptyProjection,
} from "@/test-support/selection-fixtures";
import { emptyShare } from "@/lib/quota-attribution";

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

function assets(count = 6): ProofAsset[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    // Claimed: a2/a4/a5 by Beto, a6 by Ana. a1/a3 are free.
    isSelected: index + 1 >= 2 && index + 1 !== 3,
    proofUrl: `https://r2.example.com/proof-${index + 1}`,
    hasFinal: false,
    displayUrl: null,
    isExtra: false,
  }));
}

// The D11 §2 six rows, viewer Ana:
//   a1 free            -> row 1
//   a2 Beto billed     -> row 2 (Ana has no pick)
//   a3 Ana cart        -> row 3
//   a4 Ana degraded    -> row 4 (Beto billed, Ana unsent)
//   a5 Ana joined      -> row 5 (Beto billed, Ana sent)
//   a6 Ana billed      -> row 6 (Ana billed and sent)
const ENTRIES: SelectionEntry[] = [
  entry("a2", { billedTo: BETO }, [pick(B, BETO.label, "billed")]),
  entry("a3", null, [pick(A, ANA.label, "cart")]),
  entry("a4", { billedTo: BETO }, [pick(B, BETO.label, "billed"), pick(A, ANA.label, "degraded")]),
  entry("a5", { billedTo: BETO }, [pick(B, BETO.label, "billed"), pick(A, ANA.label, "joined")]),
  entry("a6", { billedTo: ANA }, [pick(A, ANA.label, "billed")]),
];

function renderGrid(
  overrides: {
    entries?: SelectionEntry[];
    viewerId?: string;
    counterData?: ReturnType<typeof counter>;
    rollingDelivery?: boolean;
    fetchMock?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const {
    entries = ENTRIES,
    viewerId = A,
    counterData = counter({ group: 4 }),
    rollingDelivery = false,
    fetchMock,
  } = overrides;
  if (fetchMock) vi.stubGlobal("fetch", fetchMock);
  return render(
    <ProofGrid
      galleryId="g1"
      initialAssets={assets()}
      initialStatus="proofing"
      initialSubmittedAt={null}
      initialEntries={entries}
      initialQuota={computeQuota(4, 0, TERMS)}
      initialCounter={counterData}
      viewerId={viewerId}
      selectionTrayMode="flat"
      allowsOriginalSelection
      rollingDelivery={rollingDelivery}
      finalsOpen={false}
    />,
  );
}

function tile(filename: string): HTMLElement {
  const listItem = screen.getByRole("button", { name: `Ver ${filename}` }).closest("li");
  if (!listItem) throw new Error(`no tile for ${filename}`);
  return listItem;
}

function toggle(filename: string): HTMLButtonElement {
  return screen.getByRole("button", {
    name: new RegExp(`^(Seleccionar|Quitar de seleccionadas): ${filename}$`),
  }) as HTMLButtonElement;
}

/** The four-number line's own text, whitespace-normalised — JSX puts no
 * meaningful spaces between the interpolations but the DOM still can. */
function counterLineText(): string | undefined {
  // Scoped to the viewer line's own wording rather than /entre todos/: since
  // task #264 the counter's HEADLINE also says "entre todos" once more than
  // one person holds units, so that phrase alone is ambiguous.
  return screen
    .getByText(/tuyas|tuya/)
    .closest("p")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProofGrid — the six viewer-relative tile rows (D11 §2)", () => {
  it("reflects the VIEWER'S pick, not the claim: rows 5/6 frozen, row 4 removable, row 2 joinable", () => {
    renderGrid();

    // Row 2: claimed by Beto, Ana has no pick -> empty and enabled.
    expect(toggle("IMG_0002.JPG").getAttribute("aria-pressed")).toBe("false");
    expect(toggle("IMG_0002.JPG").disabled).toBe(false);

    // Row 3: Ana's own cart.
    expect(toggle("IMG_0003.JPG").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("IMG_0003.JPG").disabled).toBe(false);

    // Row 4: Ana's degraded pick is still removable.
    expect(toggle("IMG_0004.JPG").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("IMG_0004.JPG").disabled).toBe(false);

    // Rows 5/6: Ana already sent -> frozen.
    expect(toggle("IMG_0005.JPG").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("IMG_0005.JPG").disabled).toBe(true);
    expect(toggle("IMG_0006.JPG").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("IMG_0006.JPG").disabled).toBe(true);

    // Labels: Editada none (no finals); Pedida on every claimed row; Por
    // enviar only for Ana's cart.
    expect(within(tile("IMG_0002.JPG")).getByText("Pedida")).toBeDefined();
    expect(within(tile("IMG_0003.JPG")).getByText("Por enviar")).toBeDefined();
    expect(within(tile("IMG_0004.JPG")).getByText("Pedida")).toBeDefined();
  });

  it("keeps the server's chip order, billed holder first, and says who in one sentence", () => {
    renderGrid();

    const degraded = tile("IMG_0004.JPG");
    expect(within(degraded).getByText("Eligieron esta foto: Beto, Tú")).toBeDefined();
    // B before A in the visible chip row.
    const chips = [...degraded.querySelectorAll("span[aria-hidden='true'] span")]
      .map((span) => span.textContent)
      .filter((text) => text === "B" || text === "A");
    expect(chips).toEqual(["B", "A"]);
  });

  it("sends selected:true from a row-2 tile, where the claim already exists", async () => {
    const responseEntry = entry("a2", { billedTo: BETO }, [
      pick(B, BETO.label, "billed"),
      pick(A, ANA.label, "degraded"),
    ]);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          asset: { id: "a2", isSelected: true, selectionKind: "edited" },
          entry: responseEntry,
          quota: computeQuota(4, 0, TERMS),
          counter: counter({ group: 4 }),
        }),
      ),
    );
    renderGrid({ fetchMock });

    fireEvent.click(toggle("IMG_0002.JPG"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/assets/a2/selection",
        expect.objectContaining({ body: JSON.stringify({ selected: true }) }),
      ),
    );
    await waitFor(() => expect(toggle("IMG_0002.JPG").getAttribute("aria-pressed")).toBe("true"));
  });

  it("sends selected:false from a row-4 tile and replaces the whole entry with the response", async () => {
    // Beto's unit stays; the response also carries Sara's cart, which this
    // session never saw. A single-`pick` merge would drop her.
    const responseEntry = entry("a4", { billedTo: BETO }, [
      pick(B, BETO.label, "billed"),
      pick(SARA.id, SARA.label, "cart"),
    ]);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          asset: { id: "a4", isSelected: true, selectionKind: "edited" },
          entry: responseEntry,
          quota: computeQuota(4, 0, TERMS),
          counter: counter({ group: 4 }),
        }),
      ),
    );
    renderGrid({ fetchMock });

    fireEvent.click(toggle("IMG_0004.JPG"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/assets/a4/selection",
        expect.objectContaining({ body: JSON.stringify({ selected: false }) }),
      ),
    );
    await waitFor(() => expect(toggle("IMG_0004.JPG").getAttribute("aria-pressed")).toBe("false"));
    // Row 2 again: the photo is still pedida by Beto, and Sara's cart is now
    // visible as attribution (Q1: unsent picks are chips, never cupo).
    expect(within(tile("IMG_0004.JPG")).getByText("Pedida")).toBeDefined();
    expect(within(tile("IMG_0004.JPG")).getByText("Eligieron esta foto: Beto, Sara")).toBeDefined();
  });

  it("moves the 'is you' chip and swaps C6/C7 when the viewer is Beto instead of Ana", () => {
    renderGrid({ viewerId: B });

    const joined = tile("IMG_0005.JPG");
    const accentChips = [...joined.querySelectorAll("span[aria-hidden='true'] span")].filter(
      (span) => span.className.includes("bg-accent"),
    );
    expect(accentChips).toHaveLength(1);
    expect(accentChips[0]?.textContent).toBe("B");

    fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0005.JPG" }));
    const dialog = screen.getByRole("dialog");
    // Beto holds the unit -> C6.
    expect(within(dialog).getByText(/La pediste/)).toBeDefined();
    expect(within(dialog).getByText("tú")).toBeDefined();
    cleanup();

    renderGrid({ viewerId: A });
    fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0005.JPG" }));
    const anaDialog = screen.getByRole("dialog");
    // Ana joined Beto's unit -> C7.
    expect(within(anaDialog).getByText(/La pidió/)).toBeDefined();
    expect(within(anaDialog).getByText(/tú también la pediste/)).toBeDefined();
  });

  it("reads the viewer's own kind, not the claim's: a degraded original on an edited claim", () => {
    // Every other fixture leaves the pick's kind and the claim's
    // `resolvedKind` both at the default "edited", so the two are
    // indistinguishable. Here they disagree: Beto's sent unit resolved to
    // `edited`, while Ana's degraded pick asked `original`. The tile and the
    // lightbox must both read `viewerPickById`'s `pick.kind` — a map built
    // from `claim.resolvedKind` would show Editada pressed in both surfaces.
    renderGrid({
      entries: [
        entry("a4", { billedTo: BETO, resolvedKind: "edited" }, [
          pick(B, BETO.label, "billed"),
          pick(A, ANA.label, "degraded", "original"),
        ]),
      ],
    });

    const tileOriginal = screen.getByRole("button", {
      name: "Marcar como original: IMG_0004.JPG",
    });
    const tileEdited = screen.getByRole("button", {
      name: "Marcar como editada: IMG_0004.JPG",
    });
    expect(tileOriginal.getAttribute("aria-pressed")).toBe("true");
    expect(tileEdited.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0004.JPG" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getByRole("button", { name: "Marcar como original: IMG_0004.JPG" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(dialog)
        .getByRole("button", { name: "Marcar como editada: IMG_0004.JPG" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("renders the server's four numbers, singulars included, over entries that count differently", () => {
    // ONE entry — Ana's unsent cart — so any RECOUNT of `entries` would give
    // 1 for every viewer bucket. The server says 4 / 2 / 3. A line built by
    // counting entries instead of reading `counter` fails on all three.
    renderGrid({
      entries: [entry("a3", null, [pick(A, ANA.label, "cart")])],
      counterData: counter({
        group: 15,
        viewer: { yours: 4, shared: 2, toSend: 3, projection: emptyProjection() },
        people: [
          // Task #264 — required per-person money; this test is about the
          // four NUMBERS, so the shares are the all-zero ones.
          { userId: A, label: ANA.label, units: 4, share: emptyShare() },
          { userId: B, label: BETO.label, units: 3, share: emptyShare() },
        ],
      }),
    });

    expect(counterLineText()).toBe("4 tuyas · 2 compartidas · 3 por enviar · 15 entre todos");
    cleanup();

    // Both singulars, in one render: `yours` plural with `shared` singular
    // reaches "1 compartida", which a plural-only variant never renders
    // (`yours: 0`/`shared: 0` would hide a "0 tuyas" bug behind the plural
    // branch; `yours: 2` does not).
    renderGrid({
      entries: [entry("a3", null, [pick(A, ANA.label, "cart")])],
      counterData: counter({
        group: 0,
        viewer: { yours: 2, shared: 1, toSend: 0, projection: emptyProjection() },
      }),
    });

    expect(counterLineText()).toBe("2 tuyas · 1 compartida · 0 por enviar · 0 entre todos");
    cleanup();

    // And the singular "1 tuya" on its own.
    renderGrid({
      entries: [entry("a3", null, [pick(A, ANA.label, "cart")])],
      counterData: counter({
        group: 1,
        viewer: { yours: 1, shared: 2, toSend: 1, projection: emptyProjection() },
      }),
    });

    expect(counterLineText()).toBe("1 tuya · 2 compartidas · 1 por enviar · 1 entre todos");
  });

  it("labels degraded as Pedida and a cart as Por enviar even with rolling delivery OFF", () => {
    renderGrid({ rollingDelivery: false });

    expect(within(tile("IMG_0004.JPG")).getByText("Pedida")).toBeDefined();
    expect(within(tile("IMG_0003.JPG")).getByText("Por enviar")).toBeDefined();
  });
});

describe("ProofGrid — the refusal queue (S7)", () => {
  it("explains pick_degraded and asks for one snapshot refresh", async () => {
    const fetchMock = vi.fn((url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(jsonResponse(409, { error: "pick_degraded" }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          status: "proofing",
          submittedAt: null,
          entries: ENTRIES,
          counter: counter({ group: 4 }),
          quota: computeQuota(4, 0, TERMS),
          viewerLock: null,
          adminLockedPickerIds: [],
          viewerSubmittedAt: null,
        }),
      );
    });
    renderGrid({ fetchMock });

    fireEvent.click(toggle("IMG_0003.JPG"));

    await waitFor(() =>
      expect(
        screen.getAllByText("Otra persona ya la pidió, así que solo puedes cambiarla a editada.")
          .length,
      ).toBeGreaterThan(0),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
  });

  it.each(["pick_locked", "pick_not_yours"])(
    "%s is deleted: generic sentence, no refresh",
    async (code) => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(409, { error: code })));
      renderGrid({ fetchMock });

      fireEvent.click(toggle("IMG_0003.JPG"));

      await waitFor(() =>
        expect(screen.getAllByText("No se pudo actualizar la selección.").length).toBeGreaterThan(
          0,
        ),
      );
      expect(fetchMock).not.toHaveBeenCalledWith("/api/galleries/g1/selection");
    },
  );
});
