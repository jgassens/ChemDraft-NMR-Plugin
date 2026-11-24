/**
 * The shipped ¹⁹F HOSE lookup (docs/f19-benchmark.md §5): the gate table, built from NMRexp training
 * and validation rows with the plugin's own production environment codes.
 *
 * Statistic: search spheres 4, 3, 2, 1 in that order; the value is the **median** of the deepest
 * sphere with a surviving environment (the table keeps environments with at least 5 observations after
 * outlier filtering). Tier: the production `benchmarkTier` — low at sphere 1 or with fewer than 3
 * observations, high at sphere ≥ 3 with at least 8, medium otherwise.
 *
 * Pure and worker-safe: no I/O, no Node-only module.
 */
import type { NmrModelTier } from "../../../domain/contracts";
import { productionEnvironmentCodes, type ProductionLookupContext } from "../../ocl/productionLookup";

export interface F19HoseEntry {
  median: number;
  n: number;
}

/** `model-19F/hose-table.json` as written by the frozen run (`kind: "f19-hose-table"`). */
export interface F19HoseTable {
  kind: string;
  protocol_commit: string;
  table: string;
  partitions: readonly string[];
  /** The compiled observations the table was built from: file name and SHA-256. */
  input: { file: string; sha256: string };
  nucleus: string;
  statistic: string;
  min_observations: number;
  spheres: readonly number[];
  /** sphere ("1"…"4") → environment code → median and observation count. */
  environments: Readonly<Record<string, Readonly<Record<string, F19HoseEntry>>>>;
}

export interface F19HoseMatch {
  deltaPpm: number;
  sphere: number;
  sampleCount: number;
  environmentCode: string;
  tier: NmrModelTier;
}

/**
 * The production `benchmarkTier` (`src/providers/ocl/benchmark.ts`), restated here because that module
 * is Node-only. `src/tests/f19Prediction.test.ts` checks the two agree.
 */
export function f19HoseTier(sphere: number, sampleCount: number): NmrModelTier {
  if (sphere <= 1 || sampleCount < 3) return "low";
  if (sphere >= 3 && sampleCount >= 8) return "high";
  return "medium";
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * The gate table's match for the class of `atom` (an atom of the molecule `context` was prepared on),
 * deepest sphere first, or undefined when no sphere matches. Codes come from the same production path
 * the table was compiled with (`productionEnvironmentCodes`, ¹⁹F format: neighbor charges written only
 * when nonzero), on the canonical representative of the atom's class.
 */
export function lookupF19Hose(table: F19HoseTable, context: ProductionLookupContext, atom: number): F19HoseMatch | undefined {
  const codes = productionEnvironmentCodes(context, "19F", atom);
  for (let index = 0; index < codes.length; index += 1) {
    // `atomEnvironmentCodes` writes spheres maxSpheres, maxSpheres − 1, …, 1.
    const sphere = context.maxSpheres - index;
    const entry = own(own(table.environments, String(sphere)), codes[index]);
    if (entry) {
      return {
        deltaPpm: entry.median,
        sphere,
        sampleCount: entry.n,
        environmentCode: codes[index],
        tier: f19HoseTier(sphere, entry.n)
      };
    }
  }
  return undefined;
}
