// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishGalleryButton } from "./publish-gallery-button";
import type { PublishGalleryState } from "@/app/dashboard/galleries/actions";

const publishGalleryMock =
  vi.fn<(state: PublishGalleryState, formData: FormData) => Promise<PublishGalleryState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  publishGallery: (...args: [PublishGalleryState, FormData]) => publishGalleryMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  publishGalleryMock.mockReset();
});

describe("PublishGalleryButton", () => {
  it("renders a submit button carrying the gallery id as a hidden field", async () => {
    publishGalleryMock.mockResolvedValue({ status: "published" });
    const user = userEvent.setup();
    render(<PublishGalleryButton galleryId={GALLERY_ID} clientEmails={["ana@example.com"]} />);

    await user.click(screen.getByRole("button", { name: "Publicar galería" }));

    const [, formData] = publishGalleryMock.mock.calls[0] as [PublishGalleryState, FormData];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
  });

  it("shows a confirmation naming the client's email once published", async () => {
    publishGalleryMock.mockResolvedValue({ status: "published" });
    const user = userEvent.setup();
    render(<PublishGalleryButton galleryId={GALLERY_ID} clientEmails={["ana@example.com"]} />);

    await user.click(screen.getByRole("button", { name: "Publicar galería" }));

    await screen.findByRole("status");
    expect(screen.getByText(/ana@example\.com/)).toBeDefined();
    // The button is gone once published — nothing left to click again from
    // this render (a fresh page load re-derives its visibility from the
    // gallery's real, server-side status instead).
    expect(screen.queryByRole("button", { name: "Publicar galería" })).toBeNull();
  });

  // Task #94: a gallery can have several clients now — the confirmation
  // must name all of them, not just the first.
  it("shows a confirmation naming every client's email when the gallery has several", async () => {
    publishGalleryMock.mockResolvedValue({ status: "published" });
    const user = userEvent.setup();
    render(
      <PublishGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={["ana@example.com", "beto@example.com"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Publicar galería" }));

    await screen.findByRole("status");
    expect(screen.getByText(/ana@example\.com, beto@example\.com/)).toBeDefined();
  });

  it("shows the error message returned by the action and keeps the button available to retry", async () => {
    publishGalleryMock.mockResolvedValue({
      status: "error",
      message: "Subí al menos una foto antes de publicar la galería.",
    });
    const user = userEvent.setup();
    render(<PublishGalleryButton galleryId={GALLERY_ID} clientEmails={["ana@example.com"]} />);

    await user.click(screen.getByRole("button", { name: "Publicar galería" }));

    await screen.findByRole("alert");
    expect(screen.getByText("Subí al menos una foto antes de publicar la galería.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Publicar galería" })).toBeDefined();
  });
});
