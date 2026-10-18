// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryClientRow } from "./gallery-client-row";
import type { GalleryClientSelectionActionState } from "@/app/dashboard/galleries/actions";
import { toClientSelectionView, type ClientSelectionView } from "@/lib/client-selection-state";
import { computeQuota } from "@/lib/quota";
import type { AttributionDelta } from "@/lib/pick-plans";
import type { AttributionShare } from "@/lib/quota-attribution";

type ActionFn = (
  state: GalleryClientSelectionActionState,
  formData: FormData,
) => Promise<GalleryClientSelectionActionState>;
const lockMock = vi.fn<ActionFn>();
const unlockMock = vi.fn<ActionFn>();
const removeMock = vi.fn<ActionFn>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  lockGalleryClientSelection: (...args: Parameters<ActionFn>) => lockMock(...args),
  unlockGalleryClientSelection: (...args: Parameters<ActionFn>) => unlockMock(...args),
  removeGalleryClientPicks: (...args: Parameters<ActionFn>) => removeMock(...args),
  removeGalleryClient: vi.fn(),
  resendGalleryAccessEmail: vi.fn(),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT = { id: "u1", name: "Ana Pérez", email: "ana@example.com" };
const SENT = new Date("2026-10-12T15:00:00Z");

const share = (overrides: Partial<AttributionShare> = {}): AttributionShare => ({
  included: 0,
  extras: 0,
  originals: 0,
  extrasSurchargeCop: 0,
  originalsSurchargeCop: 0,
  surchargeCop: 0,
  ...overrides,
});

const TERMS = {
  includedPhotosSnapshot: 1,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

// What the page would have computed at render from `previewByClient` — the
// SAME planner the action executes. THREE parties, deliberately (task #263 fix
// round, C2): the block's job is to show WHO moves and what the gallery's own
// total does, so the fixture has to make a preview that renders only the first
// person, hides the "Sin registro" bucket, or mislabels the gallery surcharge
// fail somewhere.
//
// The numbers hold the S3 invariant on BOTH sides — Σ people + "Sin registro"
// = Σ the gallery's own surcharge:
//   before: Ana 2.000 (1 original) + unattr 5.000 (1 extra)          = 7.000
//   after:  Beto 10.000 (2 extras)                                   = 10.000
// Ana loses her original, Beto takes two extras, and the legacy bucket moves
// from the extra slot into the included one.
const DELTA: AttributionDelta = {
  gallery: { before: computeQuota(2, 1, TERMS), after: computeQuota(3, 0, TERMS) },
  people: [
    {
      userId: "u1",
      label: "Ana Pérez",
      before: share({
        included: 1,
        originals: 1,
        originalsSurchargeCop: 2_000,
        surchargeCop: 2_000,
      }),
      after: share(),
    },
    {
      userId: "u2",
      label: "Beto Gómez",
      before: share(),
      after: share({ extras: 2, extrasSurchargeCop: 10_000, surchargeCop: 10_000 }),
    },
  ],
  unattributed: {
    before: share({ extras: 1, extrasSurchargeCop: 5_000, surchargeCop: 5_000 }),
    after: share({ included: 1 }),
  },
  assets: [
    { assetId: "a1", op: "unclaim" },
    { assetId: "a2", op: "claim" },
  ],
};
const PREVIEW = { lock: DELTA, removePicks: DELTA };

afterEach(() => {
  cleanup();
  lockMock.mockReset();
  lockMock.mockResolvedValue({
    status: "done",
    message: "Bloqueamos la selección.",
    delta: DELTA,
  });
  unlockMock.mockReset();
  unlockMock.mockResolvedValue({ status: "done", message: "Desbloqueamos la selección." });
  removeMock.mockReset();
  removeMock.mockResolvedValue({ status: "done", message: "Quitamos las fotos.", delta: DELTA });
});

function renderRow(
  selection: ClientSelectionView | undefined,
  status: Parameters<typeof GalleryClientRow>[0]["status"] = "proofing",
  extra: {
    removable?: boolean;
    resendable?: boolean;
    preview?: { lock: AttributionDelta; removePicks: AttributionDelta };
  } = {},
) {
  return render(
    <GalleryClientRow
      galleryId={GALLERY_ID}
      client={CLIENT}
      status={status}
      removable={extra.removable ?? false}
      resendable={extra.resendable ?? false}
      selection={selection}
      preview={extra.preview}
    />,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: `Acciones para ${CLIENT.name}` }));
}

const view = (input: {
  lockedAt?: Date | null;
  submittedAt?: Date | null;
  person?: { yours: number; shared: number; edited: number; toSend: number };
}) =>
  toClientSelectionView({
    lockedAt: input.lockedAt ?? null,
    submittedAt: input.submittedAt ?? null,
    person: input.person ?? { yours: 0, shared: 0, edited: 0, toSend: 0 },
  });

