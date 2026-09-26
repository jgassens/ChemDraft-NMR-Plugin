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
      assigned: 2707,
      matched: 2684,
      coverage: 0.992,
      structures: 376,
      hose: { count: 2684, mae: 0.361, medianAe: 0.17, p90Ae: 0.92 },
      byTier: {
        high: { count: 987, mae: 0.21, medianAe: 0.08, p90Ae: 0.49 },
        medium: { count: 1178, mae: 0.341, medianAe: 0.17, p90Ae: 0.802 },
        low: { count: 519, mae: 0.694, medianAe: 0.51, p90Ae: 1.53 }
      }
    },
    "13C": {
      assigned: 7280,
      matched: 7234,
      coverage: 0.994,
      structures: 795,
      hose: { count: 7234, mae: 3.563, medianAe: 1.57, p90Ae: 8.8 },
      byTier: {
        high: { count: 2585, mae: 1.531, medianAe: 0.68, p90Ae: 4.32 },
        medium: { count: 3230, mae: 3.172, medianAe: 1.78, p90Ae: 7.5 },
        low: { count: 1419, mae: 8.152, medianAe: 5.6, p90Ae: 18.22 }
      }
    }
  }
};
