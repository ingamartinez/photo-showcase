import Link from "next/link";

export function SectionHead({
  kicker,
  title,
  linkHref,
  linkLabel,
}: {
  kicker: string;
  title: string;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <div className="mb-12 flex items-end justify-between gap-6">
      <div>
        <span className="label text-fg-dim mb-4 block">{kicker}</span>
        <h2 className="font-serif text-[clamp(30px,4.4vw,56px)] leading-[1.02] font-normal tracking-[-0.01em] text-balance">
          {title}
        </h2>
      </div>
      {linkHref && linkLabel && (
        <Link
          href={linkHref}
          className="text-fg-dim hover:text-accent-2 text-[13px] tracking-[0.1em] whitespace-nowrap uppercase transition-colors"
        >
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}
