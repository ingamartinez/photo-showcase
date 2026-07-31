// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofGrid, SELECTION_POLL_INTERVAL_MS } from "./proof-grid";
import type { GalleryStatus, ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";
import type { SelectionPick } from "@/lib/selection-snapshot";

// <ProofGrid> renders <SelectionCounter>, which imports `formatCop` off
// `@/lib/format` — a plain module with no `server-only`/`@/lib/db` import
// (see that module's own header comment for why it lives there and not on
// `@/lib/galleries`), so unlike that module, jsdom resolves it directly;
// no mock needed here, the real `formatCop` runs.

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function assetsFor(overrides: Partial<ProofAsset>[] = [{}]): ProofAsset[] {
  return overrides.map((override, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    proofUrl: `https://r2.example.com/original-${index + 1}`,
    hasFinal: false,
    // Task #89: `null` is the ordinary case — an asset only gets a display
    // URL once its gallery is delivered AND it has a final. The tests that
    // exercise the unwatermarked path override this explicitly.
    displayUrl: null,
    ...override,
  }));
}

// Every test wants the same Estándar snapshot terms (PLAN.md §3's table)
// unless it's specifically exercising the quota — this only overrides
// `initialAssets` most of the time.
function renderGrid(overrides: Partial<ComponentProps<typeof ProofGrid>> = {}) {
  return render(
    <ProofGrid
      galleryId="g1"
      initialAssets={assetsFor()}
      initialStatus="proofing"
      initialSubmittedAt={null}
      // Task #95: the collaborative tray's first paint. Most tests here
      // predate it and are about the grid, so the default is "nobody has
      // picked anything yet" — the tests that exercise the tray or the live
      // sync override it.
      initialPicks={[]}
      viewerId="client-a"
      packageName="Estándar"
      includedPhotosSnapshot={13}
      extraPhotoPriceCopSnapshot={5_000}
      {...overrides}
    />,
  );
}

