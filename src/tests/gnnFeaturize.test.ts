// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { ChemicalStructureInput, NmrPredictionResult, NmrPredictor } from "../domain/contracts";
import {
  buildCanonicalFeatureDump,
  canonicalDumpHeader,
  canonicalFeatureLine,
  formatFeatureNumber,
  molfileStructureInput,
  sha256Hex
} from "../providers/gnn/canonicalDump";
import {
  featurizeMolecule,
  featurizeStructure,
  GNN_ATOM_FEATURE_COUNT,
  GNN_ATOM_FEATURE_NAMES,
  GNN_BOND_FEATURE_COUNT,
  GNN_BOND_FEATURE_NAMES,
  GNN_NEIGHBOR_CHARGE_SPHERES,
  GnnFeaturizationErrorCodes,
  type GnnMoleculeFeatures
} from "../providers/gnn/featurize";
import { MAX_SPHERES } from "../providers/ocl/environmentCode";
import { attachedDeuteriumAtoms, protonCount } from "../providers/ocl/hydrogenIsotopes";
import { parseNmredataMolecule } from "../providers/ocl/nmredataMolecule";
import { prepareProductionLookup } from "../providers/ocl/productionLookup";
import { createNmrWorkerHandler } from "../worker/nmrWorkerCore";
import type { NmrWorkerResponse } from "../worker/protocol";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------------------------------------
// Hand-written V2000 molfiles
// ---------------------------------------------------------------------------------------------

interface AtomSpec {
  el: string;
  x: number;
  y: number;
  charge?: number;
  mass?: number;
  /** V2000 M  RAD value: 1 singlet, 2 doublet, 3 triplet. */
  radical?: number;
}
/** [first atom (1-based), second atom, order, V2000 stereo (1 wedge, 6 hash, 3 either double)] */
type BondSpec = [number, number, number, number?];

const col = (value: number, width: number) => String(value).padStart(width);
const coordinate = (value: number) => value.toFixed(4).padStart(10);

