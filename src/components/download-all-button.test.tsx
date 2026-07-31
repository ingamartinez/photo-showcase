// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
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

  // Task #148: "a big gallery takes real time on mobile data — if that time
  // is invisible the client taps three times and starts three downloads."
  // The FIRST click must be allowed to proceed (its default navigation is
  // what actually triggers the download) while entering a visible "this
  // takes a while" state.
  it("lets the first click proceed and shows a 'preparing' state", () => {
    render(<DownloadAllButton galleryId="g1" />);
    const link = screen.getByRole("link", { name: "Descargar todo" });

    const clickEvent = createEvent.click(link);
    const preventDefaultSpy = vi.spyOn(clickEvent, "preventDefault");
    fireEvent(link, clickEvent);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Preparando tu descarga…")).toBeDefined();
    expect(link.getAttribute("aria-disabled")).toBe("true");
  });

  // The acceptance criterion itself: a SECOND tap, while the first
  // download is still in flight, must not start a second concurrent stream
  // of the whole zip archive.
  it("blocks a second tap while the first download is still in flight", () => {
    render(<DownloadAllButton galleryId="g1" />);
    const link = screen.getByRole("link", { name: "Descargar todo" });

    fireEvent.click(link);

    const secondClick = createEvent.click(link);
    const preventDefaultSpy = vi.spyOn(secondClick, "preventDefault");
    fireEvent(link, secondClick);

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the asset count while preparing, when given one", () => {
    render(<DownloadAllButton galleryId="g1" assetCount={15} />);

    fireEvent.click(screen.getByRole("link", { name: "Descargar todo" }));

    expect(screen.getByText(/15 fotos/)).toBeDefined();
    expect(screen.getByText(/no cierres esta pestaña/)).toBeDefined();
  });

  it("still shows the 'do not close this tab' note without an asset count", () => {
    render(<DownloadAllButton galleryId="g1" />);

    fireEvent.click(screen.getByRole("link", { name: "Descargar todo" }));

    expect(screen.getByText(/no cierres esta pestaña/)).toBeDefined();
  });

  // Review finding: `${baseClassName}${isPending ? "opacity-60" : ""}` (plain
  // template-string concatenation, no separating space) glued the pending
  // dim class onto the LAST base class instead of appending it as its own
  // token — `transition-colorsopacity-60`, a single string neither Tailwind
  // nor anything else recognizes. `.toContain("opacity-60")` would have
  // passed against that exact bug (the substring is still in there); this
  // splits the className on whitespace and checks each Tailwind class
  // survives as its OWN array entry, which is the only assertion shape that
  // actually distinguishes "two classes" from "one mangled one".
  it("keeps the pending dim class a separate token from the base classes, not merged into one invalid one", () => {
    render(<DownloadAllButton galleryId="g1" />);
    const link = screen.getByRole("link", { name: "Descargar todo" });

    fireEvent.click(link);

    const classes = link.className.split(/\s+/);
    expect(classes).toContain("transition-colors");
    expect(classes).toContain("opacity-60");
  });
});
