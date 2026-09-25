import type { NmrNucleus } from "../../domain/contracts";

/**
 * Held-out benchmark results for the bundled database (ADR-0026, planning report 0025). These are
 * MEASURED values from `scripts/run-benchmark.ts`, transcribed verbatim from its JSON output — never
 * edited by hand to look better. They are only displayed when the active database's provenance
 * `inputSha256` equals {@link MEASURED_ACCURACY.corpusSha256}: an accuracy claim must not outlive
 * the corpus it was measured on, so a database rebuilt from a different corpus silently drops the
 * claim until the benchmark is rerun.
 */

export interface MeasuredErrorStats {
  count: number;
  mae: number;
  medianAe: number;
  p90Ae: number;
}

export interface MeasuredNucleusAccuracy {
  assigned: number;
  matched: number;
  coverage: number;
  structures: number;
  hose: MeasuredErrorStats;
  byTier: Partial<Record<"high" | "medium" | "low", MeasuredErrorStats>>;
}

export interface MeasuredAccuracy {
  /** SHA-256 of the raw NMReDATA corpus the benchmark split and the bundled database share. */
  corpusSha256: string;
  benchmarkDate: string;
  seed: number;
  holdOutPerMille: number;
  nuclei: Partial<Record<NmrNucleus, MeasuredNucleusAccuracy>>;
}

export const MEASURED_ACCURACY: MeasuredAccuracy = {
  corpusSha256: "831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720",
  benchmarkDate: "2026-09-25",
  seed: 1,
  holdOutPerMille: 20,
  nuclei: {
    "1H": {
      assigned: 2513,
      matched: 2491,
      coverage: 0.991,
      structures: 375,
      hose: { count: 2491, mae: 0.358, medianAe: 0.177, p90Ae: 0.93 },
      byTier: {
        high: { count: 823, mae: 0.183, medianAe: 0.078, p90Ae: 0.48 },
        medium: { count: 1159, mae: 0.338, medianAe: 0.17, p90Ae: 0.77 },
        low: { count: 509, mae: 0.685, medianAe: 0.48, p90Ae: 1.51 }
      }
    },
    "13C": {
      assigned: 7149,
      matched: 7103,
      coverage: 0.994,
      structures: 795,
      hose: { count: 7103, mae: 3.581, medianAe: 1.6, p90Ae: 8.8 },
      byTier: {
        high: { count: 2496, mae: 1.499, medianAe: 0.65, p90Ae: 4.36 },
        medium: { count: 3192, mae: 3.183, medianAe: 1.8, p90Ae: 7.5 },
        low: { count: 1415, mae: 8.152, medianAe: 5.55, p90Ae: 18.22 }
      }
    }
  }
};
