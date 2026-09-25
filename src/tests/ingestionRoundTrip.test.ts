import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { NmrNucleus } from "../domain/contracts";
import { buildNmrDatabase } from "../providers/ocl/buildDatabase";
import { MAX_SPHERES } from "../providers/ocl/environmentCode";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { lookupProductionEnvironment, prepareProductionLookup } from "../providers/ocl/productionLookup";

// Shifts below are synthetic test labels, not literature values: each constitutional class gets a
// distinct number so a lookup that lands on the wrong environment is visible. Equivalent atoms share
// a value because production reports one shift per class.

interface Training {
  name: string;
  smiles: string;
  /** Alternative SMILES with a different atom order for end-to-end prediction. */
  alternativeSmiles: string;
  /** Synthetic ¹³C value per heavy atom index of `smiles` (carbons only). */
  carbon: Record<number, number>;
  /** Synthetic ¹H value per host heavy atom index of `smiles`. */
  proton: Record<number, number>;
}

const TRAINING: Training[] = [
  {
    // Cc1cccc(O)c1 — atoms: 0 CH3, 1 c(CH3), 2 cH, 3 cH, 4 cH, 5 c(OH), 6 O, 7 cH. No symmetry.
    name: "m-cresol",
    smiles: "Cc1cccc(O)c1",
    alternativeSmiles: "Oc1cccc(C)c1",
    carbon: { 0: 21.1, 1: 139.2, 2: 121.3, 3: 129.4, 4: 112.5, 5: 155.6, 7: 116.7 },
    proton: { 0: 2.31, 2: 6.72, 3: 7.13, 4: 6.64, 6: 5.05, 7: 6.66 }
  },
  {
    // c1ccc2ccccc2c1 — beta {0,1,5,6}, alpha {2,4,7,9}, ring fusion {3,8}.
    name: "naphthalene",
    smiles: "c1ccc2ccccc2c1",
    alternativeSmiles: "c1cc2ccccc2cc1",
    carbon: { 0: 125.1, 1: 125.1, 5: 125.1, 6: 125.1, 2: 127.2, 4: 127.2, 7: 127.2, 9: 127.2, 3: 133.3, 8: 133.3 },
    proton: { 0: 7.41, 1: 7.41, 5: 7.41, 6: 7.41, 2: 7.82, 4: 7.82, 7: 7.82, 9: 7.82 }
  }
];

/** Explicit-H molecule for `smiles`; heavy atoms keep their SMILES indices, H follow them. */
function explicitHydrogenMolecule(smiles: string): OCL.Molecule {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.addImplicitHydrogens();
  return OCL.Molecule.fromMolfile(molecule.toMolfile());
}

/**
 * Rewrite a V2000 molfile with atoms in a new order (`order[newIndex] = oldIndex`, 0-based). OCL
 * always writes explicit H last; this lets a test place H before and between heavy atoms, which is
 * where the NMReDATA molfile-index → OCL-index mapping in ingestion can go wrong.
 */
function permuteMolfile(molfile: string, order: readonly number[]): string {
  const lines = molfile.split("\n");
  const counts = lines[3];
  const atomCount = Number(counts.slice(0, 3));
  const bondCount = Number(counts.slice(3, 6));
  expect(order).toHaveLength(atomCount);
  const tail = lines.slice(4 + atomCount + bondCount).filter((line) => line.startsWith("M  "));
  expect(tail).toEqual(["M  END"]);

  const newIndexOf = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const atomLines = order.map((oldIndex) => lines[4 + oldIndex]);
  const bondLines = lines.slice(4 + atomCount, 4 + atomCount + bondCount).map((line) => {
    const first = newIndexOf.get(Number(line.slice(0, 3)) - 1)! + 1;
    const second = newIndexOf.get(Number(line.slice(3, 6)) - 1)! + 1;
    return `${String(first).padStart(3)}${String(second).padStart(3)}${line.slice(6)}`;
  });
  return [...lines.slice(0, 4), ...atomLines, ...bondLines, "M  END", ""].join("\n");
}

/** Hydrogens first (reversed), then heavy atoms reversed — so no molfile index equals the OCL index. */
function hydrogenFirstOrder(molecule: OCL.Molecule): number[] {
  const all = Array.from({ length: molecule.getAllAtoms() }, (_, atom) => atom);
  const hydrogens = all.filter((atom) => molecule.getAtomicNo(atom) === 1).reverse();
  const heavy = all.filter((atom) => molecule.getAtomicNo(atom) !== 1).reverse();
  return [...hydrogens, ...heavy];
}

