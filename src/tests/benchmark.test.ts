import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import {
  aggregateBenchmark,
  benchmarkTier,
  evaluateHeldOut,
  splitCorpusByStructure,
  structureBucket,
  type BenchmarkRow
} from "../providers/ocl/benchmark";
import { buildNmrDatabase } from "../providers/ocl/buildDatabase";
import { protonHostAtom } from "../providers/ocl/environmentCode";
import type { CompiledNmrDatabase, NmrDatabaseEntry } from "../providers/ocl/localDatabase";
import { parseNmredataRecords } from "../providers/ocl/nmredata";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import {
  lookupProductionEnvironment,
  prepareProductionLookup
} from "../providers/ocl/productionLookup";

/** Single-record NMReDATA SD from a SMILES + ¹³C atom assignments (1-based molfile indices). */
function makeSd(smiles: string, carbons: { atom: number; shift: number }[]): string {
  const molfile = OCL.Molecule.fromSmiles(smiles).toMolfile();
  const assignment = carbons.map((carbon, index) => `s${index}, ${carbon.shift}, ${carbon.atom}\\`).join("\n");
  const spectrum = carbons.map((carbon, index) => `${carbon.shift}, L=s${index}\\`).join("\n");
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignment}\n\n> <NMREDATA_1D_13C>\n${spectrum}\n\n$$$$\n`;
}

/** One record assigning every carbon and every explicitly represented proton. */
function makeExplicitHydrogenSd(smiles: string): string {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.addImplicitHydrogens();
  const molfile = molecule.toMolfile();
  const parsed = OCL.Molecule.fromMolfile(molfile);
  const carbonAtoms: number[] = [];
  const protonAtoms: number[] = [];
  for (let atom = 0; atom < parsed.getAllAtoms(); atom += 1) {
    if (parsed.getAtomicNo(atom) === 6) carbonAtoms.push(atom + 1);
    if (parsed.getAtomicNo(atom) === 1) protonAtoms.push(atom + 1);
  }
  const assignments = [
    ...carbonAtoms.map((atom, index) => `c${index}, 0, ${atom}\\`),
    ...protonAtoms.map((atom, index) => `h${index}, 0, ${atom}\\`)
  ].join("\n");
  const carbonSpectrum = carbonAtoms.map((_, index) => `0, L=c${index}\\`).join("\n");
  const protonSpectrum = protonAtoms.map((_, index) => `0, L=h${index}\\`).join("\n");
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignments}\n\n> <NMREDATA_1D_13C>\n${carbonSpectrum}\n\n> <NMREDATA_1D_1H>\n${protonSpectrum}\n\n$$$$\n`;
}

function parityDatabase(records: ReturnType<typeof parseNmredataRecords>): CompiledNmrDatabase {
  const entries: Record<string, NmrDatabaseEntry> = {};
  const database: CompiledNmrDatabase = {
    provenance: {
      ...PROVENANCE,
      structureCount: records.length,
      entryCount: 0,
      nuclei: ["1H", "13C"],
      generatedAt: "t"
    },
    entries
  };
  let nextCarbonShift = 20;
  let nextProtonShift = 1;

  for (const record of records) {
    const molecule = OCL.Molecule.fromMolfile(record.molfile);
    molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const context = prepareProductionLookup(molecule);
    for (const [nucleus, classes] of [
      ["13C", context.carbonClasses],
      ["1H", context.protonClasses]
    ] as const) {
      for (const atoms of classes) {
        const { codes } = lookupProductionEnvironment(database, context, nucleus, atoms[0]);
        const key = `${nucleus}@${codes[0]}`;
        if (entries[key]) continue;
        const ppm = nucleus === "13C" ? nextCarbonShift++ : nextProtonShift++ / 10;
        entries[key] = { nucleus, sphere: 4, n: 10, median: ppm, mean: ppm, stdev: 0.1, min: ppm, max: ppm };
      }
    }
  }
  database.provenance.entryCount = Object.keys(entries).length;
  return database;
}

const PROVENANCE = { name: "t", version: "1", source: "t", license: "t", attribution: "t", note: "t" };

const PROPANE = [
  { atom: 1, shift: 15.5 },
  { atom: 2, shift: 16.1 },
  { atom: 3, shift: 15.5 }
];

