// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditGalleryTermsDialog } from "./edit-gallery-terms-dialog";
import type { UpdateGalleryTermsState } from "@/app/dashboard/galleries/actions";

const updateGalleryTermsMock =
  vi.fn<(state: UpdateGalleryTermsState, formData: FormData) => Promise<UpdateGalleryTermsState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  updateGalleryTerms: (...args: [UpdateGalleryTermsState, FormData]) =>
    updateGalleryTermsMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  updateGalleryTermsMock.mockReset();
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Editar términos" }));
  return screen.findByRole("dialog");
}

describe("EditGalleryTermsDialog — fields", () => {
  it("pre-fills all three fields with the gallery's current effective values", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="proofing"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);

    // No jest-dom is wired into this Vitest setup (no `setupFiles`), so
    // `toHaveValue` does not exist here — reading `.value` off the DOM node
    // is the honest equivalent (same reasoning as dashboard-nav.test.tsx's
    // own `currentAttributeOf` helper).
    expect(within(dialog).getByLabelText<HTMLInputElement>("Fotos incluidas").value).toBe("13");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Precio foto extra, COP").value).toBe(
      "5000",
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>("Precio foto original, COP").value).toBe(
      "2000",
    );
  });

  it("marks all three fields required — unlike creation, an edit has no meaningful empty value", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="draft"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);

    expect(within(dialog).getByLabelText<HTMLInputElement>("Fotos incluidas").required).toBe(true);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Precio foto extra, COP").required).toBe(
      true,
    );
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Precio foto original, COP").required,
    ).toBe(true);
  });

  it("submits the gallery id and the typed values, including the original photo price", async () => {
    updateGalleryTermsMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="draft"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);
    const includedPhotosField = within(dialog).getByLabelText("Fotos incluidas");
    await user.clear(includedPhotosField);
    await user.type(includedPhotosField, "20");
    const extraPriceField = within(dialog).getByLabelText("Precio foto extra, COP");
    await user.clear(extraPriceField);
    await user.type(extraPriceField, "0");
    const originalPriceField = within(dialog).getByLabelText("Precio foto original, COP");
    await user.clear(originalPriceField);
    await user.type(originalPriceField, "3000");
    await user.click(within(dialog).getByRole("button", { name: "Guardar términos" }));

    const [, formData] = updateGalleryTermsMock.mock.calls[0] as [
      UpdateGalleryTermsState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("includedPhotos")).toBe("20");
    expect(formData.get("extraPhotoPriceCop")).toBe("0");
    expect(formData.get("originalPhotoPriceCop")).toBe("3000");
  });

  it("shows the server's error message and keeps the form open to retry", async () => {
    updateGalleryTermsMock.mockResolvedValue({
      status: "error",
      message: "El tope de fotos incluidas tiene que ser un entero mayor o igual a 0.",
    });
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="draft"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar términos" }));

    await within(dialog).findByRole("alert");
    expect(
      within(dialog).getByText(
        "El tope de fotos incluidas tiene que ser un entero mayor o igual a 0.",
      ),
    ).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Guardar términos" })).toBeDefined();
  });

  it("shows a plain success message and keeps the form open (no auto-close)", async () => {
    updateGalleryTermsMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="draft"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar términos" }));

    await within(dialog).findByRole("status");
    expect(within(dialog).getByText("Términos actualizados.")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });
});