/** One NMReDATA record assigning every carbon and every hydrogen of `training`. */
function trainingRecord(training: Training): string {
  const molecule = explicitHydrogenMolecule(training.smiles);
  const order = hydrogenFirstOrder(molecule);
  const molfileIndexOf = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex + 1]));
  const carbons: string[] = [];
  const protons: string[] = [];
  const assignments: string[] = [];

  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 6) {
      const shift = training.carbon[atom];
      const label = `c${atom}`;
      carbons.push(`${shift}, L=${label}\\`);
      assignments.push(`${label}, ${shift}, ${molfileIndexOf.get(atom)}\\`);
    } else if (molecule.getAtomicNo(atom) === 1) {
      const shift = training.proton[molecule.getConnAtom(atom, 0)];
      const label = `h${atom}`;
      protons.push(`${shift}, L=${label}\\`);
      assignments.push(`${label}, ${shift}, ${molfileIndexOf.get(atom)}\\`);
    }
  }
  return [
    permuteMolfile(molecule.toMolfile(), order),
    "> <NMREDATA_ASSIGNMENT>",
    ...assignments,
    "",
    "> <NMREDATA_1D_13C>",
    ...carbons,
    "",
    "> <NMREDATA_1D_1H>",
    ...protons,
    "",
    "$$$$",
    ""
  ].join("\n");
}

const DATABASE = buildNmrDatabase(TRAINING.map(trainingRecord).join(""), {
  provenance: { name: "test", version: "1", source: "s", license: "l", attribution: "a", note: "n" },
  now: () => "t"
});

/** Every assigned atom of `molecule` (heavy indices given via `originalOf`) must hit sphere 4. */
function expectDeepestHits(
  training: Training,
  molecule: OCL.Molecule,
  originalOf: (atom: number) => number
): void {
  const context = prepareProductionLookup(molecule);
  for (let atom = 0; atom < molecule.getAtoms(); atom += 1) {
    const original = originalOf(atom);
    const expected: [NmrNucleus, number | undefined][] = [
      ["13C", molecule.getAtomicNo(atom) === 6 ? training.carbon[original] : undefined],
      ["1H", molecule.getAllHydrogens(atom) > 0 ? training.proton[original] : undefined]
    ];
    for (const [nucleus, shift] of expected) {
      if (shift === undefined) continue;
      const lookup = lookupProductionEnvironment(DATABASE, context, nucleus, atom);
      const where = `${training.name} ${nucleus} atom ${original}`;
      expect(lookup.match?.code, where).toBe(lookup.codes[0]);
      expect(lookup.match?.entry.sphere, where).toBe(MAX_SPHERES);
      expect(lookup.match?.entry.median, where).toBe(shift);
    }
  }
}

describe("database ingestion ↔ production lookup round trip", () => {
  it("ingests H-first NMReDATA molfiles with every assignment keyed at the deepest sphere", () => {
    expect(DATABASE.provenance.structureCount).toBe(2);
    // Shallow codes may be shared between classes, but at sphere 4 every class has its own entry:
    // m-cresol 7 carbon + 6 proton-host classes, naphthalene 3 + 2.
    const deepest = Object.values(DATABASE.entries).filter((entry) => entry.sphere === MAX_SPHERES);
    expect(deepest).toHaveLength(7 + 6 + 3 + 2);
    for (const entry of deepest) {
      expect(entry.min).toBe(entry.max); // no deepest environment mixed two classes' shifts
    }
  });

  it.each(TRAINING)("$name: every atom of the training SMILES hits sphere 4 with its ingested shift", (training) => {
    const molecule = OCL.Molecule.fromSmiles(training.smiles);
    expectDeepestHits(training, molecule, (atom) => atom);
  });

  it.each(TRAINING)("$name: every atom of a permuted explicit-H molfile hits sphere 4", (training) => {
    const source = explicitHydrogenMolecule(training.smiles);
    const heavyCount = source.getAtoms();
    // Rotate heavy atoms by 3 and keep hydrogens after them, so heavy indices change but stay first.
    const order = Array.from({ length: source.getAllAtoms() }, (_, index) =>
      index < heavyCount ? (index + 3) % heavyCount : index
    );
    const molecule = OCL.Molecule.fromMolfile(permuteMolfile(source.toMolfile(), order));
    molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
    expectDeepestHits(training, molecule, (atom) => order[atom]);
  });

  it.each(TRAINING)("$name: prediction from a different SMILES returns ingested shifts at sphere 4", async (training) => {
    const predictor = new OclHosePredictor({ database: DATABASE, now: () => "t" });
    for (const [nucleus, shifts] of [
      ["13C", training.carbon],
      ["1H", training.proton]
    ] as const) {
      const result = await predictor.predict({
        structure: { format: "smiles", value: training.alternativeSmiles },
        nuclei: [nucleus],
        options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true }
      });
      const predicted = result.resonances.map((resonance) => {
        expect(resonance.evidence?.method).toBe("hose-fragment");
        expect(resonance.evidence?.matchedSphere).toBe(MAX_SPHERES);
        return resonance.deltaPpm;
      });
      // Labile O–H may be omitted by the predictor; every reported resonance must be an ingested value.
      const ingested = [...new Set(Object.values(shifts))].sort((a, b) => a - b);
      if (nucleus === "13C") expect(predicted.sort((a, b) => a - b)).toEqual(ingested);
      else for (const ppm of predicted) expect(ingested).toContain(ppm);
      expect(predicted.length).toBeGreaterThan(0);
    }
  });
});
