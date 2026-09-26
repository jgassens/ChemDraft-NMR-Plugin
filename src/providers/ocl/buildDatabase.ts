import type { NmrNucleus } from "../../domain/contracts";
import { environmentKey, sphereDepthOf, MAX_SPHERES } from "./environmentCode";
import { summarizeShifts, type CompiledNmrDatabase, type NmrDatabaseEntry, type NmrDatabaseProvenance } from "./localDatabase";
import { parseNmredataMolecule } from "./nmredataMolecule";
import { extractMolfile, parseAssignments, parseSpectrumLabels, splitRecords } from "./nmredata";
import {
  prepareProductionLookup,
  productionCodeAtom,
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
  const sdContent = rawSdContent.replace(/\r\n?/g, "\n");
  const maxSpheres = options.maxSpheres ?? MAX_SPHERES;
  const minObservations = options.minObservations ?? 1;
  const buckets = new Map<string, { nucleus: NmrNucleus; sphere: number; shifts: number[] }>();
  const nucleiSeen = new Set<NmrNucleus>();
  let structureCount = 0;

  for (const record of splitRecords(sdContent)) {
    const molfile = extractMolfile(record);
    if (!molfile) {
      continue;
    }
    const assignments = parseAssignments(record);
    if (assignments.length === 0) {
      continue;
    }
    const carbonLabels = parseSpectrumLabels(record, "NMREDATA_1D_13C");
    const protonLabels = parseSpectrumLabels(record, "NMREDATA_1D_1H");

    const parsed = parseNmredataMolecule(molfile);
    if (!parsed) {
      continue;
    }
    const { molecule, oclAtomByMolfileIndex } = parsed;
    // Prepared once per record; it caches codes per class representative across assignments.
    let lookupContext: ProductionLookupContext;
    try {
      lookupContext = prepareProductionLookup(molecule, maxSpheres);
    } catch {
      continue;
    }
    const carbonClassByAtom = indexProductionClasses(lookupContext.carbonClasses);
    const protonClassByAtom = indexProductionClasses(lookupContext.protonClasses);

    let usedStructure = false;
    for (const assignment of assignments) {
      const nucleus: NmrNucleus | undefined = carbonLabels.has(assignment.label)
        ? "13C"
        : protonLabels.has(assignment.label)
          ? "1H"
          : undefined;
      if (!nucleus) {
        continue;
      }

      const classByAtom = nucleus === "13C" ? carbonClassByAtom : protonClassByAtom;
      const seenClasses = new Set<number>();
      // Weight one observation per assignment per distinct production symmetry class. Thus a list
      // of equivalent carbons or three H on one methyl retains the historical single observation,
      // while a resonance explicitly assigned to inequivalent environments contributes once to each.
      for (const atomReference of assignment.atoms) {
        const oclAtom = oclAtomByMolfileIndex.get(atomReference);
        if (oclAtom === undefined) continue;
        const codeAtom = productionCodeAtom(molecule, nucleus, oclAtom);
        if (codeAtom < 0) continue;
        const classIndex = classByAtom.get(codeAtom);
        if (classIndex === undefined || seenClasses.has(classIndex)) continue;
        seenClasses.add(classIndex);

        for (const code of productionEnvironmentCodes(lookupContext, codeAtom)) {
          const key = environmentKey(nucleus, code);
          const bucket = buckets.get(key);
          if (bucket) {
            bucket.shifts.push(assignment.shift);
          } else {
            buckets.set(key, { nucleus, sphere: sphereDepthOf(code), shifts: [assignment.shift] });
          }
        }
        nucleiSeen.add(nucleus);
        usedStructure = true;
      }
    }
    if (usedStructure) {
      structureCount += 1;
    }
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

function indexProductionClasses(classes: readonly (readonly number[])[]): ReadonlyMap<number, number> {
  const classByAtom = new Map<number, number>();
  for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
    for (const atom of classes[classIndex]) classByAtom.set(atom, classIndex);
  }
  return classByAtom;
}
