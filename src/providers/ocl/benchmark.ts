import { createHash } from "node:crypto";
import * as OCL from "openchemlib";

import type { NmrNucleus, NmrPredictionOptions } from "../../domain/contracts";
import { MAX_SPHERES } from "./environmentCode";
import { estimateProtonIncrement } from "./incrementEstimator";
import type { CompiledNmrDatabase } from "./localDatabase";
import { assignedProductionAtoms, lookupProductionEnvironment, prepareProductionLookup, shiftFor } from "./productionLookup";
import { extractMolfile, type NmredataRecord } from "./nmredata";
import { parseMolfileWithStereoRecovery, parseNmredataMolecule } from "./nmredataMolecule";

/**
 * Leakage-free accuracy benchmark (ADR-0026). The corpus is split by *structure identity* (OCL
 * idcode), so every record of the same compound — duplicates included — lands on the same side and a
 * held-out molecule can never have contributed shifts to the database it is scored against. Held-out
 * assignments are scored through the production lookup itself (`lookupProductionEnvironment`),
 * never a reimplementation.
 */

export interface CorpusSplit {
  train: NmredataRecord[];
  heldOut: NmredataRecord[];
  /** Records whose molfile OCL could not parse; they stay in train (they are unusable for scoring). */
  unparseable: number;
}

export interface SplitOptions {
  /** Per-mille of structure identities to hold out (20 = 2%). */
  holdOutPerMille: number;
  seed: number;
}

const structureIdcodeCache = new WeakMap<NmredataRecord, string | null>();

