import { requireAdmin } from "@/lib/auth-guards";
import { signOutAction } from "@/lib/auth-actions";
import { DashboardNav } from "@/components/dashboard-nav";

// Dashboard chrome: the APP SURFACE shell — no marketing header/footer (see
// `src/app/layout.tsx` for why this is a plain segment, not a route group).
// `requireAdmin()` here is DEFENSE IN DEPTH ONLY — every page (and any route
// handler or server action) under this segment calls it again itself. A
// layout does not re-run on sibling navigation and never runs at all for
// Route Handlers or Server Actions, so relying on this call alone would
// silently stop protecting the moment someone added either underneath this
// tree. See `src/lib/auth-guards.ts`'s header comment for the full reasoning;
// do not "simplify" this into the only check.
//
// `data-surface="app"` on the root element below is what finally switches on
// the token layer task #128 added to globals.css (type scale, density,
// --app-radius*, --app-ground/surface/raised): every rule in that block is
// scoped to this attribute and was inert until this file set it. Nothing
// outside this tree carries it, which is the whole point of the attribute
// over a second `:root` — see globals.css's own block comment.
//
// Shape, mobile first, from design/system/dashboard.html:147-200 and
// :500-534: on a phone a top bar (wordmark + salida) with a fixed bottom tab
// bar in the thumb zone; at >=1024px the top bar becomes the sidebar column
// and the SAME nav element becomes its links. There is no `max-width` query
// anywhere here — every desktop rule is an `lg:` variant that ADDS (epic
// #125's hard rule).
export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireAdmin();

  return (
    <div
      data-surface="app"
      className="text-fg flex flex-1 flex-col bg-[var(--app-ground)] text-[length:var(--app-text-base)] leading-[var(--app-line-height)] lg:grid lg:grid-cols-[var(--app-sidebar-w)_1fr]"
    >
      {/* Phone: the top bar. Desktop: the same element IS the sidebar column
          (dashboard.html:153-157, :505-512). */}
      <header className="border-line flex items-center justify-between gap-3 border-b bg-[var(--app-surface)] px-4 py-3 lg:flex-col lg:items-stretch lg:justify-start lg:gap-6 lg:border-r lg:border-b-0 lg:px-3 lg:py-[18px]">
        <div className="lg:px-2.5 lg:pt-1">
          {/* The wordmark stays serif — the mock keeps `--serif` here at 18px
              (dashboard.html:158-159). What the panel drops is the editorial
              DISPLAY headline and the `.label` mono eyebrow at 0.22em; this
              eyebrow is the app scale's own 11px/0.06em (dashboard.html:160-164).
              Not a link: the "Panel" nav item below is the route to /dashboard,
              and two links to one destination is noise in a work tool. */}
          <div className="font-serif text-[18px] tracking-[-0.01em]">
            Alejo <span className="text-accent">Frames</span>
          </div>
          <span className="text-fg-mute hidden text-[length:var(--app-text-micro)] tracking-[0.06em] uppercase lg:mt-[3px] lg:block">
            Panel
          </span>
        </div>

        <DashboardNav />

        <div className="lg:border-line lg:mt-auto lg:border-t lg:pt-3.5">
          {/* Accessible-only, at every width, exactly as the mock has it
              (dashboard.html:630 — the `.vh` class is never undone; `:532`
              only gives it a font size). This panel has one user (PLAN.md §4)
              who knows their own address: it stays announced for anyone
              verifying WHICH account is signed in, and it spends no pixels. */}
          <span className="sr-only">{session.user.email}</span>
          {/* Stays a real form submission to the `signOutAction` server
              action. Do not turn it into a client-side handler.

              `lg:min-h-6` is a floor, not a look: the mock's own
              `min-height: 0` at this breakpoint (dashboard.html:512, now
              corrected there too) left this control 18px tall on a pointer
              device, under WCAG 2.2 SC 2.5.8's 24x24 CSS px minimum — and
              SC 2.5.8's "inline" exception covers targets sitting inside a
              sentence of text, which a standalone button in a sidebar is
              not. Expressed as min-height, the same property carrying the
              44px phone value above, so the two read as one constraint at
              two floors. Deliberately NOT `lg:py-1.5`: padding would add
              nothing visible either, but it is spacing, and spacing is the
              kind of thing a later tidy-up removes without knowing it was
              load-bearing — and it would push the label down inside the
              account block's own `lg:pt-3.5` rhythm. A native button
              centres its content box, so this grows the target without
              moving a pixel of ink: it still reads as quiet text. */}
          <form action={signOutAction}>
            <button
              type="submit"
              className="text-fg-mute min-h-[var(--app-tap)] px-1 text-[length:var(--app-text-meta)] transition-colors hover:text-[var(--app-danger)] lg:min-h-6 lg:px-0 lg:text-left"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </header>

      {/* No `.wrap`: the public site's 1280px centred column is exactly what a
          dense work surface must not inherit. Bottom padding clears the fixed
          tab bar on a phone (dashboard.html:197-200, :534). */}
      <main className="min-w-0 px-4 pt-[18px] pb-[calc(var(--app-tabbar-h)+28px)] lg:px-8 lg:pt-7 lg:pb-16">
        {children}
      </main>
    </div>
  );
}
