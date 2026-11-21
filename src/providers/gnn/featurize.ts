/**
 * Per-atom graph features for the planned ¹H/¹³C graph neural network (GNN) predictor.
 *
 * One featurizer serves both sides of the model: the training extract (Node, via
 * `scripts/gnn-feature-parity.ts`) and the plugin's Web Worker at prediction time. It is therefore a
 * pure function of an OpenChemLib molecule. It imports no Node-only module, never reads the clock,
 * a random source, the locale or the platform, and never mutates the caller's molecule. Every value
 * it emits is an integer or a multiple of 1/8 small enough to be exact in IEEE single precision, so
 * `Float32Array.from(row)` is lossless and the canonical dump prints the same digits everywhere.
 *
 * Graph nodes are heavy atoms. A hydrogen atom bonded to at least one non-hydrogen atom is folded
 * into that atom's hydrogen counts, whatever its isotope. Only a hydrogen with no non-hydrogen
 * neighbor (H₂, H⁺, H⁻, a lone [H]) becomes a node of its own, with the H element slot set.
 *
 * Every feature and its exact OpenChemLib call is documented in docs/gnn-features.md. Changing a
 * feature, its order or its scaling changes the schema and must bump GNN_FEATURE_SCHEMA_VERSION.
 */
import * as OCL from "openchemlib";

import { normalizeStructure } from "../../application/normalizeStructure";
import type { ChemicalStructureInput } from "../../domain/contracts";

export const GNN_FEATURE_SCHEMA_VERSION = "1" as const;

/** Element one-hot slots, in order. Any other element sets the trailing "other" slot. */
export const GNN_ELEMENT_SYMBOLS = ["H", "B", "C", "N", "O", "F", "Si", "P", "S", "Cl", "Se", "Br", "I"] as const;
const ELEMENT_ATOMIC_NUMBERS: readonly number[] = [1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 34, 35, 53];

/** Fixed divisors. All are powers of two so every scaled count stays exact in single precision. */
export const GNN_FEATURE_SCALES = {
  hydrogenCount: 4,
  heavyDegree: 4,
  piElectrons: 2,
  /** Smallest ring sizes above this value are reported as this value, then divided by it. */
  ringSizeCap: 8
} as const;

/** Topological spheres summarized by the neighbor-charge features. Equal to the HOSE MAX_SPHERES. */
export const GNN_NEIGHBOR_CHARGE_SPHERES = 4;

export const GNN_ATOM_FEATURE_NAMES: readonly string[] = [
  ...GNN_ELEMENT_SYMBOLS.map((symbol) => `element=${symbol}`),
  "element=other",
  "formalCharge",
  "radical=none",
  "radical=singlet",
  "radical=doublet",
  "radical=triplet",
  "isotopeLabeled",
  "isotopeMassDelta",
  "totalHydrogens/4",
  "attachedDeuterium/4",
  "attachedTritium/4",
  "heavyDegree/4",
  "piElectrons/2",
  "aromatic",
  "inRing",
  "smallestRingSize/8",
  "atomCIP=none",
  "atomCIP=R",
  "atomCIP=S",
  "atomCIP=unknown",
  ...Array.from({ length: GNN_NEIGHBOR_CHARGE_SPHERES }, (_, index) => [
    `sphere${index + 1}PositiveCharge`,
    `sphere${index + 1}NegativeCharge`
  ]).flat()
];

export const GNN_BOND_FEATURE_NAMES: readonly string[] = [
  "order=single",
  "order=double",
  "order=triple",
  "order=aromaticOrDelocalized",
  "order=other",
  "inRing",
  "delocalized",
  "bondCIP=none",
  "bondCIP=E",
  "bondCIP=Z",
  "bondCIP=unknown"
];

export const GNN_ATOM_FEATURE_COUNT = GNN_ATOM_FEATURE_NAMES.length;
export const GNN_BOND_FEATURE_COUNT = GNN_BOND_FEATURE_NAMES.length;

export interface GnnBondFeatures {
  /** Node index of `getBondAtom(0, bond)`. No feature depends on which end is `from`. */
  from: number;
  /** Node index of `getBondAtom(1, bond)`. */
  to: number;
  features: number[];
}