const OPEN = view({ person: { yours: 3, shared: 0, edited: 0, toSend: 0 } });
// Epic #250, decision 10: a submit does NOT lock, so the ordinary post-submit
// state has `submittedAt` set and `lockedAt` NULL.
const SUBMITTED = view({
  submittedAt: SENT,
  person: { yours: 1, shared: 0, edited: 0, toSend: 0 },
});
const LOCKED = view({ lockedAt: SENT });

describe("per-client selection — state line (inline)", () => {
  it("shows the four-number tally and the three states, in tuteo", () => {
    const { unmount } = renderRow(OPEN);
    expect(
      screen.getByText("pedidas 3 · compartidas 0 · editadas 0 · por enviar 0 · Eligiendo"),
    ).toBeDefined();
    unmount();
    const second = renderRow(SUBMITTED);
    expect(
      screen.getByText(
        "pedidas 1 · compartidas 0 · editadas 0 · por enviar 0 · Envió el 12/10/2026",
      ),
    ).toBeDefined();
    second.unmount();
    renderRow(LOCKED);
    expect(
      screen.getByText("pedidas 0 · compartidas 0 · editadas 0 · por enviar 0 · Bloqueado por ti"),
    ).toBeDefined();
  });

  it("reads a sent member with something still in the cart as still choosing (decision 13)", () => {
    renderRow(view({ submittedAt: SENT, person: { yours: 1, shared: 2, edited: 1, toSend: 3 } }));

    expect(
      screen.getByText("pedidas 1 · compartidas 2 · editadas 1 · por enviar 3 · Eligiendo"),
    ).toBeDefined();
  });

  it("never says carrito", () => {
    renderRow(OPEN);
    expect(document.body.textContent ?? "").not.toMatch(/carrito/i);
  });

  it("is not rendered without a selection", () => {
    renderRow(undefined);
    expect(screen.queryByText(/Eligiendo/)).toBeNull();
  });
});

describe("per-client selection — entries live in the ⋯ menu", () => {
  it("adds NO inline buttons next to the line; the only control is the ⋯ trigger", () => {
    renderRow(OPEN);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      `Acciones para ${CLIENT.name}`,
    ]);
  });

  it("an open client offers Bloquear and Quitar sus fotos elegidas, not Desbloquear", async () => {
    const user = userEvent.setup();
    renderRow(OPEN);
    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: "Bloquear selección" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Desbloquear selección" })).toBeNull();
  });

  // The buttons mirror the SERVER's preconditions on `selection_locked_at`
  // alone — not the derived state.
  it("an admin-locked client offers Desbloquear, not Bloquear", async () => {
    const user = userEvent.setup();
    renderRow(LOCKED);
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Desbloquear selección" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Bloquear selección" })).toBeNull();
  });

  it("a sent but UNLOCKED client offers Bloquear — there is no lock to undo (S5's Q5)", async () => {
    const user = userEvent.setup();
    renderRow(SUBMITTED);
    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: "Bloquear selección" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Desbloquear selección" })).toBeNull();
  });

  it("is distinct from the existing 'Quitar' (remove the client)", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { removable: true });
    await openMenu(user);

    const names = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(names).toContain("Quitar");
    expect(names).toContain("Quitar sus fotos elegidas");
  });

  it("shows the ⋯ trigger when ONLY selection entries exist (counts in hasActions)", () => {
    renderRow(OPEN, "proofing", { removable: false, resendable: false });
    expect(screen.getByRole("button", { name: `Acciones para ${CLIENT.name}` })).toBeDefined();
  });

  it.each(["draft", "delivered", "archived"] as const)(
    "offers no selection entry (and no trigger) on a %s gallery",
    (status) => {
      renderRow(SUBMITTED, status);
      expect(screen.queryByRole("button", { name: /Acciones para/ })).toBeNull();
    },
  );
});

