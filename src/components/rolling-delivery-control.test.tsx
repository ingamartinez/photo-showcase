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

describe("RollingDeliveryControl (#244)", () => {
  it("off: offers to turn it ON and submits the opposite of the current value", () => {
    const { container } = render(
      <RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={false} />,
    );

    expect(screen.getByRole("button", { name: "Prender entrega progresiva" })).toBeTruthy();
    expect(hiddenValue(container)).toBe("true");
  });

  it("on: offers to turn it OFF and submits false", () => {
    const { container } = render(
      <RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={true} />,
    );

    expect(screen.getByRole("button", { name: "Apagar entrega progresiva" })).toBeTruthy();
    expect(hiddenValue(container)).toBe("false");
  });

  it('never says "carrito"', () => {
    render(<RollingDeliveryControl galleryId={GALLERY_ID} rollingDelivery={true} />);

    expect(document.body.textContent ?? "").not.toMatch(/carrito/i);
  });
});