describe("splitCorpusByStructure", () => {
  it("is deterministic and keeps every record of the same structure on the same side", () => {
    // Same compound twice (leakage risk) + several distinct compounds.
    const sd = [
      makeSd("CCC", PROPANE),
      makeSd("CCC", [{ atom: 1, shift: 15.7 }]),
      makeSd("CCO", [{ atom: 1, shift: 18.2 }]),
      makeSd("CCCC", [{ atom: 1, shift: 13.2 }]),
      makeSd("CCCCC", [{ atom: 1, shift: 14.0 }])
    ].join("");
    const records = parseNmredataRecords(sd);
    expect(records).toHaveLength(5);

    for (let seed = 0; seed < 50; seed += 1) {
      const first = splitCorpusByStructure(records, { holdOutPerMille: 300, seed });
      const second = splitCorpusByStructure(records, { holdOutPerMille: 300, seed });
      expect(first.train.map((record) => record.raw)).toEqual(second.train.map((record) => record.raw));
      expect(first.train.length + first.heldOut.length).toBe(5);
      // The two propane records must land together, whichever side that is.
      const propaneHeldOut = first.heldOut.filter((record) => record.raw === records[0].raw || record.raw === records[1].raw).length;
      expect([0, 2]).toContain(propaneHeldOut);
    }
  });

  it("buckets structures uniformly enough that a per-mille rate selects a similar fraction", () => {
    const buckets = Array.from({ length: 2000 }, (_, index) => structureBucket(`idcode-${index}`, 7));
    const heldOut = buckets.filter((bucket) => bucket < 100).length; // 10% requested
    expect(heldOut).toBeGreaterThan(120);
    expect(heldOut).toBeLessThan(280);
  });
});

describe("evaluateHeldOut", () => {
  it("matches production for every explicit-H carbon and proton assignment", async () => {
    const smilesFixtures = [
      "Cc1ccccc1",
      "c1ccc2ccccc2c1",
      "c1cc2ccccc2cc1",
      "C[C@H](Br)[C@H](Br)C",
      "CC(O)C(C)C"
    ];
    const records = parseNmredataRecords(smilesFixtures.map(makeExplicitHydrogenSd).join(""));
    expect(records).toHaveLength(smilesFixtures.length);
    const database = parityDatabase(records);
    const rows = evaluateHeldOut(database, records);
    const predictor = new OclHosePredictor({ database, now: () => "t" });

    let rowIndex = 0;
    for (const [recordIndex, record] of records.entries()) {
      const molecule = OCL.Molecule.fromMolfile(record.molfile);
      expect(molecule.getAllAtoms()).toBeGreaterThan(molecule.getAtoms());
      for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
        molecule.setAtomMapNo(atom, atom + 1, false);
      }
      molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
      const atomByMolfileIndex = new Map<number, number>();
      for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
        atomByMolfileIndex.set(molecule.getAtomMapNo(atom), atom);
      }

      const result = await predictor.predict({
        structure: { format: "molfile-v2000", value: record.molfile },
        nuclei: ["13C", "1H"],
        options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: false }
      });
      const implicitHydrogenResult = await predictor.predict({
        structure: { format: "smiles", value: smilesFixtures[recordIndex] },
        nuclei: ["13C", "1H"],
        options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: false }
      });
      const resonanceSignature = (prediction: typeof result) =>
        prediction.resonances
          .map((resonance) => [
            resonance.nucleus,
            resonance.deltaPpm,
            resonance.equivalentNuclei,
            resonance.evidence?.method,
            resonance.crossCheck?.incrementPpm
          ])
          .sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
      expect(resonanceSignature(result)).toEqual(resonanceSignature(implicitHydrogenResult));

      for (const assignment of record.assignments) {
        const nucleus = record.carbonLabels.has(assignment.label)
          ? "13C"
          : record.protonLabels.has(assignment.label)
            ? "1H"
            : undefined;
        if (!nucleus) continue;
        const assignedAtom = atomByMolfileIndex.get(assignment.atoms[0]);
        expect(assignedAtom).toBeDefined();
        if (assignedAtom === undefined) continue;
        const hostAtom = nucleus === "1H" ? protonHostAtom(molecule, assignedAtom) : assignedAtom;
        const resonance = result.resonances.find(
          (candidate) =>
            candidate.nucleus === nucleus && candidate.atomRefs.some((ref) => ref.sourceAtomIndex === hostAtom)
        );
        const row = rows[rowIndex++];

        expect(resonance?.evidence?.method).toBe("hose-fragment");
        expect(row.hosePpm).toBe(resonance?.deltaPpm);
        if (nucleus === "1H") {
          expect(row.incrementPpm).toBe(resonance?.crossCheck?.incrementPpm);
        }
      }
    }
    expect(rowIndex).toBe(rows.length);
  });

  it("scores a held-out structure against the production lookup with zero error on a memorized twin", () => {
    // Train on 6 propane records (n = 6 per environment ≥ any prune), hold out a 7th propane. Its
    // environments are all in train, so the deepest sphere matches exactly and |Δ| = 0.
    const train = parseNmredataRecords(Array.from({ length: 6 }, () => makeSd("CCC", PROPANE)).join(""));
    const database = buildNmrDatabase(train.map((record) => record.raw).join("\n$$$$\n"), {
      provenance: PROVENANCE,
      now: () => "t",
      minObservations: 5
    });
    const heldOut = parseNmredataRecords(makeSd("CCC", PROPANE));

    const rows = evaluateHeldOut(database, heldOut);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.nucleus === "13C")).toBe(true);
    expect(rows.every((row) => row.hosePpm !== undefined)).toBe(true);
    expect(rows.every((row) => Math.abs(row.assignedPpm - (row.hosePpm ?? Number.NaN)) < 1e-9)).toBe(true);
    expect(rows.every((row) => row.sphere === 4)).toBe(true);
    // The two equivalent methyls contribute 2 shifts per record (n = 12 → high tier); the CH2
    // contributes 1 per record (n = 6 → medium under the mirrored rule).
    const methyls = rows.filter((row) => row.assignedPpm === 15.5);
    const methylene = rows.filter((row) => row.assignedPpm === 16.1);
    expect(methyls).toHaveLength(2);
    expect(methyls.every((row) => row.n === 12 && row.tier === "high")).toBe(true);
    expect(methylene).toHaveLength(1);
    expect(methylene[0]).toMatchObject({ n: 6, tier: "medium" });

    const summary = aggregateBenchmark(rows);
    expect(summary["13C"]).toMatchObject({ assigned: 3, matched: 3, coverage: 1, structures: 1 });
    expect(summary["13C"]?.hose.mae).toBe(0);
  });

  it("counts unmatched environments as uncovered instead of inventing a value", () => {
    const train = parseNmredataRecords(Array.from({ length: 6 }, () => makeSd("CCC", PROPANE)).join(""));
    const database = buildNmrDatabase(train.map((record) => record.raw).join("\n$$$$\n"), {
      provenance: PROVENANCE,
      now: () => "t"
    });
    // Chlorobenzene shares no environment with propane at any sphere.
    const heldOut = parseNmredataRecords(makeSd("Clc1ccccc1", [{ atom: 2, shift: 128.7 }]));

    const rows = evaluateHeldOut(database, heldOut);
    expect(rows).toHaveLength(1);
    expect(rows[0].hosePpm).toBeUndefined();
    const summary = aggregateBenchmark(rows);
    expect(summary["13C"]).toMatchObject({ assigned: 1, matched: 0, coverage: 0 });
  });

  it("mirrors the production confidence tiers", () => {
    expect(benchmarkTier(1, 100)).toBe("low");
    expect(benchmarkTier(4, 2)).toBe("low");
    expect(benchmarkTier(2, 5)).toBe("medium");
    expect(benchmarkTier(4, 7)).toBe("medium");
    expect(benchmarkTier(3, 8)).toBe("high");
  });
});

