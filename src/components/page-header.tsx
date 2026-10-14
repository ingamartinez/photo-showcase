// Header band for pages without a hero. Adds top padding to clear the fixed
// site header, and a display title with an optional lead. No eyebrow: the
// heading carries its own weight.
export function PageHeader({ title, lead }: { title: string; lead?: string }) {
  return (
    <header className="wrap pt-[clamp(120px,20vh,180px)] pb-[clamp(32px,6vh,64px)]">
      <h1 className="text-title max-w-[18ch] font-serif leading-[1.0] font-normal tracking-[-0.015em] text-balance">
        {title}
      </h1>
      {lead && <p className="text-lead text-fg-dim measure mt-6 leading-relaxed">{lead}</p>}
    </header>
  );
}
