import type { NmrCoupling } from "./contracts";

// gamma(²H)/gamma(¹H): IUPAC Recommendations 2001, R. K. Harris et al.,
// Pure Appl. Chem. 73(11), 1795–1818, Table 1, doi:10.1351/pac200173111795.
// Release value supplied by the owner; verification against the paper is still pending.
export const DEUTERIUM_PROTON_GYROMAGNETIC_RATIO = 0.1535;

export interface FirstOrderLine {
  offsetHz: number;
  /** Relative intensity; the sum over all lines is 1. */
  intensity: number;
}

/** Nested first-order splitting. Each D contributes (1 + x + x²), each H (1 + x). */
export function firstOrderLines(couplings: readonly NmrCoupling[]): FirstOrderLine[] {
  let lines: FirstOrderLine[] = [{ offsetHz: 0, intensity: 1 }];
  for (const coupling of couplings) {
    const states = coupling.partnerNucleus === "2H" ? 3 : 2;
    let weights = [1];
    for (let partner = 0; partner < coupling.partnerCount; partner += 1) {
      const next = Array<number>(weights.length + states - 1).fill(0);
      for (let line = 0; line < weights.length; line += 1) {
        for (let state = 0; state < states; state += 1) next[line + state] += weights[line];
      }
      weights = next;
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const split = new Map<number, number>();
    for (const line of lines) {
      for (let index = 0; index < weights.length; index += 1) {
        // Coalesce coincident lines while avoiding floating-point noise in repeated J additions.
        const offset = Math.round((line.offsetHz + (index - (weights.length - 1) / 2) * coupling.jHz) * 1e9) / 1e9;
        split.set(offset, (split.get(offset) ?? 0) + line.intensity * weights[index] / total);
      }
    }
    lines = [...split].map(([offsetHz, intensity]) => ({ offsetHz, intensity }));
  }
  return lines.sort((a, b) => a.offsetHz - b.offsetHz);
}
