// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClientPreviewBanner } from "./client-preview-banner";

// The banner mounts <ActingClientSelect>, which reads the router; its own
// behaviour has a dedicated suite.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/galleries/abc123",
}));

const MEMBERS = [{ id: "client-a", label: "Ana" }];

afterEach(cleanup);

describe("ClientPreviewBanner (S7 copy)", () => {
  it("C15: acting as an active client says the write goes in their name", () => {
    render(
      <ClientPreviewBanner
        dashboardHref="/dashboard/galleries/g1"
        members={MEMBERS}
        subject={{ id: "client-a", label: "Ana", isActive: true }}
      />,
    );

    expect(screen.getByText(/como lo ve Ana/)).toBeDefined();
    expect(screen.getByText(/se pide a su nombre en el acto/)).toBeDefined();
    // The old single-owner claim must be gone.
    expect(screen.queryByText(/se guarda .* a tu nombre/)).toBeNull();
  });

  it("C16: no subject means the admin may only look, and is asked to pick a client", () => {
    render(
      <ClientPreviewBanner
        dashboardHref="/dashboard/galleries/g1"
        members={MEMBERS}
        subject={null}
      />,
    );

    expect(screen.getByText(/como lo ve el cliente/)).toBeDefined();
    expect(screen.getByText(/Elige un cliente para pedir fotos a su nombre/)).toBeDefined();
  });

  it("C17: a removed subject is named, or 'Esta persona' when the label is gone", () => {
    const { unmount } = render(
      <ClientPreviewBanner
        dashboardHref="/dashboard/galleries/g1"
        members={MEMBERS}
        subject={{ id: "client-x", label: "Carla", isActive: false }}
      />,
    );

    expect(screen.getByText(/Carla/)).toBeDefined();
    expect(screen.getByText(/ya no es parte de esta galería/)).toBeDefined();
    expect(screen.getByText(/solo puedes mirar/)).toBeDefined();
    unmount();

    render(
      <ClientPreviewBanner
        dashboardHref="/dashboard/galleries/g1"
        members={MEMBERS}
        subject={{ id: "client-y", label: null, isActive: false }}
      />,
    );
    expect(screen.getByText(/Esta persona/)).toBeDefined();
  });
});
