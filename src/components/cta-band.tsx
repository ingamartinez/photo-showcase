/**
 * Closing band. Quieter than a marketing banner: one heading, one line of
 * terms, one primary action. Left-aligned so it reads as part of the page's
 * material rather than a callout pasted over it.
 */
export function CtaBand() {
  return (
    <section id="contacto" className="wrap py-[clamp(72px,12vh,140px)]">
      <h2 className="text-title max-w-[16ch] font-serif leading-[1.02] font-normal tracking-[-0.015em] text-balance">
        Pongamos tu personaje frente a la cámara.
      </h2>
      <p className="text-fg-dim measure mt-[22px] max-w-[48ch]">
        Paquetes desde $15.000 COP. Cuéntame tu idea, la fecha y el personaje: armamos la escena
        juntos.
      </p>
      <div className="mt-9">
        <a
          href="https://instagram.com/alejo_frames"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-accent text-ink hover:bg-accent-2 inline-flex min-h-11 items-center rounded-sm px-7 py-3.5 text-[13px] font-semibold tracking-[0.1em] uppercase transition-colors"
        >
          Escribir por Instagram
        </a>
      </div>
    </section>
  );
}
