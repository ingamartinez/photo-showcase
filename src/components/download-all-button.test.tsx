// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DownloadAllButton } from "./download-all-button";

afterEach(() => {
  cleanup();
});

describe("DownloadAllButton", () => {
  it("renders a same-origin link straight to the gallery's own download-all route", () => {
    render(<DownloadAllButton galleryId="g1" />);

    const link = screen.getByRole("link", { name: "Descargar todo" });
    expect(link.getAttribute("href")).toBe("/api/galleries/g1/download-all");
  });

  it("never carries target=_blank or window.open — a plain same-tab navigation, same reasoning as DownloadFinalButton's own click-to-navigate flow", () => {
    render(<DownloadAllButton galleryId="g1" />);

    const link = screen.getByRole("link", { name: "Descargar todo" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBe("noopener");
  });
});