/** Deterministic, seed-stable FNV-1a — no RNG, so a rerun reproduces the exact split. */
export function structureBucket(idcode: string, seed: number): number {
  let hash = 0x811c9dc5;
  const text = `${idcode}#${seed}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 1000;
}

export function splitCorpusByStructure(records: readonly NmredataRecord[], options: SplitOptions): CorpusSplit {
  const train: NmredataRecord[] = [];
  const heldOut: NmredataRecord[] = [];
  let unparseable = 0;
  for (const record of records) {
    let idcode = structureIdcodeCache.get(record);
    if (idcode === undefined) {
      try {
        const molecule = OCL.Molecule.fromMolfile(record.molfile);
        idcode = molecule.getAllAtoms() > 0 ? molecule.getIDCode() : null;
      } catch {
        idcode = null;
      }
      structureIdcodeCache.set(record, idcode);
    }
    if (idcode === null) {
      unparseable += 1;
      train.push(record);
      continue;
    }
    (structureBucket(idcode, options.seed) < options.holdOutPerMille ? heldOut : train).push(record);
  }
  return { train, heldOut, unparseable };
}

export const PHOSPHORUS_HOLD_OUT_PER_MILLE = 100;
export const PHOSPHORUS_BOOTSTRAP_RESAMPLES = 1000;
export const PHOSPHORUS_BOOTSTRAP_SEED = 1;

interface SourceEntry {
  stem: string;
  ref: string;
  raw: string;
}

export function sourceReferenceKey(stem: string, ref: string): string {
  const normalized = ref.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized && normalized !== "na" ? normalized : `stem:${stem.replace(/-CMP\d+$/, "")}`;
}

export function sourceReferenceBucket(key: string): number {
  return createHash("sha256").update(key, "utf8").digest().readUInt32BE(0) % 1000;
}

/** Split by source, then remove every training entry that shares a stereo-free OCL identity with
 * the held-out partition. Require an identity for every entry to enforce the leakage guard. */
export function splitCorpusBySourceReference<T extends SourceEntry>(entries: readonly T[]) {
  const heldOut: { entry: T; groupKey: string }[] = [];
  const testIdcodes = new Set<string>();
  const candidates: { entry: T; idcode: string }[] = [];

  for (const entry of entries) {
    const molfile = extractMolfile(entry.raw);
    const idcode = molfile && stereoFreeIdcode(molfile);
    if (!idcode) {
      throw new Error(`Missing OpenChemLib structure for SDF entry ${entry.stem}`);
    }
    const groupKey = sourceReferenceKey(entry.stem, entry.ref);
    if (sourceReferenceBucket(groupKey) < PHOSPHORUS_HOLD_OUT_PER_MILLE) {
      heldOut.push({ entry, groupKey });
      testIdcodes.add(idcode);
    } else {
      candidates.push({ entry, idcode });
    }
  }

  const train = candidates.filter(({ idcode }) => !testIdcodes.has(idcode)).map(({ entry }) => entry);
  return { train, heldOut, droppedTrainingDuplicates: candidates.length - train.length };
}

function stereoFreeIdcode(molfile: string): string | undefined {
  const molecule = parseMolfileWithStereoRecovery(molfile);
  return molecule.getAllAtoms() > 0
    ? new OCL.Canonizer(molecule, { neglectAnyStereoInformation: true }).getIDCode()
    : undefined;
}

export type BenchmarkTier = "high" | "medium" | "low";

export interface BenchmarkRow {
  nucleus: NmrNucleus;
  /** Index of the held-out record this row came from (for per-structure accounting). */
  structureIndex: number;
  assignedPpm: number;
  /** Production HOSE lookup result; absent = no database match at any sphere (uncovered). */
  hosePpm?: number;
  sphere?: number;
  n?: number;
  tier?: BenchmarkTier;
  /** Bounded additive-increment estimate for the same host (¹H only, where applicable). */
  incrementPpm?: number;
}

/** Mirrors the production confidence tier (composePredictionReport): low = shallow or thin evidence,
 * high = specific environment with a healthy population. */
export function benchmarkTier(sphere: number, n: number): BenchmarkTier {
  if (sphere <= 1 || n < 3) return "low";
  if (sphere >= 3 && n >= 8) return "high";
  return "medium";
}

export interface EvaluateOptions {
  statistic?: NmrPredictionOptions["statistic"];
  maxSpheres?: number;
  nuclei?: readonly NmrNucleus[];
}

/** Score every usable held-out assignment against the (train-only) database. Assignment semantics —
 * molfile atom mapping, proton→host resolution, and one row per distinct listed production symmetry
 * class — mirror `buildNmrDatabase` ingestion so the benchmark asks exactly the question the
 * database answers. */
export function evaluateHeldOut(
  database: CompiledNmrDatabase,
  heldOut: readonly NmredataRecord[],
  options: EvaluateOptions = {}
): BenchmarkRow[] {
  const statistic = options.statistic ?? "median";
  const maxSpheres = options.maxSpheres ?? MAX_SPHERES;
  const rows: BenchmarkRow[] = [];

  for (let structureIndex = 0; structureIndex < heldOut.length; structureIndex += 1) {
    const record = heldOut[structureIndex];
    const parsed = parseNmredataMolecule(record.molfile, { recoverStereoParsing: record.phosphorusLabels.size > 0 });
    if (!parsed) {
      continue;
    }
    const { molecule } = parsed;
    // Prepared once per record; environment codes remain cached across every assignment and atom.
    const lookupContext = prepareProductionLookup(molecule, maxSpheres);

    for (const { nucleus, atom, shift } of assignedProductionAtoms(record, parsed, lookupContext, options.nuclei)) {
      const row: BenchmarkRow = { nucleus, structureIndex, assignedPpm: shift };
      const lookup = lookupProductionEnvironment(database, lookupContext, nucleus, atom);
      const found = lookup.match;
      if (found) {
        row.hosePpm = shiftFor(found.entry, statistic);
        row.sphere = found.entry.sphere;
        row.n = found.entry.n;
        row.tier = benchmarkTier(found.entry.sphere, found.entry.n);
      }
      if (nucleus === "1H") {
        const increment = estimateProtonIncrement(molecule, lookup.representativeAtom);
        if (increment.applicable) row.incrementPpm = increment.ppm;
      }
      rows.push(row);
    }
  }
  return rows;
}

export interface ErrorStats {
  count: number;
  mae: number;
  medianAe: number;
  p90Ae: number;
  rmse?: number;
}

export interface NucleusBenchmark {
  assigned: number;
  matched: number;
  coverage: number;
  structures: number;
  hose: ErrorStats;
  byTier: Partial<Record<BenchmarkTier, ErrorStats>>;
  /** ¹H only: HOSE vs increment on the subset where both produced a value. */
  incrementComparison?: {
    count: number;
    hose: ErrorStats;
    increment: ErrorStats;
    lowTier?: { count: number; hose: ErrorStats; increment: ErrorStats };
  };
}

export type BenchmarkSummary = Partial<Record<NmrNucleus, NucleusBenchmark>>;

function errorStats(errors: readonly number[], includeRmse = false): ErrorStats {
  const sorted = [...errors].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) {
    return { count: 0, mae: 0, medianAe: 0, p90Ae: 0 };
  }
  const mae = sorted.reduce((sum, value) => sum + value, 0) / count;
  const mid = Math.floor(count / 2);
  const medianAe = count % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p90Ae = sorted[Math.min(count - 1, Math.ceil(count * 0.9) - 1)];
  return {
    count, mae: round3(mae), medianAe: round3(medianAe), p90Ae: round3(p90Ae),
    ...(includeRmse ? { rmse: round3(Math.sqrt(sorted.reduce((sum, value) => sum + value ** 2, 0) / count)) } : {})
  };
}

export function aggregateBenchmark(rows: readonly BenchmarkRow[]): BenchmarkSummary {
  const summary: BenchmarkSummary = {};
  for (const nucleus of ["1H", "13C", "31P"] as const) {
    const assigned = rows.filter((row) => row.nucleus === nucleus);
    if (assigned.length === 0) continue;
    const includeRmse = nucleus === "31P";
    const matched = assigned.filter((row) => row.hosePpm !== undefined);
    const errorsOf = (subset: readonly BenchmarkRow[], value: (row: BenchmarkRow) => number | undefined) =>
      subset.flatMap((row) => {
        const predicted = value(row);
        return predicted === undefined ? [] : [Math.abs(row.assignedPpm - predicted)];
      });

    const byTier: Partial<Record<BenchmarkTier, ErrorStats>> = {};
    for (const tier of ["high", "medium", "low"] as const) {
      const tierRows = matched.filter((row) => row.tier === tier);
      if (tierRows.length > 0) {
        byTier[tier] = errorStats(errorsOf(tierRows, (row) => row.hosePpm), includeRmse);
      }
    }

    const nucleusSummary: NucleusBenchmark = {
      assigned: assigned.length,
      matched: matched.length,
      coverage: round3(matched.length / assigned.length),
      structures: new Set(assigned.map((row) => row.structureIndex)).size,
      hose: errorStats(errorsOf(matched, (row) => row.hosePpm), includeRmse),
      byTier
    };

    if (nucleus === "1H") {
      const both = matched.filter((row) => row.incrementPpm !== undefined);
      if (both.length > 0) {
        const lowTier = both.filter((row) => row.tier === "low");
        nucleusSummary.incrementComparison = {
          count: both.length,
          hose: errorStats(errorsOf(both, (row) => row.hosePpm)),
          increment: errorStats(errorsOf(both, (row) => row.incrementPpm)),
          ...(lowTier.length > 0
            ? {
                lowTier: {
                  count: lowTier.length,
                  hose: errorStats(errorsOf(lowTier, (row) => row.hosePpm)),
                  increment: errorStats(errorsOf(lowTier, (row) => row.incrementPpm))
                }
              }
            : {})
        };
      }
    }
    summary[nucleus] = nucleusSummary;
  }
  return summary;
}

/** Percentile intervals from resampling source groups with replacement. Each draw retains all
 * matched-atom errors in the chosen group, including multiple observations from one molecule. */
export function bootstrapPhosphorusErrors(rows: readonly BenchmarkRow[], groupKeys: readonly string[]) {
  const byGroup = new Map(groupKeys.map((key) => [key, { count: 0, absolute: 0, squared: 0 }]));
  for (const row of rows) {
    if (row.nucleus !== "31P" || row.hosePpm === undefined) continue;
    const group = byGroup.get(groupKeys[row.structureIndex]);
    if (!group) throw new Error(`Missing source group for held-out record ${row.structureIndex}`);
    const error = Math.abs(row.assignedPpm - row.hosePpm);
    group.count += 1;
    group.absolute += error;
    group.squared += error ** 2;
  }

  const groups = [...byGroup.values()];
  if (groups.every(({ count }) => count === 0)) return undefined;
  const mae: number[] = [];
  const rmse: number[] = [];
  let state = PHOSPHORUS_BOOTSTRAP_SEED;
  for (let resample = 0; resample < PHOSPHORUS_BOOTSTRAP_RESAMPLES; resample += 1) {
    let count = 0;
    let absolute = 0;
    let squared = 0;
    for (let draw = 0; draw < groups.length; draw += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const group = groups[Math.floor((state / 2 ** 32) * groups.length)];
      count += group.count;
      absolute += group.absolute;
      squared += group.squared;
    }
    if (count > 0) {
      mae.push(absolute / count);
      rmse.push(Math.sqrt(squared / count));
    }
  }
  const interval = (values: number[]): [number, number] => {
    values.sort((a, b) => a - b);
    return [0.025, 0.975].map((p) => round3(values[Math.ceil(p * values.length) - 1])) as [number, number];
  };
  return { mae: interval(mae), rmse: interval(rmse) };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