describe("per-client selection — actions", () => {
  // Epic #250/#263: the lock CLAIMS this person's cart (decision 18), so it
  // moves money between people and asks first, exactly like remove-picks.
  it("Bloquear selección opens a confirmation and does not submit yet", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));

    expect(lockMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Se reclaman a su nombre las fotos/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    const [, formData] = lockMock.mock.calls[0]!;
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("clientId")).toBe("u1");
    expect(formData.get("op")).toBe("lock");
    expect(removeMock).not.toHaveBeenCalled();
    expect(unlockMock).not.toHaveBeenCalled();
  });

  // Task #263 fix round (C2): the fixture carries two people plus an
  // `unattributed` bucket, and every line is asserted — the first person only,
  // a dropped "Sin registro" block, or the wrong gallery surcharge each
  // redden this now.
  it("the lock confirmation shows every affected person's BEFORE and AFTER, the legacy bucket, and the gallery total", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));

    // es-CO puts a non-breaking space after "$" — normalize before comparing.
    const textOf = (element: Element) => (element.textContent ?? "").replace(/\u00a0/g, " ");
    const personBlock = (label: string) => {
      const block = screen
        .getAllByTestId("delta-person")
        .find((element) => textOf(element).includes(label));
      expect(block).toBeDefined();
      return block!;
    };

    // BOTH people, each with their own Hoy/Al confirmar pair.
    const ana = textOf(personBlock("Ana Pérez"));
    expect(ana).toContain("Hoy: 1 incluida · 0 extras · 1 original · recargo $ 2.000");
    expect(ana).toContain("Al confirmar: 0 incluidas · 0 extras · 0 originales · recargo $ 0");

    const beto = textOf(personBlock("Beto Gómez"));
    expect(beto).toContain("Hoy: 0 incluidas · 0 extras · 0 originales · recargo $ 0");
    expect(beto).toContain(
      "Al confirmar: 0 incluidas · 2 extras · 0 originales · recargo $ 10.000",
    );

    // The legacy bucket, when it really moves (decision 17's "Sin registro").
    const legacy = textOf(screen.getByTestId("delta-unattributed"));
    expect(legacy).toContain("Sin registro");
    expect(legacy).toContain("Hoy: 0 incluidas · 1 extra · 0 originales · recargo $ 5.000");
    expect(legacy).toContain("Al confirmar: 1 incluida · 0 extras · 0 originales · recargo $ 0");

    // The gallery's own surcharge, before -> after, both values.
    expect(
      screen.getByText(/Recargo de la galería: Hoy \$ 7\.000 · Al confirmar \$ 10\.000/),
    ).toBeDefined();
  });

  it("Cancelar leaves the cart alone", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(lockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("Desbloquear selección calls the unlock action only, with no confirmation", async () => {
    const user = userEvent.setup();
    renderRow(LOCKED);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    expect(unlockMock).toHaveBeenCalledTimes(1);
    expect(lockMock).not.toHaveBeenCalled();
  });

  it("Quitar sus fotos elegidas asks for confirmation first, naming what happens", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" }));

    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Se van a quitar las fotos que eligió esta persona/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    const [, formData] = removeMock.mock.calls[0]!;
    expect(formData.get("clientId")).toBe("u1");
    expect(formData.get("op")).toBe("remove");
    expect(lockMock).not.toHaveBeenCalled();
  });

  it("turns the confirmation step off after a successful removal", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByText("Quitamos las fotos.");
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.queryByText(/Se van a quitar las fotos/)).toBeNull();
  });

  // The preview is computed at RENDER; the delta in the action's answer comes
  // from the rows the write really produced. When they differ, the executed
  // one is the truth and both are shown — the confirmation never blocks.
  it("renders the executed delta the action answered with, under role=status", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    const executed = await screen.findByTestId("executed-delta");
    expect(executed.getAttribute("role")).toBe("status");
    // es-CO puts a non-breaking space after "$", so compare on normalized text.
    const text = (executed.textContent ?? "").replace(/\u00a0/g, " ");
    expect(text).toContain("Ana Pérez: 0 incluidas · 0 extras · 0 originales · recargo $ 0");
    expect(text).toContain("Beto Gómez: 0 incluidas · 2 extras · 0 originales · recargo $ 10.000");
    expect(text).toContain("Sin registro: 1 incluida · 0 extras · 0 originales · recargo $ 0");
    expect(text).toContain("recargo de la galería $ 10.000");
  });

  it("shows no executed delta for the unlock, which moves no money", async () => {
    const user = userEvent.setup();
    renderRow(LOCKED);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    await screen.findByText("Desbloqueamos la selección.");
    expect(screen.queryByTestId("executed-delta")).toBeNull();
  });
});

describe("per-client selection — only the most recent result is shown", () => {
  it("after Bloquear then Desbloquear, only the unlock message remains", async () => {
    const user = userEvent.setup();
    // The row keeps its (static) props between the two clicks, so both entries
    // must be reachable: use a locked view for the second step by re-rendering.
    const { rerender } = renderRow(OPEN, "proofing", { preview: PREVIEW });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByText("Bloqueamos la selección.");

    rerender(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable={false}
        resendable={false}
        selection={LOCKED}
      />,
    );
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    await screen.findByText("Desbloqueamos la selección.");
    expect(screen.queryByText("Bloqueamos la selección.")).toBeNull();
  });

  it("a failed unlock email is an alert, replacing the earlier success", async () => {
    unlockMock.mockResolvedValue({ status: "done_email_failed", message: "No pudimos avisarle." });
    const user = userEvent.setup();
    renderRow(LOCKED);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    expect((await screen.findByRole("alert")).textContent).toBe("No pudimos avisarle.");
  });
});
