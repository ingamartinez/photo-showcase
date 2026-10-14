/**
 * The studio's position, in one breath. A quote and a short standfirst on a
 * raised surface — material, not a banner.
 */
export function EthosStrip() {
  return (
    <section className="border-line bg-bg-2 border-y">
      <div className="wrap grid grid-cols-1 items-center gap-[clamp(40px,6vw,96px)] py-[clamp(72px,12vh,140px)] md:grid-cols-[1.2fr_1fr]">
        <blockquote className="text-head font-serif leading-[1.16] font-normal tracking-[-0.01em] text-balance italic">
          «Nos llamaron brujas por hablar con los bosques.»{" "}
          <span className="text-accent-2">Yo solo escucho la luz.</span>
        </blockquote>
        <div>
          <p className="text-fg-dim measure leading-[1.7]">
            Trabajo con cosplayers, modelos y parejas que quieren algo más que una foto: una escena.
            Retrato de personaje, editorial de fantasía y cobertura de convenciones en Medellín.
          </p>
          <p className="text-fg-dim measure mt-[18px] leading-[1.7]">
            Fotografía tratada como cine: luz dura cuando el personaje lo pide, penumbra cuando la
            historia lo necesita.
          </p>
        </div>
      </div>
    </section>
  );
}