// Task #147 split <SelectionCounter> into two lines (see that file's own
// header comment): "incluidas/seleccionadas" and "extras/surcharge/no
// charge" no longer live in the same text node, so a single `getByText`
// cannot see both halves at once — this combines them the way a sighted
// reader would, reading top to bottom, rather than pinning each line
// separately (which would let the two silently disagree unnoticed).
function counterText(): string {
  const first = screen.getByText(/incluidas/).textContent ?? "";
  const second = screen.getByText(/^extras/).textContent ?? "";
  return `${first} ${second}`.replace(/\s+/g, " ");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProofGrid", () => {
  it("renders the empty state when there are no assets", () => {
    renderGrid({ initialAssets: [] });

    expect(screen.getByText(/todavía no subió fotos/i)).toBeDefined();
  });

  // Task #145 changed WHICH box is reserved (a uniform 2:3, the mock's own —
  // design/system/client.html:181 — rather than each asset's stored
  // proofWidth/proofHeight); it did not change THAT one is reserved before the
  // <img> loads, which is the zero-CLS contract task #23 wrote this test for.
  // proof-tile.tsx carries the measured reason for the switch, and
  // proof-tile.test.tsx pins the shape per orientation.
  it("reserves each tile's uniform box before the image ever loads", () => {
    const { container } = renderGrid({
      initialAssets: assetsFor([{ proofWidth: 1600, proofHeight: 1067 }]),
    });

    const img = container.querySelector("img");
    const wrapper = img?.parentElement;
    expect(wrapper?.className).toContain("aspect-[2/3]");
    expect(wrapper?.getAttribute("style")).toBeNull();
  });

  // THE ORIGIN OF THE TILE NUMBER, which nothing guarded until now.
  // proof-tile.test.tsx pins the zero-padding, but it takes `position` as an
  // INPUT, so mutating this component's `index + 1` to `index` — every tile
  // then labelled one lower, starting at `00` — left the whole suite green.
  // This is the only place the 1-based origin is decided, so it is the only
  // place it can be asserted. The sequence, not just the first tile: an
  // off-by-one that also reversed or duplicated would otherwise slip through.
  it("numbers the tiles 01, 02, 03… — 1-based and in grid order, not 0-based", () => {
    const { container } = renderGrid({ initialAssets: assetsFor([{}, {}, {}]) });

    const tiles = [...(container.querySelector("img")?.closest("ul")?.children ?? [])];
    expect(tiles).toHaveLength(3);
    expect(tiles.map((tile) => tile.querySelector("span.tabular-nums")?.textContent)).toEqual([
      "01",
      "02",
      "03",
    ]);
  });

  // THE COLUMN/GAP CONFIGURATION, which nothing guarded either: collapsing the
  // whole list to `grid-cols-1` was green across every suite. This is task
  // #145's "densidad" criterion — "en el teléfono la miniatura tiene que ser lo
  // bastante grande para decidir" — and the mock states it three times:
  // client.html:180 (two columns, 2px gap), :532 (three from 620px, taken to
  // Tailwind's `sm` at 640px, the nearest stop in the project's own scale) and
  // :556 (four columns and a 3px gap at the desk).
  //
  // Like the tile's `h-12` assertion, this asserts the CLASSES: jsdom applies
  // no stylesheet and can measure no column. The at-390px verification is the
  // Playwright capture, not this file.
  it("gives the grid the mock's 2/3/4-column classes and near-zero gutter", () => {
    const { container } = renderGrid({ initialAssets: assetsFor([{}, {}]) });

    const grid = container.querySelector("img")?.closest("ul");
    expect(grid).not.toBeNull();
    // The phone, which is the base case and not a breakpoint.
    expect(grid?.className).toContain("grid-cols-2");
    expect(grid?.className).toContain("gap-[2px]");
    // The two breakpoints ADD; per this epic there is no `max-width` anywhere.
    expect(grid?.className).toContain("sm:grid-cols-3");
    expect(grid?.className).toContain("lg:grid-cols-4");
    expect(grid?.className).toContain("lg:gap-[3px]");
  });

  it("renders each asset's thumbnail by its original presigned URL", () => {
    const { container } = renderGrid({ initialAssets: assetsFor([{}, {}]) });

    // Not getByRole("img"): each tile's <img alt=""> is deliberately
    // decorative (the enclosing button already carries an aria-label with
    // the filename), which removes it from the accessibility tree's "img"
    // role — queried off the DOM directly instead.
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe("https://r2.example.com/original-1");
    expect(images[1]?.getAttribute("src")).toBe("https://r2.example.com/original-2");
  });

  it("opens the lightbox at the clicked tile's index", async () => {
    const user = userEvent.setup();
    renderGrid({ initialAssets: assetsFor([{}, {}, {}]) });

    await user.click(screen.getByRole("button", { name: "Ver IMG_0002.JPG" }));

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText(/2 \/ 3/)).toBeDefined();
    expect(screen.getByText("IMG_0002.JPG", { exact: false })).toBeDefined();
  });

  it("closes the lightbox", async () => {
    const user = userEvent.setup();
    renderGrid({ initialAssets: assetsFor([{}]) });

    await user.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));
    expect(screen.getByRole("dialog")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The task's URL-expiry acceptance criterion: a stale URL recovers
  // in-place (the tile swaps its own <img> src) without a hard reload, and
  // once refreshed, opening the lightbox for the SAME asset reuses that
  // already-refreshed URL instead of fetching it again — the shared-state
  // design this file's header comment documents.
  it("refreshes a stale tile's URL on <img> error, and the lightbox reuses the refreshed URL for the same asset without fetching again", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed-1" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const { container } = renderGrid({ initialAssets: assetsFor([{}]) });

    const tileImg = container.querySelector("img") as HTMLImageElement;
    expect(tileImg.src).toBe("https://r2.example.com/original-1");

    fireEvent.error(tileImg);
    await vi.waitFor(() => expect(tileImg.src).toBe("https://r2.example.com/refreshed-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/proof");

    await user.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));

    const lightboxImg = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
    expect(lightboxImg.src).toBe("https://r2.example.com/refreshed-1");
    // Still exactly once — the lightbox picked up the already-refreshed URL
    // from shared state instead of re-fetching it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never refetches more than once for the same asset even if the <img> keeps erroring", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: "boom" })));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderGrid({ initialAssets: assetsFor([{}]) });
    const tileImg = container.querySelector("img") as HTMLImageElement;

    fireEvent.error(tileImg);
    fireEvent.error(tileImg);
    fireEvent.error(tileImg);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("re-signs a stale URL noticed by the TRAY, and the grid tile heals from the same shared map", async () => {
    // Task #95: the tray is the surface most likely to notice a stale URL
    // first. Its picks arrive from other sessions during a long argument about
    // photos, and the corresponding grid tile is routinely below the fold —
    // `loading="lazy"`, so never fetched, so never errored there. Without the
    // tray's own `onError` the client would look at a broken thumbnail for the
    // rest of the session.
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed-1" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderGrid({
      initialAssets: assetsFor([{ isSelected: true }]),
      initialPicks: [
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-b", label: "Beto Ruiz" },
        },
      ],
    });

    const tray = screen.getByRole("region", { name: "Fotos elegidas" });
    fireEvent.error(tray.querySelector("img") as HTMLImageElement);

    // Waits on the rendered SRC, not merely on the request having been issued
    // — the point of the fix is that the thumbnail actually heals.
    await vi.waitFor(() =>
      expect((tray.querySelector("img") as HTMLImageElement).src).toBe(
        "https://r2.example.com/refreshed-1",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/proof");
    // Both surfaces heal, because `urls` is ONE map shared by all three —
    // the refresh is not duplicated per surface.
    expect(
      (
        screen
          .getByRole("button", { name: "Ver IMG_0001.JPG" })
          .querySelector("img") as HTMLImageElement | null
      )?.src,
    ).toBe("https://r2.example.com/refreshed-1");
  });

  it("never re-signs the same asset twice, no matter which surface noticed it first", async () => {
    // `refreshedAssetIds` is shared, so the tray erroring and then the grid
    // tile erroring for the same asset is still exactly one request.
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed-1" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderGrid({
      initialAssets: assetsFor([{ isSelected: true }]),
      initialPicks: [
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-b", label: "Beto Ruiz" },
        },
      ],
    });

    const tray = screen.getByRole("region", { name: "Fotos elegidas" });
    fireEvent.error(tray.querySelector("img") as HTMLImageElement);
    // The grid's own tile for the same asset — the second <img> in the DOM,
    // since the tray renders above the grid.
    fireEvent.error(container.querySelectorAll("img")[1] as HTMLImageElement);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  describe("live quota counter", () => {
    it("renders the initial counter computed from the assets' own isSelected flags and the snapshot terms", () => {
      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }, { isSelected: true }, {}]),
        includedPhotosSnapshot: 1,
        extraPhotoPriceCopSnapshot: 5_000,
      });

      const text = counterText();
      expect(text).toContain("seleccionadas 2");
      expect(text).toContain("extras 1");
    });

    it("toggling a tile PATCHes the selection route and replaces the counter with the server's own response, not a local increment", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            asset: { id: "a1", isSelected: true, selectedAt: "2026-07-28T00:00:00.000Z" },
            quota: {
              selected: 99,
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
              extras: 86,
              surchargeCop: 430_000,
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({ initialAssets: assetsFor([{ isSelected: false }]) });

      await user.click(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/assets/a1/selection",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ selected: true }),
        }),
      );
      // Deliberately the server's own (unrealistic) numbers, not "1" — this
      // proves the counter renders whatever the response says rather than
      // computing its own count of tiles toggled on screen.
      await vi.waitFor(() => {
        const text = counterText();
        expect(text).toContain("seleccionadas 99");
        expect(text).toContain("extras 86");
      });
    });

    it("shows the deselect state and toggles back off", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            asset: { id: "a1", isSelected: false, selectedAt: null },
            quota: {
              selected: 0,
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
              extras: 0,
              surchargeCop: 0,
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({ initialAssets: assetsFor([{ isSelected: true }]) });

      await user.click(screen.getByRole("button", { name: /Quitar de seleccionadas/ }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/assets/a1/selection",
        expect.objectContaining({ body: JSON.stringify({ selected: false }) }),
      );
    });

    it("shows an inline error and leaves the tile's prior state alone when the toggle request fails", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: "boom" })));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({ initialAssets: assetsFor([{ isSelected: false }]) });

      await user.click(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" }));

      await vi.waitFor(() =>
        expect(screen.getByText("No se pudo actualizar la selección.")).toBeDefined(),
      );
      // Still shows "Seleccionar", not "✓ Seleccionada" — the failed toggle
      // never flipped local state, because state is only ever set from a
      // confirmed response.
      expect(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" })).toBeDefined();
    });

    // Forces the exact race the #24 review flagged: two DIFFERENT assets
    // toggled in issue order A-then-B, but their responses resolve OUT OF
    // ORDER (B first, A last) — the normal shape of a phone connection, not
    // a contrived edge case. The counter must end up showing B's numbers
    // (the LAST thing actually issued), never A's, even though A's response
    // is literally the last thing to arrive.
    it("keeps the counter at the LATER-issued toggle's numbers when responses resolve out of order", async () => {
      const resolvers: ((value: Response) => void)[] = [];
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({ initialAssets: assetsFor([{ isSelected: false }, { isSelected: false }]) });

      // Issue order: a1 first, then a2.
      await user.click(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" }));
      await user.click(screen.getByRole("button", { name: "Seleccionar: IMG_0002.JPG" }));
      expect(resolvers).toHaveLength(2);

      // Resolve OUT OF ORDER: a2 (issued second) resolves FIRST.
      resolvers[1]!(
        jsonResponse(200, {
          asset: { id: "a2", isSelected: true, selectedAt: "2026-07-28T00:00:00.000Z" },
          quota: {
            selected: 15,
            includedPhotosSnapshot: 13,
            extraPhotoPriceCopSnapshot: 5_000,
            extras: 2,
            surchargeCop: 10_000,
          },
        }),
      );
      await vi.waitFor(() => {
        const text = counterText();
        expect(text).toContain("seleccionadas 15");
      });

      // a1 (issued FIRST) resolves LAST, with a lower, now-stale count.
      resolvers[0]!(
        jsonResponse(200, {
          asset: { id: "a1", isSelected: true, selectedAt: "2026-07-28T00:00:00.000Z" },
          quota: {
            selected: 14,
            includedPhotosSnapshot: 13,
            extraPhotoPriceCopSnapshot: 5_000,
            extras: 1,
            surchargeCop: 5_000,
          },
        }),
      );
      // Give the stale response's own microtasks a turn, then assert the
      // counter is STILL a2's numbers — the response from the
      // earlier-issued request must be discarded, not applied just because
      // it happened to arrive last.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const text = counterText();
      expect(text).toContain("seleccionadas 15");
      expect(text).toContain("extras 2");
    });

    // Task #67: `toggleSelection`'s `pendingIdsRef` early return is the
    // ACTUAL guard against a same-asset double toggle — the `disabled`
    // attribute driven off `pendingIds` state (see that ref's own header
    // comment) lags one render behind, so a test that clicks, awaits, then
    // clicks again would only ever prove the DOM's disabled attribute works,
    // never the ref. Both clicks are dispatched inside a single `act()`
    // instead: React (and this file's own `fireEvent`) only commits state
    // updates once the OUTERMOST `act()` call returns, so at the moment the
    // second click event is dispatched, the button element in the DOM is
    // still exactly as it was before the first click — not yet disabled.
    // Only `pendingIdsRef.current` (a plain synchronous ref, mutated
    // immediately, independent of any React commit) can have already
    // recorded the first click by the time the second one fires. Holding the
    // response open (never resolving `fetchMock`'s promise) rather than
    // asserting anything about timing is the acceptance criterion's own
    // requirement.
    it("issuing two clicks on the same tile before the first response arrives calls fetch only once", () => {
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialAssets: assetsFor([{ isSelected: false }]) });
      const button = screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" });

      act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // Task #25: the lock/submit wiring between <ProofGrid>, <SubmitSelectionPanel>,
  // and the per-tile/lightbox toggle buttons.
  describe("submission lock", () => {
    it("renders the submit button and enabled toggles for a gallery still in proofing", () => {
      renderGrid({ initialStatus: "proofing", initialAssets: assetsFor([{ isSelected: true }]) });

      expect(screen.getByRole("button", { name: "Enviar selección" })).toBeDefined();
      expect(screen.getByRole("button", { name: /Quitar de seleccionadas/ })).toHaveProperty(
        "disabled",
        false,
      );
    });

    it("starts locked — disabled toggles and the already-submitted message, no submit button — for a gallery already past proofing", () => {
      renderGrid({
        initialStatus: "selected",
        initialSubmittedAt: "2026-07-28T12:00:00.000Z",
        initialAssets: assetsFor([{ isSelected: true }]),
      });

      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
      // Pinned to the CORRECTED copy, not just the shared "Selección
      // enviada" prefix — see submit-selection-panel.test.tsx's own comment
      // on this exact assertion for why the prefix alone doesn't catch a
      // regression back to the dishonest "ya fue notificado" string.
      expect(screen.getByText(/tiene acceso/)).toBeDefined();
      expect(screen.getByRole("button", { name: /Quitar de seleccionadas/ })).toHaveProperty(
        "disabled",
        true,
      );
    });

    it("locks every toggle button and replaces the submit button with the confirmation message once a submission succeeds", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const submittedQuota = {
        selected: 1,
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        extras: 0,
        surchargeCop: 0,
      };
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            status: "submitted",
            quota: submittedQuota,
            submittedAt: "2026-07-28T12:00:00.000Z",
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({
        galleryId: "g1",
        initialStatus: "proofing",
        initialAssets: assetsFor([{ isSelected: true }]),
      });

      await user.click(screen.getByRole("button", { name: "Enviar selección" }));

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/submit-selection", {
        method: "POST",
      });
      // Pinned to the CORRECTED copy — see the previous test's own comment.
      await vi.waitFor(() => expect(screen.getByText(/tiene acceso/)).toBeDefined());
      expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
      expect(screen.getByRole("button", { name: /Quitar de seleccionadas/ })).toHaveProperty(
        "disabled",
        true,
      );
    });
  });

  // Task #147's own body: "probado — deshabilitar el control de selección
  // para tiles no elegidos cuando quota.extras > 0 queda verde en db78646
  // (100 tests) y también en la base c12589c (83 tests)." Meaning: the
  // invariant `proof-tile.tsx:165-167` reaffirms in a COMMENT — "never
  // blocks or scolds going over quota" — had NO test anywhere in this suite
  // that would go red if it were broken. These three do.
  describe("task #24 invariant: never blocks or scolds over quota", () => {
    it("keeps an unpicked tile's toggle enabled once the shared selection already exceeds the included quota", () => {
      renderGrid({
        initialAssets: assetsFor([
          { isSelected: true },
          { isSelected: true },
          { isSelected: false },
        ]),
        includedPhotosSnapshot: 1,
        extraPhotoPriceCopSnapshot: 5_000,
      });

      // quota.extras = max(0, 2 - 1) = 1, already over quota, with a third,
      // still-unpicked photo on screen.
      expect(screen.getByRole("button", { name: "Seleccionar: IMG_0003.JPG" })).toHaveProperty(
        "disabled",
        false,
      );
    });

    it("never renders any scolding, warning or limit copy while the selection is over the included quota", () => {
      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }, { isSelected: true }]),
        includedPhotosSnapshot: 1,
        extraPhotoPriceCopSnapshot: 5_000,
      });

      expect(screen.queryByText(/l[ií]mite/i)).toBeNull();
      expect(screen.queryByText(/excedi/i)).toBeNull();
      expect(screen.queryByText(/no se puede/i)).toBeNull();
      expect(screen.queryByText(/atenci[oó]n/i)).toBeNull();
    });

    it("still issues the real toggle request for a NEW pick made while already over quota", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            asset: { id: "a3", isSelected: true, selectedAt: "2026-07-28T00:00:00.000Z" },
            quota: {
              selected: 3,
              includedPhotosSnapshot: 1,
              extraPhotoPriceCopSnapshot: 5_000,
              extras: 2,
              surchargeCop: 10_000,
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({
        initialAssets: assetsFor([
          { isSelected: true },
          { isSelected: true },
          { isSelected: false },
        ]),
        includedPhotosSnapshot: 1,
        extraPhotoPriceCopSnapshot: 5_000,
      });

      await user.click(screen.getByRole("button", { name: "Seleccionar: IMG_0003.JPG" }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/assets/a3/selection",
        expect.objectContaining({ body: JSON.stringify({ selected: true }) }),
      );
    });
  });

  // Task #148: "selected explica qué pasa ahora en vez de mostrar controles
  // apagados." Additive to the existing tray/counter/submit-panel view
  // (see proof-grid.tsx's own "THREE STATES" header comment for why), not a
  // replacement of it.
  describe("selected state (task #148)", () => {
    it("explains what happens next instead of reading as only disabled controls", () => {
      renderGrid({
        initialStatus: "selected",
        initialSubmittedAt: "2026-07-28T12:00:00.000Z",
        initialAssets: assetsFor([{ isSelected: true }]),
      });

      expect(screen.getByText("¿Qué pasa ahora?")).toBeDefined();
      expect(screen.getByText(/escribile a tu fotógrafo/)).toBeDefined();
    });

    it("still shows the live quota counter while the client waits", () => {
      renderGrid({
        initialStatus: "selected",
        initialSubmittedAt: "2026-07-28T12:00:00.000Z",
        initialAssets: assetsFor([{ isSelected: true }, { isSelected: true }]),
        includedPhotosSnapshot: 1,
      });

      expect(counterText()).toContain("seleccionadas 2");
    });

    it("breaks the recap down per picker once more than one person actually picked something", () => {
      // The tray above (still rendered for `selected`, see this file's own
      // "THREE STATES" comment) attributes each PICK the same way — so this
      // queries the recap's own <dl>, not the page as a whole, since both
      // surfaces legitimately render "Vos"/"Beto Ruiz" at once.
      const { container } = renderGrid({
        initialStatus: "selected",
        initialSubmittedAt: "2026-07-28T12:00:00.000Z",
        initialAssets: assetsFor([{ isSelected: true }, { isSelected: true }]),
        viewerId: "client-a",
        initialPicks: [
          {
            assetId: "a1",
            selectedAt: "2026-07-28T11:00:00.000Z",
            pickedBy: { id: "client-a", label: "Ana Pérez" },
          },
          {
            assetId: "a2",
            selectedAt: "2026-07-28T11:05:00.000Z",
            pickedBy: { id: "client-b", label: "Beto Ruiz" },
          },
        ],
      });

      const recap = container.querySelector("dl");
      expect(recap).not.toBeNull();
      expect(recap?.textContent).toContain("Vos");
      expect(recap?.textContent).toContain("Beto Ruiz");
    });

    it("does not render a per-picker breakdown for a solo selection — there is nothing new it would tell the client", () => {
      const { container } = renderGrid({
        initialStatus: "selected",
        initialSubmittedAt: "2026-07-28T12:00:00.000Z",
        initialAssets: assetsFor([{ isSelected: true }]),
        viewerId: "client-a",
        initialPicks: [
          {
            assetId: "a1",
            selectedAt: "2026-07-28T11:00:00.000Z",
            pickedBy: { id: "client-a", label: "Ana Pérez" },
          },
        ],
      });

      expect(container.querySelector("dl")).toBeNull();
    });
  });

  // Task #148: "hoy [delivered] es la misma grilla con otros botones" — the
  // tray, the live counter and the submit panel are all retired once
  // delivered rather than merely disabled (see proof-grid.tsx's own "THREE
  // STATES" header comment).
  describe("delivered state (task #148)", () => {
    it("hides the tray, the live counter and the submit panel — none of them can still change anything", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: true, hasFinal: true }]),
      });

      expect(screen.queryByRole("region", { name: "Fotos elegidas" })).toBeNull();
      expect(screen.queryByText(/incluidas/)).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("states the photos are unwatermarked, and how many, in the delivered note", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { isSelected: true, hasFinal: true },
          { isSelected: true, hasFinal: true },
          { isSelected: false, hasFinal: false },
        ]),
      });

      expect(screen.getByText(/2 fotos editadas/)).toBeDefined();
      expect(screen.getByText(/sin marca de agua/)).toBeDefined();
    });

    it("does not render the delivered download-all affordance when nothing has a final yet", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: false, hasFinal: false }]),
      });

      expect(screen.queryByRole("link", { name: "Descargar todo" })).toBeNull();
    });
  });

  // Task #28: the delivered-gallery download affordance. `hasFinal` is a UI
  // hint only (see <ProofGrid>'s own comment on `ProofAsset.hasFinal`) — the
  // real gate is `GET /api/assets/[assetId]/final` itself, proven separately
  // in that route's own test suite. These tests only prove THIS component
  // renders the button in exactly the cases it should, and wires a click
  // through to a real download.
  describe("delivered gallery downloads", () => {
    it("does not render a download button for a non-delivered gallery, even for an asset with hasFinal", () => {
      renderGrid({
        initialStatus: "selected",
        initialAssets: assetsFor([{ isSelected: true, hasFinal: true }]),
      });

      expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    });

    it("does not render a download button for a delivered gallery's asset that has no final", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: false, hasFinal: false }]),
      });

      expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    });

    it("renders a download button for a delivered gallery's asset that has a final", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: true, hasFinal: true }]),
      });

      expect(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" })).toBeDefined();
    });

    it("clicking the download button fetches the final's presigned URL and navigates to it", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/final-download-url" })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      const user = userEvent.setup();

      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: true, hasFinal: true }]),
      });

      await user.click(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" }));

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/final"));
      await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
      // The anchor navigated to is the exact URL the route returned — this
      // is what carries the `Content-Disposition: attachment` header that
      // actually triggers a phone download (src/lib/r2.ts's own comment on
      // `getPresignedUrl`'s `contentDisposition` option); this test can't
      // observe that header itself (no real network call), only that the
      // component navigates to the URL the route handed it.
      const clickedAnchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
      expect(clickedAnchor.href).toBe("https://r2.example.com/final-download-url");
    });

    it("shows an inline error when the download request fails", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(jsonResponse(404, { error: "final_not_available" })),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: true, hasFinal: true }]),
      });

      await user.click(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" }));

      await vi.waitFor(() =>
        expect(screen.getByText("No se pudo descargar la foto.")).toBeDefined(),
      );
    });
  });

  // Task #29: the "download all" link — a UI hint only (see `hasAnyFinal`'s
  // own comment in proof-grid.tsx), same disclaimer as `hasFinal` above. The
  // real gate lives entirely server-side in
  // GET /api/galleries/[galleryId]/download-all's own test suite.
  describe("download-all link", () => {
    it("does not render for a non-delivered gallery, even with a hasFinal asset", () => {
      renderGrid({
        initialStatus: "selected",
        initialAssets: assetsFor([{ isSelected: true, hasFinal: true }]),
      });

      expect(screen.queryByRole("link", { name: "Descargar todo" })).toBeNull();
    });

    it("does not render for a delivered gallery where no asset has a final", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ isSelected: false, hasFinal: false }]),
      });

      expect(screen.queryByRole("link", { name: "Descargar todo" })).toBeNull();
    });

    it("renders, pointing at the gallery's own download-all route, once the gallery is delivered and at least one asset has a final", () => {
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { isSelected: false, hasFinal: false },
          { isSelected: true, hasFinal: true },
        ]),
      });

      const link = screen.getByRole("link", { name: "Descargar todo" });
      expect(link.getAttribute("href")).toBe("/api/galleries/g1/download-all");
    });
  });

  // Task #89. This component's half of "the client stops seeing the
  // watermark once the gallery is delivered": WHICH url each surface paints,
  // and which route it re-signs against when that url goes stale. Deciding
  // whether an asset gets a display url at all is the page's job (proven in
  // page.chrome.test.tsx) and unlocking the bytes is the route's (proven in
  // its own suite) — this file owns neither.
  describe("display derivative (task #89)", () => {
    it("paints the display url in the grid, in preference to the proof url", () => {
      const { container } = renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { hasFinal: true, displayUrl: "https://r2.example.com/display-1" },
        ]),
      });

      const img = container.querySelector("img") as HTMLImageElement;
      expect(img.src).toBe("https://r2.example.com/display-1");
    });

    // Grid AND lightbox, per the request — and from ONE seeded map rather
    // than two independent preference rules, which is what keeps them from
    // ever disagreeing about the same asset.
    it("paints the same display url in the lightbox", async () => {
      const user = userEvent.setup();
      renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { hasFinal: true, displayUrl: "https://r2.example.com/display-1" },
        ]),
      });

      await user.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));

      const lightboxImg = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
      expect(lightboxImg.src).toBe("https://r2.example.com/display-1");
    });

    it("still paints the proof url for an asset the page gave no display url", () => {
      const { container } = renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ hasFinal: false, displayUrl: null }]),
      });

      const img = container.querySelector("img") as HTMLImageElement;
      expect(img.src).toBe("https://r2.example.com/original-1");
    });

    // The mixed delivered gallery, in one render: some tiles unwatermarked,
    // some not, and nothing looks broken.
    it("mixes display and proof tiles in the same delivered gallery", () => {
      const { container } = renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { hasFinal: true, displayUrl: "https://r2.example.com/display-1" },
          { hasFinal: false, displayUrl: null },
        ]),
      });

      const srcs = Array.from(container.querySelectorAll("img")).map((img) => img.src);
      expect(srcs).toEqual([
        "https://r2.example.com/display-1",
        "https://r2.example.com/original-2",
      ]);
    });

    // The regression this exists to prevent: a display tile whose presigned
    // url has aged past its 5-minute TTL must be re-signed against the
    // DISPLAY route. Asking `/proof` here would silently put the watermark
    // back on a delivered photo the moment the client left the tab open.
    it("re-signs a stale display tile against the display route, not the proof route", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/display-refreshed" })),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { container } = renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { hasFinal: true, displayUrl: "https://r2.example.com/display-1" },
        ]),
      });

      const img = container.querySelector("img") as HTMLImageElement;
      fireEvent.error(img);

      await vi.waitFor(() => expect(img.src).toBe("https://r2.example.com/display-refreshed"));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/display");
    });

    // The safety net for a final uploaded BEFORE task #89 shipped: no display
    // object exists in R2 until `bun run backfill:display` runs, so the
    // display route answers 404 and the tile drops back to the watermarked
    // proof. Degraded, but correct — and it fails in the protective
    // direction, which is the right way for this particular thing to fail.
    it("falls back to the proof route when the display derivative was never generated", async () => {
      const fetchMock = vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/display")
            ? jsonResponse(404, { error: "display_not_generated" })
            : jsonResponse(200, { url: "https://r2.example.com/proof-refreshed" }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { container } = renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([
          { hasFinal: true, displayUrl: "https://r2.example.com/display-1" },
        ]),
      });

      const img = container.querySelector("img") as HTMLImageElement;
      fireEvent.error(img);

      await vi.waitFor(() => expect(img.src).toBe("https://r2.example.com/proof-refreshed"));
      expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/assets/a1/display");
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/assets/a1/proof");
    });

    // The inverse: an asset that never had a display url must NOT pay for a
    // speculative request to a route that will always refuse it.
    it("never asks the display route for an asset that was rendered from its proof", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/proof-refreshed" })),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { container } = renderGrid({
        initialStatus: "delivered",
        initialAssets: assetsFor([{ hasFinal: false, displayUrl: null }]),
      });

      fireEvent.error(container.querySelector("img") as HTMLImageElement);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/proof");
    });
  });

  // ==========================================================================
  // Task #95 — the live, collaborative layer
  // ==========================================================================
  //
  // Everything below drives the REAL polling loop on fake timers at the REAL
  // cadence (`SELECTION_POLL_INTERVAL_MS`, imported rather than copied), and
  // asserts on what a SECOND person's session would do to this one's screen.
  describe("live collaborative sync", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** The snapshot shape `GET /api/galleries/[galleryId]/selection` returns. */
    function snapshot(
      overrides: Partial<{
        status: GalleryStatus;
        submittedAt: string | null;
        picks: SelectionPick[];
        selectedCount: number;
      }> = {},
    ) {
      const picks = overrides.picks ?? [];
      return {
        status: overrides.status ?? "proofing",
        submittedAt: overrides.submittedAt ?? null,
        picks,
        quota: computeQuota(overrides.selectedCount ?? picks.length, {
          includedPhotosSnapshot: 13,
          extraPhotoPriceCopSnapshot: 5_000,
        }),
      };
    }

    function pickBy(assetId: string, id: string, label: string): SelectionPick {
      return {
        assetId,
        selectedAt: "2026-07-30T12:00:00.000Z",
        pickedBy: { id, label },
      };
    }

    /** Advances exactly one poll interval and lets the request settle.
     * `advanceTimersByTimeAsync` flushes microtasks between timers, which is
     * what makes the fetch's own `await`s resolve inside this act(). */
    async function onePollTick() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SELECTION_POLL_INTERVAL_MS);
      });
    }

    /** `fireEvent`, not `userEvent`, in this block ONLY: `userEvent` schedules
     * its own delays on real timers and deadlocks under `vi.useFakeTimers()`
     * (measured — every test that used it here timed out at 30s). These
     * assertions are about what a click's RESPONSE does to state, not about
     * pointer/keyboard fidelity, which the rest of this suite already covers
     * with `userEvent` on real timers. */
    async function clickAndSettle(element: HTMLElement) {
      await act(async () => {
        fireEvent.click(element);
      });
    }

    /** A `fetch` double that answers the poll route from a queue of
     * snapshots (the last one repeats once the queue drains) and the PATCH
     * selection route from a callback. */
    function liveFetch(options: {
      snapshots?: unknown[];
      pollFails?: boolean;
      onSelection?: (assetId: string, selected: boolean) => unknown;
    }) {
      const queue = [...(options.snapshots ?? [])];
      let last: unknown = snapshot();
      return vi.fn((url: string, init?: { body?: string }) => {
        if (url.startsWith("/api/galleries/")) {
          if (options.pollFails) return Promise.reject(new Error("offline"));
          if (queue.length > 0) last = queue.shift();
          return Promise.resolve(jsonResponse(200, last));
        }
        const assetId = url.split("/")[3]!;
        const selected = (JSON.parse(init?.body ?? "{}") as { selected: boolean }).selected;
        return Promise.resolve(
          jsonResponse(
            200,
            options.onSelection?.(assetId, selected) ?? {
              asset: {
                id: assetId,
                isSelected: selected,
                selectedAt: selected ? "2026-07-30T12:00:00.000Z" : null,
                pickedBy: selected ? { id: "client-a", label: "Ana Pérez" } : null,
              },
              quota: computeQuota(selected ? 1 : 0, {
                includedPhotosSnapshot: 13,
                extraPhotoPriceCopSnapshot: 5_000,
              }),
            },
          ),
        );
      });
    }

    it("does not poll on mount — the server render already provided the snapshot", () => {
      // One wasted request per page load per viewer, forever, is exactly the
      // kind of cost the transport decision was made to avoid.
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows a pick made by ANOTHER session in the tray, attributed, without a reload", async () => {
      const fetchMock = liveFetch({
        snapshots: [snapshot({ picks: [pickBy("a1", "client-b", "Beto Ruiz")] })],
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialAssets: assetsFor([{}, {}]) });
      expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();

      await onePollTick();

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
      expect(screen.getByText("Beto Ruiz")).toBeDefined();
      // And the grid tile agrees — the tray and the grid are two views of one
      // fact, never two independently-derived ones.
      expect(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      ).toBeDefined();
    });

    it("removes a pick that ANOTHER session deselected, from the tray and the tile alike", async () => {
      const fetchMock = liveFetch({ snapshots: [snapshot({ picks: [] })] });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }]),
        initialPicks: [pickBy("a1", "client-b", "Beto Ruiz")],
      });
      expect(screen.getByText("Beto Ruiz")).toBeDefined();

      await onePollTick();

      expect(screen.queryByText("Beto Ruiz")).toBeNull();
      expect(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" })).toBeDefined();
    });

    it("replaces the counter with the SERVER's recomputed quota on every accepted snapshot", async () => {
      const fetchMock = liveFetch({
        snapshots: [snapshot({ picks: [pickBy("a1", "client-b", "Beto")], selectedCount: 15 })],
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();

      await onePollTick();

      expect(counterText()).toContain("seleccionadas 15");
      expect(counterText()).toContain("extras 2");
    });

    it("goes read-only the moment ANOTHER session submits — no reload", async () => {
      // The most damaging failure this screen can have is a collaborator
      // still picking into a gallery somebody else already closed.
      const fetchMock = liveFetch({
        snapshots: [
          snapshot({
            status: "selected",
            submittedAt: "2026-07-30T13:00:00.000Z",
            picks: [pickBy("a1", "client-b", "Beto")],
          }),
        ],
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialAssets: assetsFor([{ isSelected: true }]) });
      expect(screen.getByRole("button", { name: /enviar selección/i })).toBeDefined();

      await onePollTick();

      expect(screen.queryByRole("button", { name: /enviar selección/i })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      ).toHaveProperty("disabled", true);
      expect(screen.getByText(/la selección ya fue enviada/i)).toBeDefined();
    });

    it("reopens when an admin unlocks a submitted selection, instead of staying stuck read-only", async () => {
      // Task #73's unlock used to need a page reload to reach an open tab.
      // Because the lock tracks the SERVER's status rather than latching, it
      // converges in both directions.
      const fetchMock = liveFetch({ snapshots: [snapshot({ status: "proofing" })] });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialStatus: "selected", initialSubmittedAt: "2026-07-30T13:00:00.000Z" });
      expect(screen.queryByRole("button", { name: /enviar selección/i })).toBeNull();

      await onePollTick();

      expect(screen.getByRole("button", { name: /enviar selección/i })).toBeDefined();
    });

    it("spends nothing polling a gallery whose selection can no longer change", async () => {
      // `delivered` and `archived` are terminal — PLAN.md §2's state machine
      // has no path back out toward the selectable statuses. A client leaving
      // a delivered gallery open for an hour issues ZERO polls.
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialStatus: "delivered", initialSubmittedAt: "2026-07-30T13:00:00.000Z" });

      await onePollTick();
      await onePollTick();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps polling a submitted-but-not-delivered gallery, because an admin can still unlock it", async () => {
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialStatus: "selected", initialSubmittedAt: "2026-07-30T13:00:00.000Z" });

      await onePollTick();

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
    });

    it("moves the client's OWN pick into the tray the instant the server confirms it, not a tick later", async () => {
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      await clickAndSettle(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" }));

      // Attributed as "Vos" — from the id the SERVER reported, not a local
      // assumption about who is clicking.
      expect(screen.getByText("Vos")).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalledWith("/api/galleries/g1/selection");
    });

    it("takes the pick back out of the tray when the client deselects it themselves", async () => {
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }]),
        initialPicks: [pickBy("a1", "client-a", "Ana Pérez")],
      });
      await clickAndSettle(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      );

      expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();
    });

    it("does NOT let a snapshot older than a confirmed local write undo that write", async () => {
      // THE conflict case, from the losing side. A poll is issued, then the
      // client picks a photo and the server confirms it, and only THEN does
      // the poll's response — a photograph of the moment before the write —
      // arrive. Applying it would flip the client's own just-confirmed pick
      // back for a whole interval before flipping it forward again.
      let resolvePoll: ((value: unknown) => void) | undefined;
      const fetchMock = vi.fn((url: string, init?: { body?: string }) => {
        if (url.startsWith("/api/galleries/")) {
          return new Promise((resolve) => {
            resolvePoll = resolve;
          });
        }
        const selected = (JSON.parse(init?.body ?? "{}") as { selected: boolean }).selected;
        return Promise.resolve(
          jsonResponse(200, {
            asset: {
              id: "a1",
              isSelected: selected,
              selectedAt: "2026-07-30T12:00:00.000Z",
              pickedBy: { id: "client-a", label: "Ana Pérez" },
            },
            quota: computeQuota(1, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      await onePollTick(); // poll issued, hangs

      await clickAndSettle(screen.getByRole("button", { name: "Seleccionar: IMG_0001.JPG" }));
      expect(screen.getByText("Vos")).toBeDefined();

      // The stale snapshot finally lands, still reporting nothing selected.
      await act(async () => {
        resolvePoll?.(jsonResponse(200, snapshot({ picks: [] })));
      });

      expect(screen.getByText("Vos")).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      ).toBeDefined();
    });

    it("drops a snapshot outright while a toggle of this session's own is still in flight", async () => {
      // The other half of the conflict rule: the in-flight request's own
      // response is fresher by construction, and it is about to arrive.
      let resolveToggle: ((value: unknown) => void) | undefined;
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith("/api/galleries/")) {
          return Promise.resolve(jsonResponse(200, snapshot({ picks: [] })));
        }
        return new Promise((resolve) => {
          resolveToggle = resolve;
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }]),
        initialPicks: [pickBy("a1", "client-a", "Ana Pérez")],
      });

      // Toggle issued and hanging; a poll lands in the middle of it.
      await clickAndSettle(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      );
      await onePollTick();

      // The snapshot said "nothing selected" — but it was dropped, so the tray
      // still shows what this session last knew rather than half-applying.
      expect(screen.getByText("Vos")).toBeDefined();

      await act(async () => {
        resolveToggle?.(
          jsonResponse(200, {
            asset: { id: "a1", isSelected: false, selectedAt: null, pickedBy: null },
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        );
      });

      expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();
    });

    it("stays quiet after a single failed poll — one blip on a phone is not news", async () => {
      const fetchMock = liveFetch({ pollFails: true });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialPicks: [pickBy("a1", "client-b", "Beto")] });

      await onePollTick();

      expect(screen.queryByText(/se perdió la conexión/i)).toBeNull();
    });

    it("admits the list may be stale after two failed polls in a row — WITHOUT clearing it", async () => {
      // Stale-but-honest beats silently-wrong. The picks on screen are the
      // last thing the server actually said.
      const fetchMock = liveFetch({ pollFails: true });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialPicks: [pickBy("a1", "client-b", "Beto")] });

      await onePollTick();
      await onePollTick();

      expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();
      expect(screen.getByText("Beto")).toBeDefined();
    });

    it("treats a refused poll exactly like a dropped connection, rather than blanking the tray", async () => {
      // A 403 here means this session lost access while the tab was open
      // (removed from the gallery, task #97). This component has no authority
      // to revoke anything itself, and every route it could still call
      // re-checks ownership on its own.
      const fetchMock = vi.fn((url: string) =>
        Promise.resolve(
          url.startsWith("/api/galleries/")
            ? jsonResponse(403, { error: "forbidden" })
            : jsonResponse(200, {}),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialPicks: [pickBy("a1", "client-b", "Beto")] });

      await onePollTick();
      await onePollTick();

      expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();
      expect(screen.getByText("Beto")).toBeDefined();
    });

    it("does NOT claim the list is fresh while every snapshot is being dropped for an in-flight toggle", async () => {
      // The window this closes: a PATCH hanging on a flaky connection keeps
      // `pendingIdsRef` non-empty, so every snapshot arriving meanwhile is
      // discarded by condition 1 — while the polls themselves keep succeeding.
      // Clearing the warning on a successful poll alone would tell the client
      // the tray is live at exactly the moment it is frozen. Stale-but-honest
      // beats silently-wrong.
      let resolveToggle: ((value: unknown) => void) | undefined;
      let pollFails = true;
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith("/api/galleries/")) {
          return pollFails
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(jsonResponse(200, snapshot({ picks: [] })));
        }
        return new Promise((resolve) => {
          resolveToggle = resolve;
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }]),
        initialPicks: [pickBy("a1", "client-a", "Ana Pérez")],
      });

      // Go stale first, the ordinary way.
      await onePollTick();
      await onePollTick();
      expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();

      // Now a toggle hangs, and the connection comes back. Polls succeed —
      // but their snapshots are all being dropped, so the warning must STAY.
      await clickAndSettle(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      );
      pollFails = false;
      await onePollTick();
      await onePollTick();

      expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();

      // Once the toggle lands, snapshots apply again and the warning clears on
      // the next successful poll — it is a pause, not a latch.
      await act(async () => {
        resolveToggle?.(
          jsonResponse(200, {
            asset: { id: "a1", isSelected: false, selectedAt: null, pickedBy: null },
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        );
      });
      await onePollTick();

      expect(screen.queryByText(/se perdió la conexión/i)).toBeNull();
    });

    it("does not invent a connection warning out of snapshots dropped for an in-flight toggle", async () => {
      // The other direction: a dropped snapshot is not a FAILURE either. The
      // network is fine, so nothing may count toward the staleness threshold.
      let resolveToggle: ((value: unknown) => void) | undefined;
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith("/api/galleries/")) {
          return Promise.resolve(jsonResponse(200, snapshot({ picks: [] })));
        }
        return new Promise((resolve) => {
          resolveToggle = resolve;
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }]),
        initialPicks: [pickBy("a1", "client-a", "Ana Pérez")],
      });

      await clickAndSettle(
        screen.getByRole("button", { name: "Quitar de seleccionadas: IMG_0001.JPG" }),
      );
      await onePollTick();
      await onePollTick();
      await onePollTick();

      expect(screen.queryByText(/se perdió la conexión/i)).toBeNull();

      await act(async () => {
        resolveToggle?.(
          jsonResponse(200, {
            asset: { id: "a1", isSelected: false, selectedAt: null, pickedBy: null },
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        );
      });
    });

    it("clears the staleness warning as soon as a poll succeeds again", async () => {
      let failing = true;
      const fetchMock = vi.fn((url: string) => {
        if (!url.startsWith("/api/galleries/")) return Promise.resolve(jsonResponse(200, {}));
        return failing
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(
              jsonResponse(200, snapshot({ picks: [pickBy("a1", "client-b", "Beto")] })),
            );
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      await onePollTick();
      await onePollTick();
      expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();

      failing = false;
      await onePollTick();

      expect(screen.queryByText(/se perdió la conexión/i)).toBeNull();
      expect(screen.getByText("Beto")).toBeDefined();
    });

    it("stops polling when the tab is hidden, and catches up the moment it comes back", async () => {
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();

      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      await onePollTick();
      await onePollTick();
      expect(fetchMock).not.toHaveBeenCalled();

      hidden.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
    });

    it("stops polling entirely once unmounted", async () => {
      const fetchMock = liveFetch({});
      vi.stubGlobal("fetch", fetchMock);

      const { unmount } = renderGrid();
      unmount();

      await onePollTick();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Task #114 — the push transport itself: the SSE wiring, and the two
  // things its own acceptance criteria call out as easy to leave untested
  // (EventSource reconnects on its own, which is convenient right up until
  // it means nobody proves the reconnect path does what it should).
  // ==========================================================================
  describe("push transport (SSE, task #114)", () => {
    /** A minimal double for the browser's own `EventSource` — records every
     * constructed instance (a fresh gallery id or a status leaving
     * LIVE_SYNC_STATUSES tears the old one down and, if still live, opens a
     * new one) and lets a test fire a named event directly, exactly like a
     * real server-sent `event: ready`/`event: changed` line would. */
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      url: string;
      closed = false;
      private listeners: Record<string, (() => void)[]> = {};

      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }

      addEventListener(type: string, callback: () => void) {
        (this.listeners[type] ??= []).push(callback);
      }

      close() {
        this.closed = true;
      }

      /** Simulates the server sending `event: <type>\ndata: 1\n\n`. */
      emit(type: string) {
        for (const callback of this.listeners[type] ?? []) callback();
      }
    }

    beforeEach(() => {
      vi.useFakeTimers();
      FakeEventSource.instances = [];
      vi.stubGlobal("EventSource", FakeEventSource);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("opens a stream at this gallery's own stream endpoint while the selection can still change", () => {
      vi.stubGlobal("fetch", vi.fn());

      renderGrid({ galleryId: "g1", initialStatus: "proofing" });

      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0]!.url).toBe("/api/galleries/g1/selection/stream");
    });

    it("never opens a stream for a gallery whose selection can no longer change", () => {
      vi.stubGlobal("fetch", vi.fn());

      renderGrid({ initialStatus: "delivered" });

      expect(FakeEventSource.instances).toHaveLength(0);
    });

    it("does NOT refetch on the very first `ready` — the server-rendered page already gave a fresh snapshot", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      await act(async () => {
        FakeEventSource.instances[0]!.emit("ready");
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refetches on a SECOND `ready` — that can only mean the stream just reconnected", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            status: "proofing",
            submittedAt: null,
            picks: [],
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      const source = FakeEventSource.instances[0]!;
      await act(async () => {
        source.emit("ready"); // first connect — no-op
      });
      expect(fetchMock).not.toHaveBeenCalled();

      await act(async () => {
        source.emit("ready"); // reconnect — a notification could have been missed
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
    });

    it("refetches immediately on a `changed` push, without waiting for the fallback interval", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            status: "proofing",
            submittedAt: null,
            picks: [
              {
                assetId: "a1",
                selectedAt: "2026-07-30T12:00:00.000Z",
                pickedBy: { id: "client-b", label: "Beto Ruiz" },
              },
            ],
            quota: computeQuota(1, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialAssets: assetsFor([{}, {}]) });

      await act(async () => {
        FakeEventSource.instances[0]!.emit("changed");
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/selection");
      expect(screen.getByText("Beto Ruiz")).toBeDefined();
    });

    it("queues exactly one more fetch when a `changed` push arrives while a fetch is already in flight", async () => {
      // The race this closes: a fallback tick (or an earlier push) is
      // mid-flight when a NEW push arrives. Silently dropping it (the way a
      // plain interval always could, harmlessly, because its next tick was
      // seconds away regardless) would mean waiting for the NEXT push or the
      // 30s fallback — a real regression from "well under a second" once
      // pushes can legitimately arrive close together.
      let resolveFirst: ((value: Response) => void) | undefined;
      let callCount = 0;
      const fetchMock = vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(
          jsonResponse(200, {
            status: "proofing",
            submittedAt: null,
            picks: [],
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      renderGrid();
      const source = FakeEventSource.instances[0]!;

      // First push — fetch #1 issued, hangs.
      await act(async () => {
        source.emit("changed");
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second push arrives WHILE #1 is still in flight — queued, not lost.
      await act(async () => {
        source.emit("changed");
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // #1 finally resolves — the queued refresh fires immediately after.
      await act(async () => {
        resolveFirst?.(
          jsonResponse(200, {
            status: "proofing",
            submittedAt: null,
            picks: [],
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        );
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("closes the stream on unmount", () => {
      vi.stubGlobal("fetch", vi.fn());

      const { unmount } = renderGrid();
      const source = FakeEventSource.instances[0]!;
      expect(source.closed).toBe(false);

      unmount();

      expect(source.closed).toBe(true);
    });

    it("closes the stream and opens no replacement once a push moves the gallery to a terminal status", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            // `archived` is terminal (PLAN.md §2) — not a status the real
            // polling route would hand this component via a "changed" push
            // in practice, but this proves the EFFECT's own teardown wiring
            // reacts to `status` leaving LIVE_SYNC_STATUSES regardless of
            // how it got there, matching the fallback-poll effect's
            // identical `if (!LIVE_SYNC_STATUSES.has(status)) return;` gate.
            status: "archived",
            submittedAt: "2026-07-30T13:00:00.000Z",
            picks: [],
            quota: computeQuota(0, {
              includedPhotosSnapshot: 13,
              extraPhotoPriceCopSnapshot: 5_000,
            }),
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      renderGrid({ initialStatus: "proofing" });
      const source = FakeEventSource.instances[0]!;
      expect(FakeEventSource.instances).toHaveLength(1);

      await act(async () => {
        source.emit("changed");
      });

      expect(source.closed).toBe(true);
      // No SECOND instance opened for the now-terminal status.
      expect(FakeEventSource.instances).toHaveLength(1);
    });
  });
});
