import Image from "next/image";
import Link from "next/link";

/**
 * The first viewport is a split mirror: the photograph fills the frame and is
 * the thing being looked at; the identity sits at the edge the way a name is
 * written on a mirror's frame; one action sits below. The photo leads, the
 * chrome recedes.
 */
export function Hero() {
  return (
    <section className="relative min-h-[100svh] overflow-hidden">
      {/* The mirror itself: the photograph is the subject, full-bleed. */}
      <div className="absolute inset-0 z-0">
        <Image
          src="/portfolio/brujas/hero.jpg"
          alt="Dos modelos vestidas de blanco en un bosque al anochecer — serie Brujas"
          fill
          priority
          sizes="100vw"
          className="mirror-focus object-cover [object-position:center_35%]"
        />
        <div className="hero-scrim absolute inset-0" />
      </div>

      {/* Identity at the edge — a tag on the mirror's frame, never a centered
          wordmark. Vertical, small, out of the photograph's way. */}
      <div className="absolute inset-y-0 right-0 z-20 w-11 md:w-12">
        <div className="border-line/50 flex h-full flex-col items-center justify-between border-l py-6">
          <span className="text-fg-mute text-[10px] tracking-[0.22em] uppercase [writing-mode:vertical-rl]">
            Medellín
          </span>
          <Link
            href="/"
            className="text-fg font-serif text-[15px] tracking-[0.01em] [writing-mode:vertical-rl]"
          >
            Alejo <span className="text-accent">Frames</span>
          </Link>
          <span aria-hidden="true" className="bg-accent/70 h-8 w-px" />
        </div>
      </div>

      {/* Content sits inside the mirror composition, low and left, over a calm
          area of the photograph. One action, not a row of buttons. */}
      <div className="relative z-10 flex min-h-[100svh] flex-col justify-end pt-24 pr-16 pb-[clamp(40px,8vh,96px)] pl-[max(1.25rem,env(safe-area-inset-left))] md:pr-20 md:pl-[max(3rem,env(safe-area-inset-left))]">
        <h1 className="text-display max-w-[13ch] font-serif leading-[0.98] font-normal tracking-[-0.015em] text-balance">
          Cosplay con <em className="text-accent-2">alma de cine</em>.
        </h1>
        <p className="text-lead text-fg-dim measure mt-6 max-w-[34ch] leading-relaxed">
          Retrato de personaje —el grueso del trabajo— editorial y eventos. Cada sesión es una
          escena.
        </p>
        <div className="mt-8">
          <Link
            href="/#work"
            className="bg-accent text-ink hover:bg-accent-2 inline-flex min-h-11 items-center rounded-sm px-7 py-3.5 text-[13px] font-semibold tracking-[0.1em] uppercase transition-colors"
          >
            Ver el trabajo
          </Link>
        </div>
      </div>
    </section>
  );
}
