// @vitest-environment jsdom
//
// Same contract as `site-header.test.tsx`, for the footer's copy of the
// area link (kanban #91). SiteFooter renders whatever `areaHref`/`areaLabel`
// it is given; the role branch lives upstream in `role-landing.ts` and
// `(marketing)/layout.tsx`, not here.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SiteFooter } from "./site-footer";

afterEach(() => {
  cleanup();
});

describe("SiteFooter area link", () => {
  it("renders /dashboard labelled Panel for a signed-in admin", () => {
    render(<SiteFooter areaHref="/dashboard" areaLabel="Panel" />);

    const link = screen.getByRole("link", { name: "Panel" });
    expect(link.getAttribute("href")).toBe("/dashboard");
  });

  it("renders /galleries labelled Mis galerías for a signed-in client", () => {
    render(<SiteFooter areaHref="/galleries" areaLabel="Mis galerías" />);

    const link = screen.getByRole("link", { name: "Mis galerías" });
    expect(link.getAttribute("href")).toBe("/galleries");
  });

  it("renders /login labelled Acceso a clientes for a signed-out visitor", () => {
    render(<SiteFooter areaHref="/login" areaLabel="Acceso a clientes" />);

    const link = screen.getByRole("link", { name: "Acceso a clientes" });
    expect(link.getAttribute("href")).toBe("/login");
  });
});
