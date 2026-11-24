import type { NmrNucleus } from "../../domain/contracts";

/**
 * Held-out benchmark results for the bundled database (ADR-0026, docs/charge-aware-hose.md). These are
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
  rmse?: number;
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
  /** SHA-256 of the raw NMReDATA corpus shared by the benchmark and production database. */
  corpusSha256: string;
  benchmarkDate: string;
  seed: number;
  holdOutPerMille: number;
  nuclei: Partial<Record<NmrNucleus, MeasuredNucleusAccuracy>>;
}

export interface PhosphorusMeasuredAccuracy extends Omit<MeasuredAccuracy, "seed"> {
  partition: string;
  bootstrapSeed: number;
  bootstrapResamples: number;
  bootstrap95: {
    mae: readonly [number, number];
    rmse: readonly [number, number];
  };
}

export const MEASURED_ACCURACY: MeasuredAccuracy = {
  corpusSha256: "831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720",
  benchmarkDate: "2026-11-20",
  seed: 1,
  holdOutPerMille: 20,
  nuclei: {
    "1H": {
      assigned: 2707,
      matched: 2673,
      coverage: 0.987,
      structures: 376,
      hose: { count: 2673, mae: 0.358, medianAe: 0.17, p90Ae: 0.92 },
      byTier: {
        high: { count: 976, mae: 0.207, medianAe: 0.08, p90Ae: 0.489 },
        medium: { count: 1172, mae: 0.332, medianAe: 0.17, p90Ae: 0.78 },
        low: { count: 525, mae: 0.695, medianAe: 0.51, p90Ae: 1.49 }
      }
    },
    "13C": {
      assigned: 7280,
      matched: 7227,
      coverage: 0.993,
      structures: 795,
      hose: { count: 7227, mae: 3.517, medianAe: 1.56, p90Ae: 8.69 },
      byTier: {
        high: { count: 2579, mae: 1.507, medianAe: 0.66, p90Ae: 4.32 },
        medium: { count: 3210, mae: 3.071, medianAe: 1.747, p90Ae: 7.35 },
        low: { count: 1438, mae: 8.117, medianAe: 5.51, p90Ae: 17.88 }
      }
    }
  }
};

/** Measured by the source-reference split in docs/p31-benchmark.md. This checksum gates only ³¹P. */
export const PHOSPHORUS_MEASURED_ACCURACY: PhosphorusMeasuredAccuracy = {
  corpusSha256: "86a0da75ea2953de294c37cc32cb81d440383ab0aaf7c3f982cb0f4d1b659d37",
  benchmarkDate: "2026-11-20",
  partition: "held-out source references, 10%, molecule-deduplicated",
  holdOutPerMille: 100,
  bootstrapSeed: 1,
  bootstrapResamples: 1000,
  nuclei: {
    "31P": {
      assigned: 5577,
      matched: 4812,
      coverage: 0.863,
      structures: 5189,
      hose: { count: 4812, mae: 6.817, medianAe: 2.335, p90Ae: 15.45, rmse: 18.357 },
      byTier: {
        high: { count: 1198, mae: 1.923, medianAe: 0.96, p90Ae: 3.5, rmse: 5.652 },
        medium: { count: 1899, mae: 3.773, medianAe: 1.55, p90Ae: 6.4, rmse: 14.056 },
        low: { count: 1715, mae: 13.608, medianAe: 7.8, p90Ae: 27.11, rmse: 26.542 }
      }
    }
  },
  bootstrap95: { mae: [5.633, 8.076], rmse: [14.054, 22.445] }
};
