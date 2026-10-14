import Link from "next/link";
import { ArrowRight } from "@/components/icons";

// Section heading with an optional trailing link. No eyebrow above the
// heading: the heading carries its own weight.
export function SectionHead({
  title,
  linkHref,
  linkLabel,
}: {
  title: string;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <div className="mb-12 flex items-end justify-between gap-6">
      <h2 className="text-head max-w-[18ch] font-serif leading-[1.05] font-normal tracking-[-0.01em] text-balance">
        {title}
      </h2>
      {linkHref && linkLabel && (
        <Link
          href={linkHref}
          className="text-fg-dim hover:text-accent-2 inline-flex items-center gap-1.5 text-[13px] tracking-[0.1em] whitespace-nowrap uppercase transition-colors"
        >
          {linkLabel}
          <ArrowRight className="shrink-0" />
        </Link>
      )}
    </div>
  );
}