// Criterion 8 — the notice's presence is gated on the gallery's STATUS
// (whether a client could have already seen these terms), and its NUMBERS
// come straight from `computeQuota()`, never re-derived here.
describe("EditGalleryTermsDialog — before/after notice", () => {
  it("does NOT show the notice for an empty draft gallery — no client has seen anything yet", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="draft"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);

    expect(within(dialog).queryByText(/El cliente ve hoy/)).toBeNull();
    expect(within(dialog).queryByText(/Va a ver/)).toBeNull();
  });

  it("shows correct before/after numbers, via computeQuota, for a gallery with a selection already made", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="selected"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        // 22 selected against the starting terms (13 included, $5.000/extra)
        // keeps `extras`/`surchargeCop` strictly positive on BOTH sides —
        // same reasoning as actions.terms.test.ts's own rebuilt "changes
        // what the client would see" test (task #200's review round 1). A
        // pair that lands on 0 either side (e.g. 15 selected / 20 included)
        // cannot discriminate a mutation that ignores the typed price, since
        // `extras` clamps to 0 and `0 × anything` is 0 regardless.
        selectedCount={22}
      />,
    );

    const dialog = await openDialog(user);

    // Before: computeQuota(22, 0, {13, 5000, 2000}) => extras 9, surcharge
    // 45_000, originalPhotoPriceCopSnapshot passed through unchanged as 2_000.
    expect(
      within(dialog).getByText(
        "El cliente ve hoy: 13 incluidas · 9 extras · $ 45.000 · original $ 2.000",
      ),
    ).toBeDefined();

    const includedPhotosField = within(dialog).getByLabelText("Fotos incluidas");
    await user.clear(includedPhotosField);
    await user.type(includedPhotosField, "20");
    const extraPriceField = within(dialog).getByLabelText("Precio foto extra, COP");
    await user.clear(extraPriceField);
    await user.type(extraPriceField, "2000");
    const originalPriceField = within(dialog).getByLabelText("Precio foto original, COP");
    await user.clear(originalPriceField);
    await user.type(originalPriceField, "9000");

    // After: computeQuota(22, 0, {20, 2000, 9000}) => extras 2, surcharge
    // 4_000. `originalPhotoPriceCopSnapshot` reflects the NEWLY TYPED 9_000
    // even though `selectedOriginal` is 0 here and the surcharge itself
    // doesn't move because of it — this is the row that proves the typed
    // original price actually reaches the preview.
    expect(
      within(dialog).getByText("Va a ver: 20 incluidas · 2 extras · $ 4.000 · original $ 9.000"),
    ).toBeDefined();

    // THE FIX (task #200 review round 1): the "hoy" row must stay pinned to
    // the gallery's SAVED snapshot — never drift to follow what is
    // mid-typed below it. Without this assertion, a bug that reads the
    // "hoy" row off the live inputs instead of the `includedPhotosSnapshot`/
    // `extraPhotoPriceCopSnapshot`/`originalPhotoPriceCopSnapshot` props
    // would show the admin "lo que el cliente ve hoy" as the numbers they
    // are ABOUT to save — the most misleading failure this screen could
    // produce — and nothing above catches it, because the only prior
    // assertion on this row ran BEFORE any typing happened.
    expect(
      within(dialog).getByText(
        "El cliente ve hoy: 13 incluidas · 9 extras · $ 45.000 · original $ 2.000",
      ),
    ).toBeDefined();
  });

  it("still shows the notice for a published gallery with nobody selected yet", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="proofing"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={0}
      />,
    );

    const dialog = await openDialog(user);

    expect(
      within(dialog).getByText(
        "El cliente ve hoy: 13 incluidas · 0 extras · $ 0 · original $ 2.000",
      ),
    ).toBeDefined();
  });

  // The trap the task body names explicitly: `0` in any field is a
  // legitimate value, and the preview must reflect it accurately rather than
  // treating it as "no input".
  it("reflects a typed 0 in the preview rather than falling back to the original value", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="selected"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={5}
      />,
    );

    const dialog = await openDialog(user);
    const includedPhotosField = within(dialog).getByLabelText("Fotos incluidas");
    await user.clear(includedPhotosField);
    await user.type(includedPhotosField, "0");

    // computeQuota(5, 0, {0, 5000, 2000}) => extras 5, surcharge 25_000.
    expect(
      within(dialog).getByText("Va a ver: 0 incluidas · 5 extras · $ 25.000 · original $ 2.000"),
    ).toBeDefined();
  });

  // Criterion 6, this component's own corner of it: `0` typed into the NEW
  // original-price field specifically (not the included-photos field the
  // test above already covers) must show as $0, not fall back to the
  // gallery's actual current price or hide the row.
  it("reflects a typed 0 in the original-photo-price field, distinct from leaving it untouched", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="selected"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={5}
      />,
    );

    const dialog = await openDialog(user);
    const originalPriceField = within(dialog).getByLabelText("Precio foto original, COP");
    await user.clear(originalPriceField);
    await user.type(originalPriceField, "0");

    // computeQuota(5, 0, {13, 5000, 0}) => extras 0 (under quota), surcharge
    // 0, originalPhotoPriceCopSnapshot 0 (the typed value, not the gallery's
    // real 2_000).
    expect(
      within(dialog).getByText("Va a ver: 13 incluidas · 0 extras · $ 0 · original $ 0"),
    ).toBeDefined();
  });

  it("hides the 'Va a ver' row while a field is empty mid-edit, instead of showing a wrong preview", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="selected"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={5}
      />,
    );

    const dialog = await openDialog(user);
    const includedPhotosField = within(dialog).getByLabelText("Fotos incluidas");
    await user.clear(includedPhotosField);

    expect(within(dialog).queryByText(/Va a ver/)).toBeNull();
    // The "hoy" row survives — it never depends on the in-progress edit.
    expect(within(dialog).getByText(/El cliente ve hoy/)).toBeDefined();
  });

  // Same emptiness guard as the included-photos/extra-price fields, applied
  // to the new original-price field: clearing IT specifically must also
  // suppress the preview, not just clearing one of the other two.
  it("hides the 'Va a ver' row while the original-photo-price field is empty mid-edit", async () => {
    const user = userEvent.setup();
    render(
      <EditGalleryTermsDialog
        galleryId={GALLERY_ID}
        status="selected"
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedCount={5}
      />,
    );

    const dialog = await openDialog(user);
    const originalPriceField = within(dialog).getByLabelText("Precio foto original, COP");
    await user.clear(originalPriceField);

    expect(within(dialog).queryByText(/Va a ver/)).toBeNull();
    expect(within(dialog).getByText(/El cliente ve hoy/)).toBeDefined();
  });
});
