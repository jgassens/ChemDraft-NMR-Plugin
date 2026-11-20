import type { NmrNucleus } from "../../domain/contracts";
import { environmentKey, sphereDepthOf, MAX_SPHERES } from "./environmentCode";
import { summarizeShifts, type CompiledNmrDatabase, type NmrDatabaseEntry, type NmrDatabaseProvenance } from "./localDatabase";
import { parseNmredataMolecule } from "./nmredataMolecule";
import { parseNmredataRecord, splitRecords } from "./nmredata";
import {
  prepareProductionLookup,
  assignedProductionAtoms,
  productionEnvironmentCodes,
  type ProductionLookupContext
} from "./productionLookup";

export interface BuildDatabaseOptions {
  provenance: Omit<
    NmrDatabaseProvenance,
    "structureCount" | "entryCount" | "nuclei" | "generatedAt" | "minObservations" | "rawEntryCount"
  >;
  now?: () => string;
  maxSpheres?: number;
  nuclei?: readonly NmrNucleus[];
  /** Drop environments observed fewer than this many times (bundle-size prune). Default 1 = keep
   * everything. When > 1 the rule and the pre-prune count are recorded in provenance so a rebuild
   * from the same raw input reproduces the artifact exactly. */
  minObservations?: number;
}

/**
 * Compile a NMReDATA/SDF export (e.g. `nmrshiftdb2rawdata.nmredata.sd`) into aggregated HOSE-code →
 * shift statistics. Each atom-assigned resonance is keyed by `productionEnvironmentCodes` — exactly
 * the codes production lookup queries for that atom (class representative, canonical molecule, every
 * sphere depth) — and its shift is bucketed under each; buckets are then summarized to
 * median/mean/stdev/min/max/n. Only the compiled statistics are emitted — never the raw structures —
 * so the artifact is small and a separate, attributed data asset.
 */
export function buildNmrDatabase(rawSdContent: string, options: BuildDatabaseOptions): CompiledNmrDatabase {
  // Normalize line endings so the record split and tag terminators work on CRLF exports too.
  return buildNmrDatabaseFromRecords(splitRecords(rawSdContent.replace(/\r\n?/g, "\n")), options);
}

/** Compile individual SDF records without reassembling the input into another large string. */
export function buildNmrDatabaseFromRecords(
  rawRecords: Iterable<string>,
  options: BuildDatabaseOptions
): CompiledNmrDatabase {
  const maxSpheres = options.maxSpheres ?? MAX_SPHERES;
  const minObservations = options.minObservations ?? 1;
  const buckets = new Map<string, { nucleus: NmrNucleus; sphere: number; shifts: number[] }>();
  const nucleiSeen = new Set<NmrNucleus>();
  let structureCount = 0;

  for (const raw of rawRecords) {
    const record = parseNmredataRecord(raw.replace(/\r\n?/g, "\n"));
    if (!record) continue;
    const parsed = parseNmredataMolecule(record.molfile, { recoverStereoParsing: record.phosphorusLabels.size > 0 });
    if (!parsed) continue;

    let lookupContext: ProductionLookupContext;
    try {
      lookupContext = prepareProductionLookup(parsed.molecule, maxSpheres);
    } catch {
      continue;
    }

    let usedStructure = false;
    for (const { nucleus, atom, shift } of assignedProductionAtoms(record, parsed, lookupContext, options.nuclei)) {
      for (const code of productionEnvironmentCodes(lookupContext, nucleus, atom)) {
        const key = environmentKey(nucleus, code);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.shifts.push(shift);
        } else {
          buckets.set(key, { nucleus, sphere: sphereDepthOf(code), shifts: [shift] });
        }
      }
      nucleiSeen.add(nucleus);
      usedStructure = true;
    }
    if (usedStructure) structureCount += 1;
  }

  const entries: Record<string, NmrDatabaseEntry> = {};
  for (const [key, bucket] of buckets) {
    if (bucket.shifts.length < minObservations) {
      continue;
    }
    entries[key] = { nucleus: bucket.nucleus, sphere: bucket.sphere, ...summarizeShifts(bucket.shifts) };
  }

  return {
    provenance: {
      ...options.provenance,
      structureCount,
      entryCount: Object.keys(entries).length,
      nuclei: [...nucleiSeen].sort(),
      generatedAt: (options.now ?? (() => new Date().toISOString()))(),
      ...(minObservations > 1 ? { minObservations, rawEntryCount: buckets.size } : {})
    },
    entries
  };
}
