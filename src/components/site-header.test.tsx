// @vitest-environment jsdom
//
// SiteHeader is a dumb consumer of `areaHref`/`areaLabel` — the role branch
// itself lives in `src/lib/role-landing.ts` and `(marketing)/layout.tsx`
// (kanban #91). This file guards the other half of that contract: whatever
// the layout resolves for any of the three states (admin, client, signed
// out) actually reaches the rendered link unchanged, for every prop pair
// the layout can produce.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SiteHeader } from "./site-header";

afterEach(() => {
  cleanup();
});

describe("SiteHeader area link", () => {
  it("renders /dashboard labelled Panel for a signed-in admin", () => {
    render(<SiteHeader areaHref="/dashboard" areaLabel="Panel" />);

    const link = screen.getByRole("link", { name: "Panel" });
    expect(link.getAttribute("href")).toBe("/dashboard");
  });

  it("renders /galleries labelled Mis galerías for a signed-in client", () => {
    render(<SiteHeader areaHref="/galleries" areaLabel="Mis galerías" />);

    const link = screen.getByRole("link", { name: "Mis galerías" });
    expect(link.getAttribute("href")).toBe("/galleries");
  });

  it("renders /login labelled Acceso a clientes for a signed-out visitor", () => {
    render(<SiteHeader areaHref="/login" areaLabel="Acceso a clientes" />);

    const link = screen.getByRole("link", { name: "Acceso a clientes" });
    expect(link.getAttribute("href")).toBe("/login");
  });
});
