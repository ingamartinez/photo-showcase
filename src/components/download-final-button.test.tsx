// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DownloadFinalButton } from "./download-final-button";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DownloadFinalButton", () => {
  it("fetches the final's presigned URL and navigates to it via a clicked anchor", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/final-a1.jpg" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<DownloadFinalButton assetId="a1" originalFilename="IMG_0001.JPG" />);

    await user.click(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/final");
    await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const clickedAnchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(clickedAnchor.href).toBe("https://r2.example.com/final-a1.jpg");
    // The anchor is a one-shot navigation trigger, not left sitting in the
    // DOM — it's appended and removed around the single `.click()` call.
    expect(document.body.contains(clickedAnchor)).toBe(false);
  });

  it("shows an inline error and never navigates when the route responds with an error status", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { error: "final_not_available" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<DownloadFinalButton assetId="a1" originalFilename="IMG_0001.JPG" />);

    await user.click(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" }));

    await vi.waitFor(() => expect(screen.getByText("No se pudo descargar la foto.")).toBeDefined());
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("shows a connection error and never navigates when fetch itself rejects", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<DownloadFinalButton assetId="a1" originalFilename="IMG_0001.JPG" />);

    await user.click(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" }));

    await vi.waitFor(() => expect(screen.getByText("No se pudo conectar.")).toBeDefined());
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("disables the button while a download request is in flight", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<DownloadFinalButton assetId="a1" originalFilename="IMG_0001.JPG" />);

    const button = screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" });
    await user.click(button);

    expect(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" })).toHaveProperty(
      "disabled",
      true,
    );

    resolveFetch?.(jsonResponse(200, { url: "https://r2.example.com/final-a1.jpg" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });
});
