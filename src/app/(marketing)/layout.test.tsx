// @vitest-environment jsdom
//
// Kanban #33: a signed-out visitor must see a discreet way into `/login`
// from the public chrome. Kanban #91: a signed-in user must see a link to
// THEIR OWN area — `/galleries` for a client, `/dashboard` for an admin —
// not just "some link because a session exists". The three cases (admin,
// client, signed-out) are asserted separately and by name: the bug #91
// fixed shipped specifically because a previous version of this file only
// had a generic "signed-in user" case built from a client session, so an
// admin regression could pass every existing test here without ever being
// exercised.
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
    expect(screen.queryByText("Panel")).toBeNull();
  });

  it("shows a link to /galleries, labelled Mis galerías, for a signed-in CLIENT", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    const element = await MarketingLayout({ children: <div>contenido</div> });
    render(element);

    const links = screen.getAllByRole("link", { name: "Mis galerías" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/galleries");
    }
    expect(screen.queryByText("Acceso a clientes")).toBeNull();
    expect(screen.queryByText("Panel")).toBeNull();
  });

  // The exact case #91 found broken in production: a signed-in ADMIN must
  // NOT be offered the client area (`/galleries`), which is ownership-scoped
  // by #22 to galleries where they are the client — normally none.
  it("shows a link to /dashboard, labelled Panel, for a signed-in ADMIN", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    const element = await MarketingLayout({ children: <div>contenido</div> });
    render(element);

    const links = screen.getAllByRole("link", { name: "Panel" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/dashboard");
    }
    expect(screen.queryByText("Acceso a clientes")).toBeNull();
    expect(screen.queryByText("Mis galerías")).toBeNull();
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
