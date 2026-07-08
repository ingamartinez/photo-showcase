// Header band for pages without a hero. Adds top padding to clear the fixed
// site header, and a consistent eyebrow + display title + optional lead.
export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
}) {
  return (
    <header className="wrap pt-[clamp(120px,20vh,180px)] pb-[clamp(32px,6vh,64px)]">
      <span className="label text-accent mb-5 block">{eyebrow}</span>
      <h1 className="max-w-[18ch] font-serif text-[clamp(38px,6vw,80px)] leading-[1.0] font-normal tracking-[-0.015em] text-balance">
        {title}
      </h1>
      {lead && (
        <p className="text-fg-dim mt-6 max-w-[52ch] text-[clamp(15px,1.6vw,18px)] leading-relaxed">
          {lead}
        </p>
      )}
    </header>
  );
}
