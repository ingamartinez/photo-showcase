// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

afterEach(() => {
  cleanup();
});

// Task #171's acceptance criteria asks for verification "a 390px, donde un
// modal ocupa casi toda la pantalla ... pero el foco importa más" — and this
// is the honest limit of what this slice can actually check.
//
// WHAT THIS FILE DOES NOT DO, STATED PLAINLY: it does not verify a rendered
// layout at a 390px viewport. jsdom has no layout engine — there is no real
// box model, no computed pixel width, nothing a `getBoundingClientRect` could
// return that would mean anything here. This repo's only tool that renders a
// real viewport is Playwright (`e2e/**`), out of scope for this lane (owned
// by a sibling task this wave), and there is still no consumer under
// src/app to point it at even if it were in scope — see dialog.tsx's own
// header comment. A screenshot-based check cannot happen from this slice.
//
// WHAT IT DOES INSTEAD: the two behaviours below (focus lands inside the
// dialog on open; Escape closes it and gives focus back to whatever opened
// it) are Radix's own default, UNMODIFIED behaviour — nothing in dialog.tsx
// overrides `onOpenAutoFocus` or `onCloseAutoFocus`. They are pinned here as
// a REGRESSION guard for future edits to this file, not as proof of a bug
// fixed in this slice: the actual #171 fix (the overlay's opacity and blur)
// is guarded separately below, against code this slice actually wrote.
//
// A Tab-cycling ("focus trap") test was deliberately NOT added. Radix's
// Dialog hardcodes `loop: true` on its FocusScope regardless of the `modal`
// prop (see node_modules/@radix-ui/react-dialog's DialogContentImpl), so a
// test asserting "Tab never leaves the dialog" could not be made to
// distinguish an intact trap from a merely-looping, non-trapping one without
// either fighting Radix's own internals or shipping an assertion that always
// passes for a reason unrelated to what its name claims — precisely the
// "test whose name claims more than its assertion reaches" failure mode this
// repo has hit before (see the CLAUDE.md testing note). Better to have two
// honest tests than three where one is confused about what it guards.
describe("Dialog default focus behaviour (task #171 AC: focus matters more at 390px)", () => {
  it("moves focus inside the content as soon as it opens", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete asset</DialogTitle>
          </DialogHeader>
          <button type="button">Cancel</button>
        </DialogContent>
      </Dialog>,
    );

    await waitFor(() => {
      const content = screen.getByRole("dialog");
      expect(content.contains(document.activeElement)).toBe(true);
    });
  });

  it("closes on Escape and returns focus to the element that opened it", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete asset</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

// Task #171's actual fix, pinned against the rendered output rather than
// read off the source, the same discipline src/app/globals.tokens.test.ts
// uses for the compiled stylesheet. The values themselves (two-fifths
// opacity, an 8px blur) are argued for in dialog.tsx's own comment, right
// next to the className; this test exists so a future edit that changes
// them has to do so knowingly, not by accident.
describe("DialogOverlay pins the attenuation values task #171 chose", () => {
  it("renders the composited-and-argued-for opacity and blur, not the original preset", () => {
    render(
      <Dialog open>
        <DialogOverlay data-testid="overlay" />
      </Dialog>,
    );

    const overlay = screen.getByTestId("overlay");

    expect(overlay.className).toContain("bg-black/40");
    expect(overlay.className).toContain("supports-backdrop-filter:backdrop-blur-sm");
  });
});
