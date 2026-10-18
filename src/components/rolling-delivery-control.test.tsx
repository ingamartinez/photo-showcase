// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/dashboard/galleries/actions", () => ({
  updateRollingDelivery: vi.fn(),
}));

import { RollingDeliveryControl } from "./rolling-delivery-control";

afterEach(cleanup);

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function hiddenValue(container: HTMLElement) {
  return (container.querySelector('input[name="rollingDelivery"]') as HTMLInputElement).value;
}

// Task #263 re-labelled the control. Decision 11 split the flag's two jobs:
// the order semantics are mandatory now, so this flag only decides whether
// finals are visible before delivery — and the old ON copy's clause about
// "Enviar" is the lie this suite pins the absence of.
describe("RollingDeliveryControl (#244, relabelled by #263)", () => {
  it("is called 'Ver finales antes de entregar'", () => {
    render(<RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={false} />);

    expect(screen.getByText("Ver finales antes de entregar")).toBeDefined();
  });

  it("off: offers to turn it ON and submits the opposite of the current value", () => {
    const { container } = render(
      <RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={false} />,
    );

    expect(
      screen.getByRole("button", { name: "Prender ver finales antes de entregar" }),
    ).toBeTruthy();
    expect(hiddenValue(container)).toBe("true");
  });

  it("on: offers to turn it OFF and submits false", () => {
    const { container } = render(
      <RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={true} />,
    );

    expect(
      screen.getByRole("button", { name: "Apagar ver finales antes de entregar" }),
    ).toBeTruthy();
    expect(hiddenValue(container)).toBe("false");
  });

  it('never says "carrito"', () => {
    render(<RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={true} />);

    expect(document.body.textContent ?? "").not.toMatch(/carrito/i);
  });

  // Every submit is an order since decision 10, so claiming "Enviar pide las
  // fotos sin bloquear al cliente" describes the DEFAULT behaviour, not this
  // flag — it would make the switch look like it is what buys the client
  // their order semantics.
  it('never claims this flag is what makes "Enviar" an order', () => {
    render(<RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={true} />);

    expect(document.body.textContent ?? "").not.toMatch(/sin bloquear/i);
    expect(document.body.textContent ?? "").not.toMatch(/“Enviar”/);
  });
});