export interface GnnMoleculeFeatures {
  schemaVersion: typeof GNN_FEATURE_SCHEMA_VERSION;
  /** One row of GNN_ATOM_FEATURE_COUNT values per node, in node order. */
  atoms: number[][];
  /** Bonds between two nodes, in OpenChemLib bond-index order of the prepared molecule. */
  bonds: GnnBondFeatures[];
  /** Node index → atom index in the molecule passed in. This is the index the HOSE path uses. */
  heavyAtomIndexMap: number[];
}

export const GnnFeaturizationErrorCodes = {
  UnvalidatedMolecule: "GNN_UNVALIDATED_MOLECULE",
  AtomIndexChanged: "GNN_ATOM_INDEX_CHANGED",
  StereoPerceptionFailed: "GNN_STEREO_PERCEPTION_FAILED",
  NonFloat32Feature: "GNN_NON_FLOAT32_FEATURE"
} as const;

export type GnnFeaturizationErrorCode =
  (typeof GnnFeaturizationErrorCodes)[keyof typeof GnnFeaturizationErrorCodes];

export class GnnFeaturizationError extends Error {
  readonly code: GnnFeaturizationErrorCode;

  constructor(code: GnnFeaturizationErrorCode, message: string) {
    super(message);
    this.name = "GnnFeaturizationError";
    this.code = code;
  }
}

/**
 * Parse a structure exactly as the plugin's predictor does (`normalizeStructure`), then featurize it.
 * This is the runtime entry point inside the worker and the one the parity dump uses.
 */
export function featurizeStructure(input: ChemicalStructureInput): GnnMoleculeFeatures {
  return featurizeMolecule(normalizeStructure(input).molecule);
}

/**
 * Featurize a parsed OpenChemLib molecule (`Molecule.fromMolfile`, `fromSmiles`, `normalizeStructure`
 * or `parseNmredataMolecule`). The caller's molecule is only read; all perception runs on a copy.
 */
export function featurizeMolecule(molecule: OCL.Molecule): GnnMoleculeFeatures {
  const prepared = prepareGnnMolecule(molecule);

  const atomCount = prepared.getAllAtoms();
  const isHydrogen = (atom: number) => prepared.getAtomicNo(atom) === 1;
  const hasHeavyNeighbor = new Array<boolean>(atomCount).fill(false);
  for (let bond = 0; bond < prepared.getAllBonds(); bond += 1) {
    const first = prepared.getBondAtom(0, bond);
    const second = prepared.getBondAtom(1, bond);
    if (!isHydrogen(second)) hasHeavyNeighbor[first] = true;
    if (!isHydrogen(first)) hasHeavyNeighbor[second] = true;
  }

  const nodeByAtom = new Array<number>(atomCount).fill(-1);
  const heavyAtomIndexMap: number[] = [];
  for (let atom = 0; atom < atomCount; atom += 1) {
    if (isHydrogen(atom) && hasHeavyNeighbor[atom]) continue; // folded into its heavy neighbor
    nodeByAtom[atom] = heavyAtomIndexMap.length;
    heavyAtomIndexMap.push(atom);
  }
  assertNodeAtomsPreserved(molecule, prepared, heavyAtomIndexMap);

  const nodeCount = heavyAtomIndexMap.length;
  const heavyDegree = new Array<number>(nodeCount).fill(0);
  const deuterium = new Array<number>(nodeCount).fill(0);
  const tritium = new Array<number>(nodeCount).fill(0);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const bonds: GnnBondFeatures[] = [];

  for (let bond = 0; bond < prepared.getAllBonds(); bond += 1) {
    const first = prepared.getBondAtom(0, bond);
    const second = prepared.getBondAtom(1, bond);
    for (const [atom, other] of [[first, second], [second, first]]) {
      const node = nodeByAtom[atom];
      if (node < 0) continue;
      if (!isHydrogen(other)) heavyDegree[node] += 1;
      else if (nodeByAtom[other] < 0) {
        const mass = prepared.getAtomMass(other);
        if (mass === 2) deuterium[node] += 1;
        else if (mass === 3) tritium[node] += 1;
      }
    }
    const from = nodeByAtom[first];
    const to = nodeByAtom[second];
    if (from < 0 || to < 0) continue;
    adjacency[from].push(to);
    adjacency[to].push(from);
    bonds.push({ from, to, features: bondFeatures(prepared, bond) });
  }

  const neighborCharges = sphereCharges(prepared, heavyAtomIndexMap, adjacency);
  const atoms = heavyAtomIndexMap.map((atom, node) => [
    ...elementOneHot(prepared.getAtomicNo(atom)),
    prepared.getAtomCharge(atom),
    ...radicalOneHot(prepared.getAtomRadical(atom)),
    prepared.getAtomMass(atom) !== 0 ? 1 : 0,
    isotopeMassDelta(prepared, atom),
    prepared.getAllHydrogens(atom) / GNN_FEATURE_SCALES.hydrogenCount,
    deuterium[node] / GNN_FEATURE_SCALES.hydrogenCount,
    tritium[node] / GNN_FEATURE_SCALES.hydrogenCount,
    heavyDegree[node] / GNN_FEATURE_SCALES.heavyDegree,
    prepared.getAtomPi(atom) / GNN_FEATURE_SCALES.piElectrons,
    prepared.isAromaticAtom(atom) ? 1 : 0,
    prepared.isRingAtom(atom) ? 1 : 0,
    Math.min(prepared.getAtomRingSize(atom), GNN_FEATURE_SCALES.ringSizeCap) / GNN_FEATURE_SCALES.ringSizeCap,
    ...atomCipOneHot(prepared, atom),
    ...neighborCharges[node]
  ]);

  const features: GnnMoleculeFeatures = {
    schemaVersion: GNN_FEATURE_SCHEMA_VERSION,
    atoms,
    bonds,
    heavyAtomIndexMap
  };
  assertFloat32Exact(features);
  return features;
}

