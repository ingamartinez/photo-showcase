// Volume-tier pricing for extra photos (task #231). PURE: no I/O, no env, safe
// to import from client components and server actions alike.
//
// The owner's rule (2026-10-14, do not reopen): VOLUME tiers, not marginal
// ones. Every extra photo pays the unit price of the tier reached by the TOTAL
// number of extras. 3 extras = 3 x the 3-4 tier's price, not 2 x tier 1 + 1 x
// tier 2.
//
// The shape is stored frozen per gallery (`galleries.extra_photo_price_tiers_
// snapshot`, jsonb). `null` there means "flat price", today's behavior.

export type ExtraPriceTier = { minExtras: number; priceCop: number };

/** The scale the owner asked for; pre-loaded when the admin enables tiers. */
export const DEFAULT_EXTRA_PRICE_TIERS: readonly ExtraPriceTier[] = [
  { minExtras: 1, priceCop: 15_000 },
  { minExtras: 3, priceCop: 13_000 },
  { minExtras: 5, priceCop: 11_000 },
  { minExtras: 10, priceCop: 10_000 },
];

export type ValidateTiersResult =
  { ok: true; tiers: ExtraPriceTier[] } | { ok: false; message: string };

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Shared by `createGallery` and `updateGalleryTerms`. Rules: integers >= 0, at
 * least one tier, the first starting at 1 extra, `minExtras` strictly
 * increasing, and a MONOTONIC TOTAL: for each tier i > 0,
 * `minExtras_i * price_i >= (minExtras_i - 1) * price_(i-1)` — i.e. adding one
 * photo can never lower what the client owes. With volume pricing the total
 * drops at a boundary whenever the new unit price is low enough (15/13/11/9
 * makes 9 extras cost 99.000 but 10 cost 90.000).
 */
export function validateExtraPriceTiers(input: unknown): ValidateTiersResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: "Agrega al menos una escala de precios." };
  }
  const tiers: ExtraPriceTier[] = [];
  for (const raw of input) {
    const minExtras: unknown = raw?.minExtras;
    const priceCop: unknown = raw?.priceCop;
    if (!isNonNegativeInt(minExtras) || !isNonNegativeInt(priceCop)) {
      return {
        ok: false,
        message: "Cada escala necesita una cantidad y un precio enteros, mayores o iguales a 0.",
      };
    }
    tiers.push({ minExtras, priceCop });
  }
  if (tiers[0]!.minExtras !== 1) {
    return { ok: false, message: "La primera escala tiene que empezar en 1 foto extra." };
  }
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1]!;
    const cur = tiers[i]!;
    if (cur.minExtras <= prev.minExtras) {
      return {
        ok: false,
        message: "Las escalas tienen que ir de menor a mayor cantidad de fotos, sin repetirse.",
      };
    }
    if (cur.minExtras * cur.priceCop < (cur.minExtras - 1) * prev.priceCop) {
      return {
        ok: false,
        message: `Con ${cur.minExtras} fotos extra el total (${cur.minExtras * cur.priceCop}) sería menor que con ${cur.minExtras - 1} (${(cur.minExtras - 1) * prev.priceCop}). Agregar una foto no puede bajar el total; sube el precio de esa escala.`,
      };
    }
  }
  return { ok: true, tiers };
}

/**
 * Unit price of the tier reached by `extras` (greatest `minExtras <= extras`).
 * With zero extras, the first tier's price (what the next photo would cost).
 * Tiers are expected sorted; this still does not rely on it.
 */
export function unitPriceForExtras(extras: number, tiers: readonly ExtraPriceTier[]): number {
  let best = tiers[0]!;
  for (const tier of tiers) {
    if (tier.minExtras <= extras && tier.minExtras >= best.minExtras) best = tier;
  }
  return best.priceCop;
}

/** Display range label for tier `i`: "1–2", "5–9", "10 o más". */
export function tierRangeLabel(tiers: readonly ExtraPriceTier[], index: number): string {
  const tier = tiers[index]!;
  const next = tiers[index + 1];
  if (!next) return `${tier.minExtras} o más`;
  const upper = next.minExtras - 1;
  return upper === tier.minExtras ? `${tier.minExtras}` : `${tier.minExtras}–${upper}`;
}

/** Index of the tier reached by `extras`, or -1 when there are no extras. */
export function activeTierIndex(extras: number, tiers: readonly ExtraPriceTier[]): number {
  let found = -1;
  tiers.forEach((tier, i) => {
    if (tier.minExtras <= extras) found = i;
  });
  return found;
}
