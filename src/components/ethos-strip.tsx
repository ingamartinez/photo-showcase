export function EthosStrip() {
  return (
    <section className="border-line bg-bg-2 border-y" data-reveal>
      <div className="wrap grid grid-cols-1 items-center gap-[clamp(40px,6vw,96px)] py-[clamp(72px,12vh,140px)] md:grid-cols-[1.2fr_1fr]">
        <blockquote className="font-serif text-[clamp(26px,3.4vw,44px)] leading-[1.16] font-normal tracking-[-0.01em] text-balance italic">
          «Nos llamaron brujas por hablar con los bosques.»{" "}
          <span className="text-accent-2">Yo solo escucho la luz.</span>
        </blockquote>
        <div>
          <span className="label text-fg-dim mb-4 block">El estudio</span>
          <p className="text-fg-dim leading-[1.7]">
            Trabajo con cosplayers, modelos y parejas que quieren algo más que una foto: una escena.
            Retrato de personaje, editorial de fantasía y cobertura de convenciones en Medellín.
          </p>
          <p className="text-fg-dim mt-[18px] leading-[1.7]">
            Fotografía tratada como cine — luz dura cuando el personaje lo pide, penumbra cuando la
            historia lo necesita. Del bosque de Arrayanes al estudio, cada frame recuerda de dónde
            viene su luz.
          </p>
        </div>
      </div>
    </section>
  );
}
