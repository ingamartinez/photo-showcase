// @vitest-environment jsdom
//
// Task #276 — the list's filter and sort selects. The URL is the state: this
// file proves the ENCODED hrefs (page reset, filter/sort kept) and that the
// control does not snap back while the server's props are still the old ones.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardGalleryListControls } from "./dashboard-gallery-list-controls";
import {
  DEFAULT_GALLERY_LIST_QUERY,
  DEFAULT_SORT_DIRECTION,
  GALLERY_SORT_KEYS,
  GALLERY_STATUSES,
  withStatus,
  type GalleryListQuery,
} from "@/lib/gallery-list-query";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  proofing: "En pruebas",
  selected: "Selección enviada",
  delivered: "Entregada",
  archived: "Archivada",
};

const STATUS_OPTIONS = GALLERY_STATUSES.map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
}));

// Mirrors the page's 13 option values; the labels themselves are the page's
// Spanish copy, which this component never invents.
const SORT_OPTIONS = [
  { value: "", label: "Actividad reciente" },
  ...GALLERY_SORT_KEYS.flatMap((key) => [
    { value: `${key}:asc`, label: `${key} asc` },
    { value: `${key}:desc`, label: `${key} desc` },
  ]),
];

function controls(query: GalleryListQuery) {
  return (
    <DashboardGalleryListControls
      query={query}
      statusOptions={STATUS_OPTIONS}
      sortOptions={SORT_OPTIONS}
    />
  );
}

function renderControls(query: Partial<GalleryListQuery> = {}) {
  return render(controls({ ...DEFAULT_GALLERY_LIST_QUERY, ...query }));
}

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe("DashboardGalleryListControls", () => {
  it("offers Todas plus the five statuses in workflow order", () => {
    renderControls();

    const options = [
      ...screen.getByRole("combobox", { name: "Estado" }).querySelectorAll("option"),
    ].map((option) => option.textContent);

    expect(options).toEqual([
      "Todas",
      "Borrador",
      "En pruebas",
      "Selección enviada",
      "Entregada",
      "Archivada",
    ]);
  });

  it("offers all 13 sort options, default order first", () => {
    renderControls();

    const options = [
      ...screen.getByRole("combobox", { name: "Ordenar por" }).querySelectorAll("option"),
    ].map((option) => option.textContent);

    expect(options).toHaveLength(13);
    expect(options[0]).toBe("Actividad reciente");
  });

  it("resets the page when the filter changes", async () => {
    const user = userEvent.setup();
    renderControls({ page: 4 });

    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "draft");

    expect(push).toHaveBeenCalledWith("/dashboard/galleries?status=draft");
  });

  it("keeps the active sort when the filter changes", async () => {
    const user = userEvent.setup();
    renderControls({ sort: "photos", dir: "desc", page: 2 });

    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "draft");

    expect(push).toHaveBeenCalledWith("/dashboard/galleries?status=draft&sort=photos");
  });

  it("writes the sort and resets the page, omitting a default direction", async () => {
    const user = userEvent.setup();
    renderControls({ status: "draft", page: 3 });

    await user.selectOptions(screen.getByRole("combobox", { name: "Ordenar por" }), "photos:desc");

    expect(push).toHaveBeenCalledWith("/dashboard/galleries?status=draft&sort=photos");
    expect(DEFAULT_SORT_DIRECTION.photos).toBe("desc");
  });

  it("drops sort and dir when Actividad reciente is chosen", async () => {
    const user = userEvent.setup();
    renderControls({ status: "draft", sort: "title", dir: "desc", page: 2 });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Ordenar por" }),
      "Actividad reciente",
    );

    expect(push).toHaveBeenCalledWith("/dashboard/galleries?status=draft");
  });

  // THE NO-SNAP-BACK CONTRACT — and WHY it is not `useOptimistic` (see the
  // component's header comment): React reverts optimistic state when the
  // transition that scheduled it commits, and `router.push` is synchronous.
  // The control therefore keeps the user's choice until the server's prop
  // arrives, and then the prop wins.
  it("shows the chosen filter while the server's props are still stale", async () => {
    const user = userEvent.setup();
    const stale = { ...DEFAULT_GALLERY_LIST_QUERY };
    const { rerender } = render(controls(stale));

    const select = screen.getByRole("combobox", { name: "Estado" }) as HTMLSelectElement;
    expect(select.value).toBe("");

    await user.selectOptions(select, "draft");

    // The `query` prop has NOT changed — this is the window between the click
    // and the RSC payload.
    expect(select.value).toBe("draft");
    expect(push).toHaveBeenCalledWith("/dashboard/galleries?status=draft");

    // A client-only re-render (same prop reference) keeps the override.
    rerender(controls(stale));
    expect(select.value).toBe("draft");

    // A new prop object means the server landed; the URL is the truth again.
    rerender(controls(withStatus(stale, "draft")));
    expect(select.value).toBe("draft");
  });

  it("lets a later server value win over the pending override", async () => {
    const user = userEvent.setup();
    const { rerender } = renderControls();

    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "draft");
    // The server normalizes to a different state (e.g. the URL also changed
    // from somewhere else). The override lives only until the next server
    // render, so a new prop must win.
    rerender(controls({ ...DEFAULT_GALLERY_LIST_QUERY, status: "archived" }));

    expect((screen.getByRole("combobox", { name: "Estado" }) as HTMLSelectElement).value).toBe(
      "archived",
    );
  });
});
