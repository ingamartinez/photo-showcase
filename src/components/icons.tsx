// Authored SVG icons — one stroke weight, one cap/join style. Unicode glyphs
// are not an icon system; anything that reads as an affordance is drawn here.

type IconProps = { className?: string };

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function ArrowRight({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} width="1em" height="1em" {...STROKE}>
      <path d="M2.5 8h11" />
      <path d="M9.5 4.5 13 8l-3.5 3.5" />
    </svg>
  );
}

export function ArrowLeft({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} width="1em" height="1em" {...STROKE}>
      <path d="M13.5 8h-11" />
      <path d="M6.5 4.5 3 8l3.5 3.5" />
    </svg>
  );
}

export function Check({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} width="1em" height="1em" {...STROKE}>
      <path d="M2.5 8.5 6 12l7.5-8" />
    </svg>
  );
}
