// The live quota counter (task #24): "Estándar · incluidas 13 ·
// seleccionadas 15 · extras 2 × $5.000 = $10.000". Purely presentational —
// every number it renders is handed to it already computed by
// `computeQuota` (src/lib/quota.ts), never derived here. This is what keeps
// the maths in ONE pure, unit-tested place instead of scattered across
// components: this file only ever formats numbers it is given, it never
// subtracts or multiplies anything itself.
//
// Always shows all three parts, even when `extras` is 0 — "going over the
// quota is upsell, never an error" (task #24) means there is nothing to hide
// when a client is still within their included count; the same sentence
// structure at every count is also what makes the number changing (not the
// shape of the sentence) the only thing the client notices as they toggle.
import { formatCop } from "@/lib/galleries";
import type { QuotaResult } from "@/lib/quota";

export function SelectionCounter({
  packageName,
  quota,
}: {
  packageName: string;
  quota: QuotaResult;
}) {
  return (
    <p className="text-fg-mute text-sm" aria-live="polite">
      {packageName} · incluidas {quota.includedPhotosSnapshot} · seleccionadas {quota.selected} ·
      extras {quota.extras} × {formatCop(quota.extraPhotoPriceCopSnapshot)} ={" "}
      {formatCop(quota.surchargeCop)}
    </p>
  );
}