function molfile(atoms: readonly AtomSpec[], bonds: readonly BondSpec[], title = "synthetic"): string {
  const lines = [title, "  gnn-test", "", `${col(atoms.length, 3)}${col(bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`];
  for (const atom of atoms) {
    lines.push(`${coordinate(atom.x)}${coordinate(atom.y)}${coordinate(0)} ${atom.el.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }
  for (const [first, second, order, stereo = 0] of bonds) {
    lines.push(`${col(first, 3)}${col(second, 3)}${col(order, 3)}${col(stereo, 3)}`);
  }
  const property = (tag: string, key: "charge" | "mass" | "radical") => {
    const entries = atoms.flatMap((atom, index) => (atom[key] === undefined ? [] : [[index + 1, atom[key] as number]]));
    if (entries.length > 0) {
      lines.push(`M  ${tag}${col(entries.length, 3)}${entries.map(([atom, value]) => `${col(atom, 4)}${col(value, 4)}`).join("")}`);
    }
  };
  property("CHG", "charge");
  property("ISO", "mass");
  property("RAD", "radical");
  lines.push("M  END");
  return `${lines.join("\n")}\n`;
}

/** Ethanol with every hydrogen listed after the heavy atoms (C1, C2, O3). */
const ETHANOL_H_LAST = molfile(
  [
    { el: "C", x: 0, y: 0 },
    { el: "C", x: 1.299, y: 0.75 },
    { el: "O", x: 2.598, y: 0 },
    { el: "H", x: -0.5, y: 0.9 },
    { el: "H", x: -0.9, y: -0.4 },
    { el: "H", x: 0.2, y: -1 },
    { el: "H", x: 1, y: 1.7 },
    { el: "H", x: 1.6, y: 1.7 },
    { el: "H", x: 3.4, y: 0.5 }
  ],
  [[1, 2, 1], [2, 3, 1], [1, 4, 1], [1, 5, 1], [1, 6, 1], [2, 7, 1], [2, 8, 1], [3, 9, 1]],
  "ethanol, H last"
);

/** The same ethanol with each hydrogen written right after its host (molfile atoms 1, 5, 8 heavy). */
const ETHANOL_INTERLEAVED = molfile(
  [
    { el: "C", x: 0, y: 0 },
    { el: "H", x: -0.5, y: 0.9 },
    { el: "H", x: -0.9, y: -0.4 },
    { el: "H", x: 0.2, y: -1 },
    { el: "C", x: 1.299, y: 0.75 },
    { el: "H", x: 1, y: 1.7 },
    { el: "H", x: 1.6, y: 1.7 },
    { el: "O", x: 2.598, y: 0 },
    { el: "H", x: 3.4, y: 0.5 }
  ],
  [[1, 5, 1], [5, 8, 1], [1, 2, 1], [1, 3, 1], [1, 4, 1], [5, 6, 1], [5, 7, 1], [8, 9, 1]],
  "ethanol, H interleaved"
);

/**
 * Alanine drawn with the methyl bond as a wedge (stereo 1), a hash (stereo 6) or plain (0). N upper
 * left, COOH upper right, CH3 down: a wedge makes N → COOH → CH3 clockwise with H behind, so (R).
 */
function alanineMolfile(stereo: 0 | 1 | 6): string {
  return molfile(
    [
      { el: "C", x: 0, y: 0 },
      { el: "N", x: -1.299, y: 0.75 },
      { el: "C", x: 0, y: -1.5 },
      { el: "C", x: 1.299, y: 0.75 },
      { el: "O", x: 1.299, y: 2.25 },
      { el: "O", x: 2.598, y: 0 }
    ],
    [[1, 2, 1], [1, 3, 1, stereo], [1, 4, 1], [4, 5, 2], [4, 6, 1]],
    `alanine, methyl ${stereo === 1 ? "wedge" : stereo === 6 ? "hash" : "plain"}`
  );
}

/**
 * 2-Fluorobut-2-ene with a horizontal C2=C3 bond: C1 above C2, F below it, C4 on C3 above (F and C4
 * trans, so E) or below (Z). Double-bond stereo 3 draws the crossed, unknown bond.
 */
function fluorobuteneMolfile(isomer: "E" | "Z" | "crossed"): string {
  return molfile(
    [
      { el: "C", x: -0.75, y: 1.299 },
      { el: "C", x: 0, y: 0 },
      { el: "F", x: -0.75, y: -1.299 },
      { el: "C", x: 1.5, y: 0 },
      { el: "C", x: 2.25, y: isomer === "Z" ? -1.299 : 1.299 }
    ],
    [[1, 2, 1], [2, 3, 1], [2, 4, 2, isomer === "crossed" ? 3 : 0], [4, 5, 1]],
    `2-fluorobut-2-ene, ${isomer}`
  );
}

/** Bromochlorofluoromethane with its explicit H drawn as a wedge or a hash. */
function bromochlorofluoromethaneMolfile(stereo: 1 | 6): string {
  return molfile(
    [
      { el: "C", x: 0, y: 0 },
      { el: "F", x: -1.299, y: 0.75 },
      { el: "Cl", x: 1.299, y: 0.75 },
      { el: "Br", x: 0, y: -1.5 },
      { el: "H", x: 0.5, y: 1.2 }
    ],
    [[1, 2, 1], [1, 3, 1], [1, 4, 1], [1, 5, 1, stereo]],
    `CHFClBr, H ${stereo === 1 ? "wedge" : "hash"}`
  );
}

/** Nitromethane drawn with a pentavalent, uncharged nitrogen (two N=O bonds). */
const NITROMETHANE_PENTAVALENT = molfile(
  [
    { el: "C", x: 0, y: 0 },
    { el: "N", x: 1.5, y: 0 },
    { el: "O", x: 2.25, y: 1.299 },
    { el: "O", x: 2.25, y: -1.299 }
  ],
  [[1, 2, 1], [2, 3, 2], [2, 4, 2]],
  "nitromethane, N(=O)=O"
);

/** Nitromethane drawn charge-separated in a molfile: N+ and O- via M  CHG. */
const NITROMETHANE_CHARGED_MOLFILE = molfile(
  [
    { el: "C", x: 0, y: 0 },
    { el: "N", x: 1.5, y: 0, charge: 1 },
    { el: "O", x: 2.25, y: 1.299 },
    { el: "O", x: 2.25, y: -1.299, charge: -1 }
  ],
  [[1, 2, 1], [2, 3, 2], [2, 4, 1]],
  "nitromethane, [N+](=O)[O-]"
);

const METHANOL_13C = molfile([{ el: "C", x: 0, y: 0, mass: 13 }, { el: "O", x: 1.5, y: 0 }], [[1, 2, 1]], "13C methanol");
const SINGLET_METHYLENE = molfile([{ el: "C", x: 0, y: 0, radical: 1 }], [], "singlet methylene");

// ---------------------------------------------------------------------------------------------
// The synthetic set
// ---------------------------------------------------------------------------------------------

interface Synthetic {
  name: string;
  input: ChemicalStructureInput;
}
const smiles = (name: string, value: string): Synthetic => ({ name, input: { format: "smiles", value } });
const mol = (name: string, value: string): Synthetic => ({ name, input: molfileStructureInput(value) });

const SYNTHETIC: readonly Synthetic[] = [
  // Neutral aliphatics and the element slots
  smiles("methane", "C"),
  smiles("ethane", "CC"),
  smiles("ethanol", "CCO"),
  smiles("dimethyl ether", "COC"),
  smiles("neopentane", "CC(C)(C)C"),
  smiles("acetone", "CC(C)=O"),
  smiles("acetic acid", "CC(=O)O"),
  smiles("acetonitrile", "CC#N"),
  smiles("propyne", "C#CC"),
  smiles("cyclopropane", "C1CC1"),
  smiles("cyclohexane", "C1CCCCC1"),
  smiles("cyclododecane", "C1CCCCCCCCCCC1"),
  smiles("chloroform", "ClC(Cl)Cl"),
  smiles("bromoethane", "CCBr"),
  smiles("iodomethane", "CI"),
  smiles("fluoromethane", "CF"),
  smiles("dimethyl sulfide", "CSC"),
  smiles("tetramethylsilane", "C[Si](C)(C)C"),
  smiles("dimethyl selenide", "C[Se]C"),
  smiles("trimethylborane", "CB(C)C"),
  smiles("trimethylphosphine", "CP(C)C"),
  smiles("tetramethyltin", "C[Sn](C)(C)C"),
  // Aromatics and heteroaromatics
  smiles("benzene", "c1ccccc1"),
  smiles("toluene", "Cc1ccccc1"),
  smiles("naphthalene", "c1ccc2ccccc2c1"),
  smiles("pyridine", "c1ccncc1"),
  smiles("pyrrole", "c1cc[nH]c1"),
  smiles("furan", "c1ccoc1"),
  smiles("thiophene", "c1ccsc1"),
  smiles("imidazole", "c1c[nH]cn1"),
  // Charged species
  smiles("glycine zwitterion", "[NH3+]CC([O-])=O"),
  smiles("nitromethane, charge-separated", "C[N+](=O)[O-]"),
  mol("nitromethane, charge-separated molfile", NITROMETHANE_CHARGED_MOLFILE),
  mol("nitromethane, pentavalent", NITROMETHANE_PENTAVALENT),
  smiles("pyridinium", "c1cc[nH+]cc1"),
  smiles("acetate", "CC(=O)[O-]"),
  smiles("sodium acetate", "CC(=O)[O-].[Na+]"),
  smiles("tetramethylammonium", "C[N+](C)(C)C"),
  // Stereo
  smiles("L-alanine", "N[C@@H](C)C(=O)O"),
  smiles("D-alanine", "N[C@H](C)C(=O)O"),
  smiles("(E)-2-butene", "C/C=C/C"),
  smiles("(Z)-2-butene", "C/C=C\\C"),
  smiles("2-butene, unspecified", "CC=CC"),
  smiles("alanine, unspecified", "NC(C)C(=O)O"),
  smiles("(Z)-2-fluorobut-2-ene", "C/C(F)=C/C"),
  smiles("(E)-2-fluorobut-2-ene", "C/C(F)=C\\C"),
  smiles("meso pentane-2,4-difluoro-3-ol, r", "C[C@H](F)[C@H](O)[C@H](F)C"),
  smiles("meso pentane-2,4-difluoro-3-ol, s", "C[C@H](F)[C@@H](O)[C@H](F)C"),
  smiles("cis-1,4-dimethylcyclohexane", "C[C@H]1CC[C@@H](C)CC1"),
  smiles("trans-1,4-dimethylcyclohexane", "C[C@H]1CC[C@H](C)CC1"),
  smiles("1,4-dimethylcyclohexane, unspecified", "CC1CCC(C)CC1"),
  mol("alanine, wedge", alanineMolfile(1)),
  mol("alanine, hash", alanineMolfile(6)),
  mol("alanine, plain", alanineMolfile(0)),
  mol("2-fluorobut-2-ene, E molfile", fluorobuteneMolfile("E")),
  mol("2-fluorobut-2-ene, Z molfile", fluorobuteneMolfile("Z")),
  mol("2-fluorobut-2-ene, crossed molfile", fluorobuteneMolfile("crossed")),
  mol("CHFClBr, explicit H wedge", bromochlorofluoromethaneMolfile(1)),
  mol("CHFClBr, explicit H hash", bromochlorofluoromethaneMolfile(6)),
  // Isotopes
  smiles("methanol-d4", "[2H]OC([2H])([2H])[2H]"),
  smiles("13C methanol", "[13CH3]O"),
  mol("13C methanol molfile", METHANOL_13C),
  smiles("tritiomethane", "[3H]C"),
  // Radicals
  smiles("methyl radical", "[CH3]"),
  smiles("methoxy radical", "C[O]"),
  smiles("triplet methylene", "[CH2]"),
  mol("singlet methylene", SINGLET_METHYLENE),
  // Explicit hydrogens
  mol("ethanol, H last", ETHANOL_H_LAST),
  mol("ethanol, H interleaved", ETHANOL_INTERLEAVED),
  smiles("ethanol, explicit [H]", "[H]OC([H])([H])C([H])([H])[H]"),
  smiles("dihydrogen", "[H][H]")
];

function features(name: string): GnnMoleculeFeatures {
  const entry = SYNTHETIC.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no synthetic molecule named ${name}`);
  return featurizeStructure(entry.input);
}

function parse(input: ChemicalStructureInput): OCL.Molecule {
  const molecule = input.format === "smiles" ? OCL.Molecule.fromSmiles(input.value) : OCL.Molecule.fromMolfile(input.value);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return molecule;
}

const atomFeature = (name: string) => {
  const index = GNN_ATOM_FEATURE_NAMES.indexOf(name);
  if (index < 0) throw new Error(`unknown atom feature ${name}`);
  return index;
};
const bondFeature = (name: string) => {
  const index = GNN_BOND_FEATURE_NAMES.indexOf(name);
  if (index < 0) throw new Error(`unknown bond feature ${name}`);
  return index;
};

/** Every nonzero entry of a row, by feature name: an exact, readable expectation. */
function nonZero(row: readonly number[], names: readonly string[]): Record<string, number> {
  return Object.fromEntries(row.flatMap((value, index) => (value === 0 ? [] : [[names[index], value]])));
}
const atomNonZero = (row: readonly number[]) => nonZero(row, GNN_ATOM_FEATURE_NAMES);
const bondNonZero = (row: readonly number[]) => nonZero(row, GNN_BOND_FEATURE_NAMES);

const NEUTRAL_UNSPECIFIED = { "radical=none": 1, "atomCIP=none": 1 };
const PLAIN_BOND = { "bondCIP=none": 1 };

function groupSum(row: readonly number[], first: number, length: number): number {
  return row.slice(first, first + length).reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------------------------

describe("GNN feature schema", () => {
  it("has 41 atom and 11 bond features in the documented order", () => {
    expect(GNN_ATOM_FEATURE_COUNT).toBe(41);
    expect(GNN_BOND_FEATURE_COUNT).toBe(11);
    expect(GNN_ATOM_FEATURE_NAMES.slice(0, 14)).toEqual([
      "element=H", "element=B", "element=C", "element=N", "element=O", "element=F", "element=Si",
      "element=P", "element=S", "element=Cl", "element=Se", "element=Br", "element=I", "element=other"
    ]);
    expect(GNN_ATOM_FEATURE_NAMES.slice(14)).toEqual([
      "formalCharge",
      "radical=none", "radical=singlet", "radical=doublet", "radical=triplet",
      "isotopeLabeled", "isotopeMassDelta",
      "totalHydrogens/4", "attachedDeuterium/4", "attachedTritium/4",
      "heavyDegree/4", "piElectrons/2", "aromatic", "inRing", "smallestRingSize/8",
      "atomCIP=none", "atomCIP=R", "atomCIP=S", "atomCIP=unknown",
      "sphere1PositiveCharge", "sphere1NegativeCharge", "sphere2PositiveCharge", "sphere2NegativeCharge",
      "sphere3PositiveCharge", "sphere3NegativeCharge", "sphere4PositiveCharge", "sphere4NegativeCharge"
    ]);
    expect(GNN_BOND_FEATURE_NAMES).toEqual([
      "order=single", "order=double", "order=triple", "order=aromaticOrDelocalized", "order=other",
      "inRing", "delocalized",
      "bondCIP=none", "bondCIP=E", "bondCIP=Z", "bondCIP=unknown"
    ]);
  });

  it("summarizes neighbor charges over the same sphere depth as the HOSE codes", () => {
    expect(GNN_NEIGHBOR_CHARGE_SPHERES).toBe(MAX_SPHERES);
  });

  it("keeps the featurizer and the GNN prediction path free of Node-only, clock, random and locale dependencies", () => {
    const directory = join(REPO_ROOT, "src/providers/gnn");
    const sources = readdirSync(directory).filter((file) => file.endsWith(".ts"));
    // Every module here runs in the plugin worker; the same purity rule covers all of them.
    expect(sources.sort()).toEqual([
      "GnnShiftPredictor.ts",
      "canonicalDump.ts",
      "domainRules.ts",
      "featurize.ts",
      "modelRelease.ts",
      "runtime.ts",
      "tensors.ts",
      "trainingDomain.ts"
    ]);
    for (const file of sources) {
      const source = readFileSync(join(directory, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:|require\(|\bprocess\.|\bBuffer\b/);
      expect(source, file).not.toMatch(/Math\.random|\bDate\b|performance\.|toLocale|Intl\./);
    }
  });
});

describe("featurizeMolecule on the synthetic set", () => {
  it.each(SYNTHETIC.map((entry) => [entry.name, entry] as const))("%s: well-formed, index-faithful and float32-exact", (_, entry) => {
    const molecule = parse(entry.input);
    const result = featurizeMolecule(molecule);
    expect(result.schemaVersion).toBe("1");
    expect(result.atoms).toHaveLength(result.heavyAtomIndexMap.length);

    // Nodes are exactly the non-hydrogen atoms plus hydrogens with no non-hydrogen neighbor.
    const expectedNodes: number[] = [];
    for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
      if (molecule.getAtomicNo(atom) !== 1) {
        expectedNodes.push(atom);
        continue;
      }
      let heavyNeighbor = false;
      for (let bond = 0; bond < molecule.getAllBonds(); bond += 1) {
        const first = molecule.getBondAtom(0, bond);
        const second = molecule.getBondAtom(1, bond);
        if ((first === atom && molecule.getAtomicNo(second) !== 1) || (second === atom && molecule.getAtomicNo(first) !== 1)) {
          heavyNeighbor = true;
        }
      }
      if (!heavyNeighbor) expectedNodes.push(atom);
    }
    expect(result.heavyAtomIndexMap).toEqual(expectedNodes);

    const elementOrder = [1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 34, 35, 53];
    result.atoms.forEach((row, node) => {
      expect(row).toHaveLength(GNN_ATOM_FEATURE_COUNT);
      expect(Array.from(Float32Array.from(row))).toEqual(row);
      expect(groupSum(row, 0, 14)).toBe(1);
      expect(groupSum(row, atomFeature("radical=none"), 4)).toBe(1);
      expect(groupSum(row, atomFeature("atomCIP=none"), 4)).toBe(1);
      const atomicNo = molecule.getAtomicNo(result.heavyAtomIndexMap[node]);
      const slot = elementOrder.indexOf(atomicNo);
      expect(row.indexOf(1)).toBe(slot >= 0 ? slot : 13);
      expect(row[atomFeature("formalCharge")]).toBe(molecule.getAtomCharge(result.heavyAtomIndexMap[node]));
    });

    const nodeSet = new Set(result.heavyAtomIndexMap);
    let nodeBonds = 0;
    for (let bond = 0; bond < molecule.getAllBonds(); bond += 1) {
      if (nodeSet.has(molecule.getBondAtom(0, bond)) && nodeSet.has(molecule.getBondAtom(1, bond))) nodeBonds += 1;
    }
    expect(result.bonds).toHaveLength(nodeBonds);
    for (const bond of result.bonds) {
      expect(bond.from).not.toBe(bond.to);
      expect(Math.max(bond.from, bond.to)).toBeLessThan(result.atoms.length);
      expect(molecule.getBond(result.heavyAtomIndexMap[bond.from], result.heavyAtomIndexMap[bond.to])).toBeGreaterThanOrEqual(0);
      expect(bond.features).toHaveLength(GNN_BOND_FEATURE_COUNT);
      expect(Array.from(Float32Array.from(bond.features))).toEqual(bond.features);
      expect(groupSum(bond.features, bondFeature("order=single"), 5)).toBe(1);
      expect(groupSum(bond.features, bondFeature("bondCIP=none"), 4)).toBe(1);
    }
  });

  it.each(SYNTHETIC.map((entry) => [entry.name, entry] as const))("%s: deterministic to the byte", (_, entry) => {
    const identity = { index: 0, molfileSha256: null };
    const first = canonicalFeatureLine(identity, featurizeStructure(entry.input));
    // Interleave another molecule so any hidden state between calls would show.
    featurizeStructure({ format: "smiles", value: "c1ccncc1[N+](=O)[O-]" });
    const second = canonicalFeatureLine(identity, featurizeStructure(entry.input));
    expect(second).toBe(first);
    expect(featurizeMolecule(parse(entry.input))).toEqual(featurizeStructure(entry.input));
  });

  it("agrees with the HOSE path's atom indices, carbon classes and proton counts", () => {
    for (const entry of SYNTHETIC) {
      const molecule = parse(entry.input);
      const result = featurizeMolecule(molecule);
      const context = prepareProductionLookup(molecule);
      const nodeOf = (atom: number) => result.heavyAtomIndexMap.indexOf(atom);
      for (const atom of context.carbonClasses.flat()) {
        expect(result.atoms[nodeOf(atom)][atomFeature("element=C")], entry.name).toBe(1);
      }
      for (const atom of context.protonClasses.flat()) {
        const row = result.atoms[nodeOf(atom)];
        const protium = 4 * (row[atomFeature("totalHydrogens/4")] - row[atomFeature("attachedDeuterium/4")] - row[atomFeature("attachedTritium/4")]);
        expect(protium, entry.name).toBe(protonCount(molecule, atom) - tritiumCount(molecule, atom));
        expect(4 * row[atomFeature("attachedDeuterium/4")]).toBe(attachedDeuteriumAtoms(molecule, atom).length);
      }
    }
  });

  it("never mutates the caller's molecule", () => {
    const parsed = parseNmredataMolecule(ETHANOL_INTERLEAVED);
    if (!parsed) throw new Error("parse failed");
    const { molecule } = parsed;
    const before = {
      idcode: molecule.getIDCode(),
      atoms: molecule.getAllAtoms(),
      maps: Array.from({ length: molecule.getAllAtoms() }, (_, atom) => molecule.getAtomMapNo(atom))
    };
    featurizeMolecule(molecule);
    expect({
      idcode: molecule.getIDCode(),
      atoms: molecule.getAllAtoms(),
      maps: Array.from({ length: molecule.getAllAtoms() }, (_, atom) => molecule.getAtomMapNo(atom))
    }).toEqual(before);
  });

  it("refuses an unvalidated molecule rather than renumbering a copy of it", () => {
    const molecule = new OCL.Molecule(4, 4);
    molecule.addAtom(1);
    molecule.addAtom(6);
    molecule.addBond(0, 1);
    let code: unknown;
    try {
      featurizeMolecule(molecule);
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe(GnnFeaturizationErrorCodes.UnvalidatedMolecule);
    molecule.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
    expect(atomNonZero(featurizeMolecule(molecule).atoms[0])).toEqual({
      "element=C": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 1
    });
  });
});

function tritiumCount(molecule: OCL.Molecule, host: number): number {
  let count = 0;
  for (let index = 0; index < molecule.getAllConnAtoms(host); index += 1) {
    const neighbor = molecule.getConnAtom(host, index);
    if (molecule.getAtomicNo(neighbor) === 1 && molecule.getAtomMass(neighbor) === 3) count += 1;
  }
  return count;
}

describe("exact features, written out by hand", () => {
  it("ethanol", () => {
    const result = features("ethanol");
    expect(result.heavyAtomIndexMap).toEqual([0, 1, 2]);
    // element(14) | q | radical(4) | iso, Δm | H, D, T | degree | pi | arom | ring | ring size | CIP(4) | sphere charges(8)
    expect(result.atoms).toEqual([
      [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.75, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.25, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ]);
    expect(result.bonds).toEqual([
      { from: 0, to: 1, features: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      { from: 1, to: 2, features: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] }
    ]);
    expect(canonicalFeatureLine({ index: 7, molfileSha256: null }, result)).toBe(
      '{"index":7,"molfileSha256":null,"schemaVersion":"1","heavyAtomIndexMap":[0,1,2],"atoms":[' +
        "[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.75,0,0,0.25,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0]," +
        "[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.5,0,0,0.5,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0]," +
        "[0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.25,0,0,0.25,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0]]," +
        '"bonds":[{"from":0,"to":1,"features":[1,0,0,0,0,0,0,1,0,0,0]},' +
        '{"from":1,"to":2,"features":[1,0,0,0,0,0,0,1,0,0,0]}]}\n'
    );
  });

  it("glycine zwitterion: own charges and charges by sphere", () => {
    const result = features("glycine zwitterion");
    expect(result.atoms.map(atomNonZero)).toEqual([
      { "element=N": 1, formalCharge: 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.75, "heavyDegree/4": 0.25, sphere3NegativeCharge: 1 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.5, "heavyDegree/4": 0.5, sphere1PositiveCharge: 1, sphere2NegativeCharge: 1 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.75, "piElectrons/2": 0.5, sphere1NegativeCharge: 1, sphere2PositiveCharge: 1 },
      { "element=O": 1, formalCharge: -1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, sphere3PositiveCharge: 1 },
      { "element=O": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, "piElectrons/2": 0.5, sphere2NegativeCharge: 1, sphere3PositiveCharge: 1 }
    ]);
  });

  it("nitro both ways: charge-separated forms agree, the pentavalent form keeps its own charges and pi count", () => {
    const separated = features("nitromethane, charge-separated");
    expect(features("nitromethane, charge-separated molfile").atoms).toEqual(separated.atoms);
    expect(separated.atoms.map(atomNonZero)).toEqual([
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.75, "heavyDegree/4": 0.25, sphere1PositiveCharge: 1, sphere2NegativeCharge: 1 },
      { "element=N": 1, formalCharge: 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.75, "piElectrons/2": 0.5, sphere1NegativeCharge: 1 },
      { "element=O": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, "piElectrons/2": 0.5, sphere1PositiveCharge: 1, sphere2NegativeCharge: 1 },
      { "element=O": 1, formalCharge: -1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, sphere1PositiveCharge: 1 }
    ]);
    const pentavalent = features("nitromethane, pentavalent");
    expect(pentavalent.atoms.map(atomNonZero)).toEqual([
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.75, "heavyDegree/4": 0.25 },
      { "element=N": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.75, "piElectrons/2": 1 },
      { "element=O": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, "piElectrons/2": 0.5 },
      { "element=O": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, "piElectrons/2": 0.5 }
    ]);
  });

  it("pyridinium and carboxylate", () => {
    const pyridinium = features("pyridinium");
    const ring = { "aromatic": 1, inRing: 1, "smallestRingSize/8": 0.75, "piElectrons/2": 0.5, "heavyDegree/4": 0.5 };
    expect(pyridinium.atoms.map(atomNonZero)).toEqual([
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, ...ring, "totalHydrogens/4": 0.25, sphere3PositiveCharge: 1 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, ...ring, "totalHydrogens/4": 0.25, sphere2PositiveCharge: 1 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, ...ring, "totalHydrogens/4": 0.25, sphere1PositiveCharge: 1 },
      { "element=N": 1, formalCharge: 1, ...NEUTRAL_UNSPECIFIED, ...ring, "totalHydrogens/4": 0.25 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, ...ring, "totalHydrogens/4": 0.25, sphere1PositiveCharge: 1 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, ...ring, "totalHydrogens/4": 0.25, sphere2PositiveCharge: 1 }
    ]);
    const acetate = features("acetate");
    expect(acetate.atoms[3]).toEqual(features("sodium acetate").atoms[3]);
    expect(atomNonZero(acetate.atoms[3])).toEqual({ "element=O": 1, formalCharge: -1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25 });
    expect(atomNonZero(acetate.atoms[2])).toEqual({
      "element=O": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, "piElectrons/2": 0.5, sphere2NegativeCharge: 1
    });
    expect(atomNonZero(features("sodium acetate").atoms[4])).toEqual({ "element=other": 1, formalCharge: 1, ...NEUTRAL_UNSPECIFIED });
  });

  it("aromatic bonds: delocalized in pyridine, aromatic but not delocalized in furan", () => {
    expect(features("pyridine").bonds.map((bond) => bond.features)).toEqual(
      Array(6).fill([0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0])
    );
    expect(features("furan").bonds.map((bond) => bond.features)).toEqual(
      Array(5).fill([0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0])
    );
    expect(atomNonZero(features("pyrrole").atoms[3])).toEqual({
      "element=N": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.25, "heavyDegree/4": 0.5, aromatic: 1, inRing: 1, "smallestRingSize/8": 0.625
    });
  });

  it("ring size is capped at 8 and triple bonds are their own order", () => {
    expect(features("cyclododecane").atoms.every((row) => row[atomFeature("smallestRingSize/8")] === 1)).toBe(true);
    expect(features("cyclopropane").atoms.every((row) => row[atomFeature("smallestRingSize/8")] === 0.375)).toBe(true);
    expect(bondNonZero(features("acetonitrile").bonds[1].features)).toEqual({ "order=triple": 1, ...PLAIN_BOND });
    expect(atomNonZero(features("acetonitrile").atoms[2])).toEqual({ "element=N": 1, ...NEUTRAL_UNSPECIFIED, "heavyDegree/4": 0.25, "piElectrons/2": 1 });
  });

  it("element slots, including Si, Se, B, P and other", () => {
    const centralSlot = (name: string, node: number) => GNN_ATOM_FEATURE_NAMES[features(name).atoms[node].indexOf(1)];
    expect(centralSlot("tetramethylsilane", 1)).toBe("element=Si");
    expect(centralSlot("dimethyl selenide", 1)).toBe("element=Se");
    expect(centralSlot("trimethylborane", 1)).toBe("element=B");
    expect(centralSlot("trimethylphosphine", 1)).toBe("element=P");
    expect(centralSlot("tetramethyltin", 1)).toBe("element=other");
    expect(centralSlot("chloroform", 0)).toBe("element=Cl");
    expect(centralSlot("iodomethane", 1)).toBe("element=I");
  });
});

/** Name of the set slot in a 4-slot one-hot group that starts at `first`. */
function slotName(row: readonly number[], names: readonly string[], first: number): string {
  const set = row.slice(first, first + 4).flatMap((value, offset) => (value === 1 ? [names[first + offset]] : []));
  if (set.length !== 1) throw new Error(`expected one set slot, got ${set.join(",") || "none"}`);
  return set[0];
}
const atomCip = (row: readonly number[]) => slotName(row, GNN_ATOM_FEATURE_NAMES, atomFeature("atomCIP=none")).replace("atomCIP=", "");
const bondCip = (row: readonly number[]) => slotName(row, GNN_BOND_FEATURE_NAMES, bondFeature("bondCIP=none")).replace("bondCIP=", "");
const atomCips = (result: GnnMoleculeFeatures) => result.atoms.map(atomCip);
const bondCips = (result: GnnMoleculeFeatures) => result.bonds.map((bond) => bondCip(bond.features));

/** Every feature except the CIP one-hot groups; edges keep their endpoints. */
function withoutCip(result: GnnMoleculeFeatures) {
  const atomFirst = atomFeature("atomCIP=none");
  const bondFirst = bondFeature("bondCIP=none");
  return {
    heavyAtomIndexMap: result.heavyAtomIndexMap,
    atoms: result.atoms.map((row) => [...row.slice(0, atomFirst), ...row.slice(atomFirst + 4)]),
    bonds: result.bonds.map((bond) => [bond.from, bond.to, ...bond.features.slice(0, bondFirst), ...bond.features.slice(bondFirst + 4)])
  };
}

/** Atom rows and undirected edges (endpoint rows plus bond row) as sorted strings: the order-free content. */
function featureMultisets(result: GnnMoleculeFeatures) {
  const atoms = result.atoms.map((row) => row.join(","));
  const edges = result.bonds.map((bond) => {
    const ends = [atoms[bond.from], atoms[bond.to]].sort();
    return `${ends[0]}|${ends[1]}|${bond.features.join(",")}`;
  });
  return { atoms: [...atoms].sort(), edges: edges.sort() };
}

/**
 * Rewrite a V2000 molfile with its atoms listed in `order` (`order[k]` is the 0-based original index of
 * new atom k) and its bonds listed in reverse. Every bond keeps its direction, so a wedge keeps its
 * narrow end, and M  CHG / ISO / RAD entries are renumbered.
 */
function reorderMolfile(text: string, order: readonly number[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const atomCount = Number(lines[3].slice(0, 3));
  const bondCount = Number(lines[3].slice(3, 6));
  if ([...order].sort((a, b) => a - b).join() !== Array.from({ length: atomCount }, (_, index) => index).join()) {
    throw new Error("order is not a permutation of the atoms");
  }
  const newNumber = new Map(order.map((old, index) => [old + 1, index + 1]));
  const renumber = (old: number) => newNumber.get(old) as number;
  const atomLines = lines.slice(4, 4 + atomCount);
  const bondLines = lines.slice(4 + atomCount, 4 + atomCount + bondCount);
  const properties = lines.slice(4 + atomCount + bondCount).map((line) => {
    const match = /^M {2}(CHG|ISO|RAD)/.exec(line);
    if (!match) return line;
    const count = Number(line.slice(6, 9));
    const pairs = Array.from({ length: count }, (_, index) => line.slice(9 + 8 * index, 17 + 8 * index));
    return `M  ${match[1]}${col(count, 3)}${pairs.map((pair) => `${col(renumber(Number(pair.slice(0, 4))), 4)}${pair.slice(4)}`).join("")}`;
  });
  return [
    ...lines.slice(0, 4),
    ...order.map((old) => atomLines[old]),
    ...[...bondLines].reverse().map((line) => `${col(renumber(Number(line.slice(0, 3))), 3)}${col(renumber(Number(line.slice(3, 6))), 3)}${line.slice(6)}`),
    ...properties
  ].join("\n") + "\n";
}

/** A fixed, seeded shuffle (linear congruential generator), so the test is reproducible. */
function seededPermutation(length: number, seed: number): number[] {
  const order = Array.from({ length }, (_, index) => index);
  let state = seed >>> 0;
  for (let index = length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other], order[index]];
  }
  return order;
}

describe("stereo features", () => {
  it("E/Z comes from the CIP descriptor; an unspecified or crossed double bond is unknown", () => {
    expect(features("(E)-2-butene").bonds[1].features).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(features("(Z)-2-butene").bonds[1].features).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    // OpenChemLib's index-relative getBondParity reads 1 ("E or 1") for this Z isomer; CIP reads Z.
    expect(bondCips(features("(Z)-2-fluorobut-2-ene"))).toEqual(["none", "none", "Z", "none"]);
    expect(bondCips(features("(E)-2-fluorobut-2-ene"))).toEqual(["none", "none", "E", "none"]);
    expect(bondCips(features("2-fluorobut-2-ene, E molfile"))).toEqual(["none", "none", "E", "none"]);
    expect(bondCips(features("2-fluorobut-2-ene, Z molfile"))).toEqual(["none", "none", "Z", "none"]);
    expect(bondNonZero(features("2-butene, unspecified").bonds[1].features)).toEqual({ "order=double": 1, "bondCIP=unknown": 1 });
    expect(bondCips(features("2-fluorobut-2-ene, crossed molfile"))).toEqual(["none", "none", "unknown", "none"]);
  });

  it.each([
    ["(E)-2-butene", "(Z)-2-butene", 1],
    ["(E)-2-fluorobut-2-ene", "(Z)-2-fluorobut-2-ene", 2],
    ["2-fluorobut-2-ene, E molfile", "2-fluorobut-2-ene, Z molfile", 2]
  ] as const)("%s and %s differ only in the E/Z bit of the double bond", (eName, zName, doubleBond) => {
    const e = features(eName);
    const z = features(zName);
    expect(z.atoms).toEqual(e.atoms);
    expect(z.heavyAtomIndexMap).toEqual(e.heavyAtomIndexMap);
    expect(z.bonds.map((bond) => [bond.from, bond.to])).toEqual(e.bonds.map((bond) => [bond.from, bond.to]));
    const differing = e.bonds.flatMap((bond, index) =>
      bond.features.flatMap((value, slot) => (value === z.bonds[index].features[slot] ? [] : [[index, GNN_BOND_FEATURE_NAMES[slot]]]))
    );
    expect(differing).toEqual([[doubleBond, "bondCIP=E"], [doubleBond, "bondCIP=Z"]]);
  });

  it("enantiomers from SMILES get opposite R/S on the stereo center and identical features elsewhere", () => {
    const l = features("L-alanine");
    const d = features("D-alanine");
    expect(atomCips(l)).toEqual(["none", "S", "none", "none", "none", "none"]);
    expect(atomCips(d)).toEqual(["none", "R", "none", "none", "none", "none"]);
    expect(atomNonZero(l.atoms[1])).toEqual({
      "element=C": 1, "radical=none": 1, "totalHydrogens/4": 0.25, "heavyDegree/4": 0.75, "atomCIP=S": 1
    });
    expect(withoutCip(d)).toEqual(withoutCip(l));
    expect(d.bonds).toEqual(l.bonds); // no bond feature depends on the configuration or the drawing
    // L-alanine written from the other end still reads S, which index-relative parity did not.
    expect(atomCips(featurizeStructure({ format: "smiles", value: "C[C@H](N)C(=O)O" }))).toEqual(["none", "S", "none", "none", "none", "none"]);
    expect(atomCips(featurizeStructure({ format: "smiles", value: "C[C@@H](N)C(=O)O" }))).toEqual(["none", "R", "none", "none", "none", "none"]);
    // Determinism across alternating enantiomers.
    const first = canonicalFeatureLine({ index: 0, molfileSha256: null }, l);
    features("D-alanine");
    expect(canonicalFeatureLine({ index: 0, molfileSha256: null }, features("L-alanine"))).toBe(first);
  });

  it("a drawn wedge and hash give R and S and nothing else differs", () => {
    const wedge = features("alanine, wedge");
    const hash = features("alanine, hash");
    expect(atomCips(wedge)).toEqual(["R", "none", "none", "none", "none", "none"]);
    expect(atomCips(hash)).toEqual(["S", "none", "none", "none", "none", "none"]);
    expect(withoutCip(hash)).toEqual(withoutCip(wedge));
    expect(hash.bonds).toEqual(wedge.bonds);
    // The drawn (S) molfile and the L-alanine SMILES agree feature for feature, in any atom order.
    expect(featureMultisets(hash)).toEqual(featureMultisets(features("L-alanine")));
    expect(featureMultisets(wedge)).toEqual(featureMultisets(features("D-alanine")));
  });

  it("a stereo center drawn through an explicit H keeps its R/S once H is folded", () => {
    const wedge = features("CHFClBr, explicit H wedge");
    const hash = features("CHFClBr, explicit H hash");
    expect(wedge.heavyAtomIndexMap).toEqual([0, 1, 2, 3]);
    // Br (down) → Cl (right) → F (left) runs counterclockwise; with H toward the viewer that is (R).
    expect(atomCip(wedge.atoms[0])).toBe("R");
    expect(atomCip(hash.atoms[0])).toBe("S");
    expect(withoutCip(hash)).toEqual(withoutCip(wedge));
    expect(wedge.atoms[0][atomFeature("totalHydrogens/4")]).toBe(0.25);
  });

  it("undefined stereo reads unknown, not none", () => {
    expect(atomCips(features("alanine, unspecified"))).toEqual(["none", "unknown", "none", "none", "none", "none"]);
    expect(atomCips(features("alanine, plain"))).toEqual(["unknown", "none", "none", "none", "none", "none"]);
    expect(withoutCip(features("alanine, plain"))).toEqual(withoutCip(features("alanine, wedge")));
    expect(bondCip(features("2-butene, unspecified").bonds[1].features)).toBe("unknown");
  });

  it("pins OpenChemLib 9.24.0 on relative configurations: pseudo-asymmetric r/s fills the R/S slots, ring cis/trans reads unknown", () => {
    // Meso 2,4-difluoropentan-3-ol: C3 is pseudo-asymmetric; its r/s labels land in the R/S slots.
    const r = features("meso pentane-2,4-difluoro-3-ol, r");
    const s = features("meso pentane-2,4-difluoro-3-ol, s");
    expect(atomCips(r)).toEqual(["none", "S", "none", "S", "none", "R", "none", "none"]);
    expect(atomCips(s)).toEqual(["none", "S", "none", "R", "none", "R", "none", "none"]);
    // cis/trans-1,4-dimethylcyclohexane has no CIP label: both ring centers read unknown, exactly as
    // when the configuration is not drawn. Schema 1 does not distinguish these diastereomers.
    const cis = features("cis-1,4-dimethylcyclohexane");
    expect(atomCips(cis)).toEqual(["none", "unknown", "none", "none", "unknown", "none", "none", "none"]);
    expect(features("trans-1,4-dimethylcyclohexane")).toEqual(cis);
    expect(featureMultisets(features("1,4-dimethylcyclohexane, unspecified"))).toEqual(featureMultisets(cis));
  });

  const reorderCases: readonly (readonly [string, string])[] = [
    ["(S)-alanine, wedge drawing", alanineMolfile(6)],
    ["(Z)-2-fluorobut-2-ene drawing", fluorobuteneMolfile("Z")],
    ["CHFClBr with an explicit H wedge", bromochlorofluoromethaneMolfile(1)],
    ...[
      ["L-alanine", "N[C@@H](C)C(=O)O"],
      ["(E)-2-fluorobut-2-ene", "C/C(F)=C\\C"],
      ["a menthol stereoisomer", "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O"],
      ["an (E)-4-chloropent-2-en-1-ol enantiomer", "OC/C=C/[C@H](Cl)C"],
      ["glycine zwitterion", "[NH3+]CC([O-])=O"],
      ["meso pentane-2,4-difluoro-3-ol", "C[C@H](F)[C@H](O)[C@H](F)C"]
    ].map(([name, value]) => [`${name} (OpenChemLib molfile)`, OCL.Molecule.fromSmiles(value).toMolfile()] as const)
  ];

  it.each(reorderCases)("%s: reordering the molfile atoms and bonds leaves the feature multisets unchanged", (name, text) => {
    const original = featurizeStructure(molfileStructureInput(text));
    const atomCount = Number(text.split("\n")[3].slice(0, 3));
    const orders = [
      Array.from({ length: atomCount }, (_, index) => atomCount - 1 - index),
      seededPermutation(atomCount, 7),
      seededPermutation(atomCount, 2026)
    ];
    const referenceId = OCL.Molecule.fromMolfile(text).getIDCode();
    const hasStereo = original.atoms.some((row) => atomCip(row) !== "none") || original.bonds.some((bond) => bondCip(bond.features) !== "none");
    if (!/glycine/.test(name)) expect(hasStereo).toBe(true);
    for (const order of orders) {
      const reordered = reorderMolfile(text, order);
      expect(OCL.Molecule.fromMolfile(reordered).getIDCode()).toBe(referenceId); // the same stereoisomer
      const result = featurizeStructure(molfileStructureInput(reordered));
      expect(featureMultisets(result)).toEqual(featureMultisets(original));
    }
  });

  it("without explicit hydrogens, a reordered molfile gives each atom exactly its original row", () => {
    const text = OCL.Molecule.fromSmiles("CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O").toMolfile();
    const original = featurizeStructure(molfileStructureInput(text));
    const order = seededPermutation(original.atoms.length, 11);
    const reordered = featurizeStructure(molfileStructureInput(reorderMolfile(text, order)));
    expect(reordered.heavyAtomIndexMap).toEqual(order.map((_, index) => index));
    order.forEach((old, index) => expect(reordered.atoms[index]).toEqual(original.atoms[old]));
    expect(atomCips(original).filter((label) => label !== "none").sort()).toEqual(["R", "R", "S"]);
  });

  it("an OpenChemLib molfile of a SMILES gives the SMILES's features", () => {
    for (const value of ["N[C@@H](C)C(=O)O", "C/C(F)=C\\C", "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O"]) {
      const direct = featurizeStructure({ format: "smiles", value });
      expect(featurizeStructure(molfileStructureInput(OCL.Molecule.fromSmiles(value).toMolfile()))).toEqual(direct);
    }
  });
});

describe("isotopes and radicals", () => {
  it("2H is folded into the host's hydrogen count and counted separately", () => {
    const result = features("methanol-d4");
    expect(result.atoms.map(atomNonZero)).toEqual([
      { "element=O": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.25, "attachedDeuterium/4": 0.25, "heavyDegree/4": 0.25 },
      { "element=C": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 0.75, "attachedDeuterium/4": 0.75, "heavyDegree/4": 0.25 }
    ]);
    expect(atomNonZero(features("tritiomethane").atoms[0])).toEqual({
      "element=C": 1, ...NEUTRAL_UNSPECIFIED, "totalHydrogens/4": 1, "attachedTritium/4": 0.25
    });
  });

  it("13C sets the isotope flag and a mass delta of 1, from SMILES and from M  ISO alike", () => {
    const fromSmiles = features("13C methanol");
    expect(features("13C methanol molfile").atoms).toEqual(fromSmiles.atoms);
    expect(atomNonZero(fromSmiles.atoms[0])).toEqual({
      "element=C": 1, ...NEUTRAL_UNSPECIFIED, isotopeLabeled: 1, isotopeMassDelta: 1, "totalHydrogens/4": 0.75, "heavyDegree/4": 0.25
    });
    const unlabeled = features("ethanol");
    expect(unlabeled.atoms.every((row) => row[atomFeature("isotopeLabeled")] === 0)).toBe(true);
  });

  it("radical states map to their one-hot slots", () => {
    const radicalSlot = (name: string, node: number) => {
      const row = features(name).atoms[node];
      return GNN_ATOM_FEATURE_NAMES[atomFeature("radical=none") + row.slice(atomFeature("radical=none"), atomFeature("radical=none") + 4).indexOf(1)];
    };
    expect(radicalSlot("methyl radical", 0)).toBe("radical=doublet");
    expect(radicalSlot("methoxy radical", 1)).toBe("radical=doublet");
    expect(radicalSlot("triplet methylene", 0)).toBe("radical=triplet");
    expect(radicalSlot("singlet methylene", 0)).toBe("radical=singlet");
    expect(radicalSlot("methoxy radical", 0)).toBe("radical=none");
  });
});

describe("explicit hydrogens and molfile atom order", () => {
  it("explicit hydrogens listed last give exactly the implicit-H features and indices", () => {
    expect(features("ethanol, H last")).toEqual(features("ethanol"));
  });

  it("explicit [H] in SMILES gives the same rows; OpenChemLib's heavy-atom order is reported in the map", () => {
    const explicit = features("ethanol, explicit [H]");
    const implicit = features("ethanol");
    const rows = (result: GnnMoleculeFeatures) => result.atoms.map((row) => row.join(",")).sort();
    expect(rows(explicit)).toEqual(rows(implicit));
    const molecule = parse({ format: "smiles", value: "[H]OC([H])([H])C([H])([H])[H]" });
    explicit.heavyAtomIndexMap.forEach((atom, node) => {
      expect(explicit.atoms[node].indexOf(1)).toBe(molecule.getAtomicNo(atom) === 8 ? 4 : 2);
    });
  });

  it("heavy atoms keep molfile order, and interleaved hydrogens map back through molfile atom numbers", () => {
    const hLast = parseNmredataMolecule(ETHANOL_H_LAST);
    const interleaved = parseNmredataMolecule(ETHANOL_INTERLEAVED);
    if (!hLast || !interleaved) throw new Error("parse failed");
    const lastFeatures = featurizeMolecule(hLast.molecule);
    expect(lastFeatures.heavyAtomIndexMap.map((atom) => hLast.molecule.getAtomMapNo(atom))).toEqual([1, 2, 3]);

    const interleavedFeatures = featurizeMolecule(interleaved.molecule);
    // Same molecule, heavy molfile atoms 1, 5, 8 ↔ 1, 2, 3 in the H-last drawing.
    const byMolfileAtom = (molfileAtom: number) =>
      interleavedFeatures.atoms[interleavedFeatures.heavyAtomIndexMap.indexOf(interleaved.oclAtomByMolfileIndex.get(molfileAtom) as number)];
    expect([1, 5, 8].map(byMolfileAtom)).toEqual(lastFeatures.atoms);
    // The NMReDATA parse (atom-map stamps) and the plugin parse see the same OpenChemLib atom order.
    expect(interleavedFeatures).toEqual(featurizeStructure(molfileStructureInput(ETHANOL_INTERLEAVED)));
    expect(lastFeatures).toEqual(featurizeStructure(molfileStructureInput(ETHANOL_H_LAST)));
  });

  it("an unattached hydrogen is a node of its own", () => {
    const result = features("dihydrogen");
    expect(result.heavyAtomIndexMap).toEqual([0, 1]);
    expect(result.atoms.map((row) => row[atomFeature("element=H")])).toEqual([1, 1]);
    expect(result.bonds).toEqual([{ from: 0, to: 1, features: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Canonical dump, worker path and the parity script
// ---------------------------------------------------------------------------------------------

const SD_MOLFILES = [ETHANOL_H_LAST, ETHANOL_INTERLEAVED, alanineMolfile(1), NITROMETHANE_PENTAVALENT, NITROMETHANE_CHARGED_MOLFILE, METHANOL_13C, SINGLET_METHYLENE];
const EMPTY_MOLFILE = "empty\n  gnn-test\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\nM  END\n";
const SD_CONTENT = [
  ...SD_MOLFILES.map((block) => `${block}> <NAME>\nrecord\n\n$$$$\n`),
  `${EMPTY_MOLFILE}$$$$\n`,
  "no molfile here\n$$$$\n"
].join("").replace(/\n/g, "\r\n"); // CRLF on purpose: the dump normalizes line endings

describe("canonical dump", () => {
  it("prints numbers by one fixed rule and refuses values that are not exact in float32", () => {
    expect([0, 1, -1, 0.25, 0.125, 0.375, 1.5, 12].map(formatFeatureNumber)).toEqual(["0", "1", "-1", "0.25", "0.125", "0.375", "1.5", "12"]);
    expect(formatFeatureNumber(-0)).toBe("0");
    expect(() => formatFeatureNumber(0.1)).toThrow();
    expect(() => formatFeatureNumber(Number.NaN)).toThrow();
  });

  it("writes a header, one line per record and stable error codes", async () => {
    const dump = await buildCanonicalFeatureDump(SD_CONTENT);
    const lines = dump.text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(`${lines[0]}\n`).toBe(canonicalDumpHeader());
    expect(JSON.parse(lines[0])).toEqual({
      format: "chemdraft-gnn-features",
      schemaVersion: "1",
      atomFeatures: GNN_ATOM_FEATURE_NAMES,
      bondFeatures: GNN_BOND_FEATURE_NAMES
    });
    expect({ records: dump.records, featurized: dump.featurized, errors: dump.errors }).toEqual({ records: 9, featurized: 7, errors: 2 });
    const records = lines.slice(1, -1).map((line) => JSON.parse(line));
    expect(records.map((record) => Object.keys(record))).toEqual([
      ...SD_MOLFILES.map(() => ["index", "molfileSha256", "schemaVersion", "heavyAtomIndexMap", "atoms", "bonds"]),
      ["index", "molfileSha256", "error"],
      ["index", "molfileSha256", "error"]
    ]);
    expect(records.slice(-2)).toEqual([
      { index: 7, molfileSha256: await sha256Hex(EMPTY_MOLFILE.replace(/\n$/, "")), error: "NMR_STRUCTURE_PARSE_FAILED" },
      { index: 8, molfileSha256: null, error: "GNN_NO_MOLFILE" }
    ]);
    expect(records[0].molfileSha256).toBe(await sha256Hex(ETHANOL_H_LAST.replace(/\n$/, "")));
    expect(records[0].atoms).toEqual(features("ethanol").atoms);
    expect(dump.sha256).toBe(await sha256Hex(dump.text));
    expect(dump.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await buildCanonicalFeatureDump(SD_CONTENT.replace(/\r\n/g, "\n"))).text).toBe(dump.text);
  });

  it("featurizing inside the worker message path gives the direct call's bytes", async () => {
    const responses: NmrWorkerResponse[] = [];
    // The worker posts structured clones; clone here exactly as postMessage would.
    const handle = createNmrWorkerHandler((response) => responses.push(structuredClone(response)), {
      createPredictor: (): NmrPredictor => ({
        getCapabilities: () => ({
          id: "chemdraft.gnn-featurizer-probe",
          version: "1",
          execution: "worker-js",
          nuclei: ["1H", "13C"],
          supportsAtomAssignments: true,
          supportsUncertainty: false,
          supportsCouplings: false,
          supportsSolvent: false,
          supportsConformers: false,
          supportsStereochemistry: true
        }),
        predict: async (request): Promise<NmrPredictionResult> => {
          const result = featurizeStructure(request.structure);
          return {
            schemaVersion: "1",
            sourceFingerprint: request.sourceFingerprint ?? "",
            backend: { id: "chemdraft.gnn-featurizer-probe", version: "1", method: "featurize-only" },
            resonances: [],
            warnings: [{
              code: "GNN_FEATURES",
              message: "features",
              severity: "info",
              details: { features: result, line: canonicalFeatureLine({ index: 0, molfileSha256: null }, result) }
            }],
            generatedAt: "fixed"
          };
        }
      })
    });

    for (const [index, entry] of SYNTHETIC.entries()) {
      handle({
        type: "predict",
        requestId: `p${index}`,
        sourceFingerprint: `fp${index}`,
        request: { structure: entry.input, nuclei: ["13C"], options: { statistic: "median", hoseLevels: [4], ignoreLabileHydrogens: true } }
      });
      await new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
      const response = responses.find((candidate) => candidate.type === "result" && candidate.requestId === `p${index}`);
      if (!response || response.type !== "result") throw new Error(`no worker result for ${entry.name}`);
      const details = response.result.warnings[0].details as { features: GnnMoleculeFeatures; line: string };
      const direct = featurizeStructure(entry.input);
      expect(details.features, entry.name).toEqual(direct);
      expect(details.line, entry.name).toBe(canonicalFeatureLine({ index: 0, molfileSha256: null }, direct));
      expect(canonicalFeatureLine({ index: 0, molfileSha256: null }, details.features)).toBe(details.line);
    }
  });

  it("a fresh worker thread produces the same dump bytes and SHA-256", async () => {
    const direct = await buildCanonicalFeatureDump(SD_CONTENT);
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       import(workerData.tsxApi)
         .then(({ tsImport }) => tsImport(workerData.module, workerData.parent))
         .then((module) => module.buildCanonicalFeatureDump(workerData.sd))
         .then((dump) => parentPort.postMessage({ text: dump.text, sha256: dump.sha256 }))
         .catch((error) => parentPort.postMessage({ error: String((error && error.stack) || error) }));`,
      {
        eval: true,
        workerData: {
          tsxApi: pathToFileURL(resolve(REPO_ROOT, "node_modules/tsx/dist/esm/api/index.mjs")).href,
          module: pathToFileURL(resolve(REPO_ROOT, "src/providers/gnn/canonicalDump.ts")).href,
          parent: pathToFileURL(resolve(REPO_ROOT, "src/tests/gnnFeaturize.test.ts")).href,
          sd: SD_CONTENT
        }
      }
    );
    try {
      const message = await new Promise<{ text?: string; sha256?: string; error?: string }>((resolveMessage, reject) => {
        worker.once("message", resolveMessage);
        worker.once("error", reject);
      });
      expect(message.error).toBeUndefined();
      expect(message.sha256).toBe(direct.sha256);
      expect(message.text).toBe(direct.text);
    } finally {
      await worker.terminate();
    }
  }, 60_000);

  it("the parity script writes the same dump, its SHA-256 file, and checks an expected hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "gnn-feature-parity-"));
    try {
      const input = join(root, "synthetic.sd");
      const output = join(root, "features.jsonl");
      writeFileSync(input, SD_CONTENT);
      const run = (...extra: string[]) => spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/gnn-feature-parity.ts", input, output, ...extra],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
      const direct = await buildCanonicalFeatureDump(SD_CONTENT);

      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        sha256: direct.sha256,
        bytes: new TextEncoder().encode(direct.text).byteLength,
        records: 9,
        featurized: 7,
        errors: 2
      });
      expect(readFileSync(output, "utf8")).toBe(direct.text);
      expect(readFileSync(`${output}.sha256`, "utf8")).toBe(`${direct.sha256}  features.jsonl\n`);
      expect(createHash("sha256").update(readFileSync(output)).digest("hex")).toBe(direct.sha256);

      expect(run("--expect-sha256", direct.sha256).status).toBe(0);
      const mismatch = run("--expect-sha256", "0".repeat(64));
      expect(mismatch.status).toBe(2);
      expect(mismatch.stderr).toContain("SHA-256 mismatch");
      expect(run("--expect-sha256", "not-a-hash").status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