/**
 * The HOSE path's molecule preparation (`prepareProductionLookup` in ../ocl/productionLookup.ts), step
 * for step: an index-preserving compact copy, plain explicit hydrogens removed, atom-map numbers
 * cleared, rings perceived, heavy-atom indices verified. Cahn-Ingold-Prelog descriptors
 * (`cHelperCIP`) are perceived on top of that for the stereo features; that level includes everything
 * `cHelperRings` and `cHelperParities` compute.
 */
function prepareGnnMolecule(molecule: OCL.Molecule): OCL.Molecule {
  if ((molecule.getHelperArrayStatus() & OCL.Molecule.cHelperNeighbours) === 0) {
    // Validating a copy of an unvalidated molecule can move explicit hydrogens and renumber heavy
    // atoms in the copy only, so node indices would no longer refer to the caller's atoms.
    throw new GnnFeaturizationError(
      GnnFeaturizationErrorCodes.UnvalidatedMolecule,
      "featurizeMolecule needs a parsed molecule; call ensureHelperArrays(Molecule.cHelperNeighbours) after editing it."
    );
  }
  const prepared = molecule.getCompactCopy();
  assertAllAtomsPreserved(molecule, prepared);
  prepared.removeExplicitHydrogens();
  for (let atom = 0; atom < prepared.getAllAtoms(); atom += 1) prepared.setAtomMapNo(atom, 0, false);
  prepared.ensureHelperArrays(OCL.Molecule.cHelperRings);
  try {
    prepared.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  } catch (cause) {
    throw new GnnFeaturizationError(
      GnnFeaturizationErrorCodes.StereoPerceptionFailed,
      `OpenChemLib stereo perception failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  return prepared;
}

function elementOneHot(atomicNo: number): number[] {
  const slots = new Array<number>(ELEMENT_ATOMIC_NUMBERS.length + 1).fill(0);
  const index = ELEMENT_ATOMIC_NUMBERS.indexOf(atomicNo);
  slots[index >= 0 ? index : ELEMENT_ATOMIC_NUMBERS.length] = 1;
  return slots;
}

function radicalOneHot(radical: number): number[] {
  return oneHot(radical, [
    OCL.Molecule.cAtomRadicalStateNone,
    OCL.Molecule.cAtomRadicalStateS,
    OCL.Molecule.cAtomRadicalStateD,
    OCL.Molecule.cAtomRadicalStateT
  ]);
}

/** One-hot over `states`; a value outside them (never produced by OpenChemLib) sets no slot. */
function oneHot(value: number, states: readonly number[]): number[] {
  return states.map((state) => (value === state ? 1 : 0));
}

/** Labeled mass minus OpenChemLib's rounded natural mass for the element; 0 when unlabeled. */
function isotopeMassDelta(molecule: OCL.Molecule, atom: number): number {
  const mass = molecule.getAtomMass(atom);
  if (mass === 0) return 0;
  return mass - (OCL.Molecule.cRoundedMass[molecule.getAtomicNo(atom)] ?? 0);
}

function bondFeatures(molecule: OCL.Molecule, bond: number): number[] {
  const aromaticOrDelocalized =
    molecule.isAromaticBond(bond) ||
    molecule.isDelocalizedBond(bond) ||
    molecule.getBondTypeSimple(bond) === OCL.Molecule.cBondTypeDelocalized;
  const order = molecule.getBondOrder(bond);
  const orderSlot = aromaticOrDelocalized ? 3 : order === 1 ? 0 : order === 2 ? 1 : order === 3 ? 2 : 4;
  return [
    ...[0, 1, 2, 3, 4].map((slot) => (slot === orderSlot ? 1 : 0)),
    molecule.isRingBond(bond) ? 1 : 0,
    molecule.isDelocalizedBond(bond) ? 1 : 0,
    ...bondCipOneHot(molecule, bond)
  ];
}

/**
 * `[none, R, S, unknown]` for a stereo atom. R and S are OpenChemLib's Cahn-Ingold-Prelog descriptor
 * (`getAtomCIPParity`), which does not depend on atom numbering, unlike `getAtomParity`. `unknown` is a
 * stereo atom (`getAtomParity` not `cAtomParityNone`) without an R/S label: an undrawn or unknown
 * configuration, a CIP "problem", or a configuration CIP cannot name (the relative cis/trans of
 * 1,3-disubstituted cyclobutane). Whether an atom has a parity at all is numbering-independent; only
 * its odd/even value is not, and that value is never read. Axial M (allenes) shares the R slot and P
 * the S slot, as in OpenChemLib's `cAtomCIPParityRorM` / `cAtomCIPParitySorP`.
 */
function atomCipOneHot(molecule: OCL.Molecule, atom: number): number[] {
  const cip = molecule.getAtomCIPParity(atom);
  if (cip === OCL.Molecule.cAtomCIPParityRorM) return [0, 1, 0, 0];
  if (cip === OCL.Molecule.cAtomCIPParitySorP) return [0, 0, 1, 0];
  const stereo = molecule.getAtomParity(atom) !== OCL.Molecule.cAtomParityNone || cip !== OCL.Molecule.cAtomCIPParityNone;
  return stereo ? [0, 0, 0, 1] : [1, 0, 0, 0];
}

/**
 * `[none, E, Z, unknown]` for a stereo bond, from `getBondCIPParity` (numbering-independent, unlike
 * `getBondParity`). `unknown` is a stereo bond (`getBondParity` not `cBondParityNone`) without an E/Z
 * label: an unspecified or crossed double bond, or a CIP "problem". An axial (BINAP-type) single bond
 * reports P in the E slot and M in the Z slot, as in `cBondCIPParityEorP` / `cBondCIPParityZorM`.
 */
function bondCipOneHot(molecule: OCL.Molecule, bond: number): number[] {
  const cip = molecule.getBondCIPParity(bond);
  if (cip === OCL.Molecule.cBondCIPParityEorP) return [0, 1, 0, 0];
  if (cip === OCL.Molecule.cBondCIPParityZorM) return [0, 0, 1, 0];
  const stereo = molecule.getBondParity(bond) !== OCL.Molecule.cBondParityNone || cip !== OCL.Molecule.cBondCIPParityNone;
  return stereo ? [0, 0, 0, 1] : [1, 0, 0, 0];
}

/**
 * For each node and each sphere d = 1…GNN_NEIGHBOR_CHARGE_SPHERES: the summed positive formal charge
 * and the summed magnitude of negative formal charge over the nodes at shortest-path distance d.
 * This is the neighbor-charge information the charge-aware HOSE code writes into every sphere.
 */
function sphereCharges(molecule: OCL.Molecule, atomByNode: readonly number[], adjacency: readonly number[][]): number[][] {
  const charges = atomByNode.map((atom) => molecule.getAtomCharge(atom));
  return atomByNode.map((_, start) => {
    const sums = new Array<number>(2 * GNN_NEIGHBOR_CHARGE_SPHERES).fill(0);
    const distance = new Map<number, number>([[start, 0]]);
    let frontier = [start];
    for (let sphere = 1; sphere <= GNN_NEIGHBOR_CHARGE_SPHERES && frontier.length > 0; sphere += 1) {
      const next: number[] = [];
      for (const node of frontier) {
        for (const neighbor of adjacency[node]) {
          if (distance.has(neighbor)) continue;
          distance.set(neighbor, sphere);
          next.push(neighbor);
          const charge = charges[neighbor];
          if (charge > 0) sums[2 * (sphere - 1)] += charge;
          else if (charge < 0) sums[2 * (sphere - 1) + 1] -= charge;
        }
      }
      frontier = next;
    }
    return sums;
  });
}

function assertAllAtomsPreserved(source: OCL.Molecule, copy: OCL.Molecule): void {
  if (source.getAllAtoms() !== copy.getAllAtoms() || source.getAllBonds() !== copy.getAllBonds()) {
    throw new GnnFeaturizationError(
      GnnFeaturizationErrorCodes.AtomIndexChanged,
      "OpenChemLib molecule copy changed the atom or bond count."
    );
  }
  for (let atom = 0; atom < source.getAllAtoms(); atom += 1) assertSameAtom(source, copy, atom);
}

/** Every node, heavy or unattached hydrogen, must still be the caller's atom at the same index. */
function assertNodeAtomsPreserved(source: OCL.Molecule, prepared: OCL.Molecule, atomByNode: readonly number[]): void {
  let sourceHeavyAtoms = 0;
  for (let atom = 0; atom < source.getAllAtoms(); atom += 1) {
    if (source.getAtomicNo(atom) !== 1) sourceHeavyAtoms += 1;
  }
  const preparedHeavyAtoms = atomByNode.filter((atom) => prepared.getAtomicNo(atom) !== 1).length;
  if (sourceHeavyAtoms !== preparedHeavyAtoms) {
    throw new GnnFeaturizationError(
      GnnFeaturizationErrorCodes.AtomIndexChanged,
      "Removing explicit hydrogens changed the heavy-atom count."
    );
  }
  for (const atom of atomByNode) assertSameAtom(source, prepared, atom);
}

function assertSameAtom(source: OCL.Molecule, copy: OCL.Molecule, atom: number): void {
  if (
    atom >= source.getAllAtoms() ||
    source.getAtomicNo(atom) !== copy.getAtomicNo(atom) ||
    source.getAtomCharge(atom) !== copy.getAtomCharge(atom) ||
    source.getAtomMass(atom) !== copy.getAtomMass(atom)
  ) {
    throw new GnnFeaturizationError(
      GnnFeaturizationErrorCodes.AtomIndexChanged,
      `OpenChemLib molecule preparation changed atom index ${atom}.`
    );
  }
}

function assertFloat32Exact(features: GnnMoleculeFeatures): void {
  const rows = [...features.atoms, ...features.bonds.map((bond) => bond.features)];
  for (const row of rows) {
    for (const value of row) {
      if (!Number.isFinite(value) || Math.fround(value) !== value) {
        throw new GnnFeaturizationError(
          GnnFeaturizationErrorCodes.NonFloat32Feature,
          `Feature value ${value} is not exactly representable in single precision.`
        );
      }
    }
  }
}