describe("aggregateBenchmark", () => {
  it("computes MAE, median, and P90 per nucleus and tier, and the ¹H increment comparison", () => {
    const rows: BenchmarkRow[] = [
      { nucleus: "1H", structureIndex: 0, assignedPpm: 1.0, hosePpm: 1.1, sphere: 4, n: 10, tier: "high", incrementPpm: 1.4 },
      { nucleus: "1H", structureIndex: 0, assignedPpm: 2.0, hosePpm: 2.3, sphere: 1, n: 10, tier: "low", incrementPpm: 2.1 },
      { nucleus: "1H", structureIndex: 1, assignedPpm: 3.0, hosePpm: undefined },
      { nucleus: "13C", structureIndex: 0, assignedPpm: 20, hosePpm: 21, sphere: 4, n: 10, tier: "high" }
    ];
    const summary = aggregateBenchmark(rows);

    expect(summary["1H"]).toMatchObject({ assigned: 3, matched: 2, structures: 2 });
    expect(summary["1H"]?.hose.mae).toBeCloseTo(0.2, 9);
    expect(summary["1H"]?.byTier.high?.mae).toBeCloseTo(0.1, 9);
    expect(summary["1H"]?.byTier.low?.mae).toBeCloseTo(0.3, 9);
    expect(summary["1H"]?.incrementComparison).toMatchObject({ count: 2 });
    expect(summary["1H"]?.incrementComparison?.hose.mae).toBeCloseTo(0.2, 9);
    expect(summary["1H"]?.incrementComparison?.increment.mae).toBeCloseTo(0.25, 9);
    expect(summary["1H"]?.incrementComparison?.lowTier?.increment.mae).toBeCloseTo(0.1, 9);
    expect(summary["13C"]?.hose.mae).toBeCloseTo(1, 9);
    expect(summary["13C"]?.incrementComparison).toBeUndefined();
  });
});
