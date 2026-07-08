"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/#work", label: "Trabajo" },
  { href: "/#colecciones", label: "Colecciones" },
  { href: "/about", label: "Estudio" },
];

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 flex items-center justify-between border-b px-[var(--gutter)] transition-all duration-300 ${
        scrolled
          ? "border-line bg-bg/80 py-4 backdrop-blur-md backdrop-saturate-150"
          : "border-transparent py-5"
      }`}
    >
      <Link href="/" className="font-serif text-[22px] tracking-tight">
        <span className="font-normal">Alejo</span> <span className="text-accent">Frames</span>
      </Link>
      <nav className="flex items-center gap-8">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="text-fg-dim hover:text-fg hidden text-[13px] tracking-[0.08em] uppercase transition-colors sm:inline"
          >
            {item.label}
          </Link>
        ))}
        <Link
          href="/contact"
          className="border-line-2 text-fg hover:border-accent hover:text-accent-2 rounded-sm border px-[18px] py-[9px] text-[13px] tracking-[0.1em] uppercase transition-colors"
        >
          Reservar
        </Link>
      </nav>
    </header>
  );
}
