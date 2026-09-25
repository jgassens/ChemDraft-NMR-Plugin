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
      assigned: 2515,
      matched: 2493,
      coverage: 0.991,
      structures: 376,
      hose: { count: 2493, mae: 0.356, medianAe: 0.17, p90Ae: 0.927 },
      byTier: {
        high: { count: 830, mae: 0.181, medianAe: 0.072, p90Ae: 0.46 },
        medium: { count: 1153, mae: 0.338, medianAe: 0.17, p90Ae: 0.76 },
        low: { count: 510, mae: 0.685, medianAe: 0.48, p90Ae: 1.49 }
      }
    },
    "13C": {
      assigned: 7155,
      matched: 7109,
      coverage: 0.994,
      structures: 795,
      hose: { count: 7109, mae: 3.567, medianAe: 1.57, p90Ae: 8.8 },
      byTier: {
        high: { count: 2484, mae: 1.477, medianAe: 0.65, p90Ae: 4.2 },
        medium: { count: 3207, mae: 3.159, medianAe: 1.79, p90Ae: 7.45 },
        low: { count: 1418, mae: 8.15, medianAe: 5.56, p90Ae: 18.22 }
      }
    }
  }
};
