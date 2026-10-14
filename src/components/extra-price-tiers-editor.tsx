"use client";

// Task #231 — the admin's "Precio por escala" control, shared by the create
// form and the edit-terms dialog so the two cannot drift. Controlled: the
// parent owns `enabled` and `rows` (it needs them for its own preview) and this
// component renders them plus the hidden `extraPhotoPriceTiers` field the
// server actions read.
//
// Rows are kept as STRINGS while typing. `serializeTierRows` is the one place
// they become numbers, and an empty or malformed cell becomes `NaN` (JSON
// `null`) on purpose: the server's `validateExtraPriceTiers` rejects it,
// instead of `Number("")` silently turning an untouched cell into a valid 0.
//
// Validation here is a live hint only; the authority is the server action,
// which runs the same pure function (src/lib/extra-price-tiers.ts).
import {
  DEFAULT_EXTRA_PRICE_TIERS,
  validateExtraPriceTiers,
  type ExtraPriceTier,
} from "@/lib/extra-price-tiers";

export type TierRow = { minExtras: string; priceCop: string };

export function tiersToRows(tiers: readonly ExtraPriceTier[]): TierRow[] {
  return tiers.map((tier) => ({
    minExtras: String(tier.minExtras),
    priceCop: String(tier.priceCop),
  }));
}

export const DEFAULT_TIER_ROWS: TierRow[] = tiersToRows(DEFAULT_EXTRA_PRICE_TIERS);

function toNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/** Rows as the number shape the validator and the server expect. */
export function rowsToTiers(rows: readonly TierRow[]): unknown[] {
  return rows.map((row) => ({
    minExtras: toNumber(row.minExtras),
    priceCop: toNumber(row.priceCop),
  }));
}

/** Validated tiers for the live preview, or `null` while the rows are invalid. */
export function parseTierRows(rows: readonly TierRow[]): ExtraPriceTier[] | null {
  const result = validateExtraPriceTiers(rowsToTiers(rows));
  return result.ok ? result.tiers : null;
}

const cellClass =
  "border-line-2 focus-visible:border-accent text-fg w-full rounded-[5px] border bg-transparent px-3 py-2 text-sm transition-colors outline-none";

export function ExtraPriceTiersEditor({
  idPrefix,
  enabled,
  onEnabledChange,
  rows,
  onRowsChange,
}: {
  idPrefix: string;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  rows: TierRow[];
  onRowsChange: (next: TierRow[]) => void;
}) {
  const validation = enabled ? validateExtraPriceTiers(rowsToTiers(rows)) : null;

  function update(index: number, patch: Partial<TierRow>) {
    onRowsChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    const last = rows[rows.length - 1];
    const nextMin = last ? Number(last.minExtras) + 1 : 1;
    onRowsChange([
      ...rows,
      { minExtras: Number.isFinite(nextMin) ? String(nextMin) : "", priceCop: "" },
    ]);
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-fg flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        Precio por escala
      </label>

      {enabled && (
        <div className="flex flex-col gap-2">
          <p className="text-fg-mute text-xs">
            Todas las fotos extra se cobran al precio de la escala que alcance el total de extras.
            Ejemplo: con 3 extras y la escala &quot;desde 3 fotos&quot;, las 3 pagan ese precio.
          </p>
          <input
            type="hidden"
            name="extraPhotoPriceTiers"
            value={JSON.stringify(rowsToTiers(rows))}
          />
          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <li key={i} className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1">
                  <label
                    htmlFor={`${idPrefix}-tier-min-${i}`}
                    className="text-fg-mute text-xs tracking-wide uppercase"
                  >
                    Desde (fotos extra)
                  </label>
                  <input
                    id={`${idPrefix}-tier-min-${i}`}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={row.minExtras}
                    onChange={(event) => update(i, { minExtras: event.target.value })}
                    className={cellClass}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <label
                    htmlFor={`${idPrefix}-tier-price-${i}`}
                    className="text-fg-mute text-xs tracking-wide uppercase"
                  >
                    Precio c/u, COP
                  </label>
                  <input
                    id={`${idPrefix}-tier-price-${i}`}
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={row.priceCop}
                    onChange={(event) => update(i, { priceCop: event.target.value })}
                    className={cellClass}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onRowsChange(rows.filter((_, j) => j !== i))}
                  disabled={rows.length <= 1}
                  aria-label={`Quitar la escala ${i + 1}`}
                  className="border-line-2 hover:bg-bg-2 min-h-9 rounded-[5px] border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={addRow}
            className="text-fg-dim hover:text-accent-2 self-start text-xs underline transition-colors"
          >
            Agregar escala
          </button>
          {validation && !validation.ok && (
            <p id={`${idPrefix}-tiers-hint`} className="text-danger text-sm">
              {validation.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
