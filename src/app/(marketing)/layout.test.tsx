// @vitest-environment jsdom
//
// Kanban #33: a signed-out visitor must see a discreet way into `/login`
// from the public chrome, and a signed-in user must see a link to their own
// area (`/galleries`) instead. This layout is the one place that decision is
// made, so it is the one place worth testing directly rather than trusting
// each marketing page individually.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import MarketingLayout from "./layout";

const authMock = vi.fn();

vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
}));

beforeEach(() => {
  authMock.mockReset();
});

afterEach(() => {
  cleanup();
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("MarketingLayout chrome", () => {
  it("shows the client access link to /login for a signed-out visitor", async () => {
    authMock.mockResolvedValue(null);

    const element = await MarketingLayout({ children: <div>contenido</div> });
    render(element);

    const links = screen.getAllByRole("link", { name: "Acceso a clientes" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/login");
    }
    expect(screen.queryByText("Mis galerías")).toBeNull();
  });

  it("shows a link to /galleries instead of the login link for a signed-in user", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    const element = await MarketingLayout({ children: <div>contenido</div> });
    render(element);

    const links = screen.getAllByRole("link", { name: "Mis galerías" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/galleries");
    }
    expect(screen.queryByText("Acceso a clientes")).toBeNull();
  });

  it("still renders the page content and the rest of the chrome", async () => {
    authMock.mockResolvedValue(null);

    const element = await MarketingLayout({ children: <div>contenido</div> });
    render(element);

    expect(screen.getByText("contenido")).toBeDefined();
    expect(screen.getByText("Reservar")).toBeDefined();
    expect(screen.getByText(/@alejo_frames/)).toBeDefined();
  });
});
