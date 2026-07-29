// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofGrid } from "./proof-grid";
import type { ProofAsset } from "./proof-grid";

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
      packageName="Estándar"
      includedPhotosSnapshot={13}
      extraPhotoPriceCopSnapshot={5_000}
      {...overrides}
    />,
  );
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

  it("reserves each tile's aspect ratio from proofWidth/proofHeight before the image ever loads", () => {
    const { container } = renderGrid({
      initialAssets: assetsFor([{ proofWidth: 1600, proofHeight: 1067 }]),
    });

    const img = container.querySelector("img");
    const wrapper = img?.parentElement;
    expect(wrapper?.getAttribute("style")).toContain("aspect-ratio: 1600 / 1067");
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

  describe("live quota counter", () => {
    it("renders the initial counter computed from the assets' own isSelected flags and the snapshot terms", () => {
      renderGrid({
        initialAssets: assetsFor([{ isSelected: true }, { isSelected: true }, {}]),
        includedPhotosSnapshot: 1,
        extraPhotoPriceCopSnapshot: 5_000,
      });

      const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
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
        const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
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
        const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
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
      const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
      expect(text).toContain("seleccionadas 15");
      expect(text).toContain("extras 2");
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
});
