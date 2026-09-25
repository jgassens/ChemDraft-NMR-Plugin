import * as OCL from "openchemlib";

import type { NmrNucleus, NmrPredictionOptions } from "../../domain/contracts";
import { atomEnvironmentCodes, environmentKey, MAX_SPHERES } from "./environmentCode";
import type { CompiledNmrDatabase, NmrDatabaseEntry } from "./localDatabase";

export interface Match {
  code: string;
  entry: NmrDatabaseEntry;
}

export interface ProductionLookupResult {
  /** Input-molecule index of the canonical representative for this constitutional class. */
  representativeAtom: number;
  /** Canonical-molecule codes, deepest first, used by both lookup and unmatched fallbacks. */
  codes: readonly string[];
  match?: Match;
}

export interface ProductionLookupContext {
  carbonClasses: readonly (readonly number[])[];
  protonClasses: readonly (readonly number[])[];
  maxSpheres: number;
  /** Internal data is deliberately opaque so callers cannot accidentally recreate lookup logic. */
  readonly _canonicalMolecule: OCL.Molecule;
  readonly _inputToCanonical: readonly number[];
  readonly _representativeByAtom: readonly number[];
  readonly _codesByRepresentative: Map<number, readonly string[]>;
}

/**
 * Prepare the molecule-wide constitutional classes and canonical atom mapping used by production.
 * Plain explicit hydrogens are removed from an index-preserving copy first. Thus NMReDATA molfiles
 * and ordinary implicit-H inputs produce the same classes, representative, and canonical graph,
 * while the caller's molecule keeps its original heavy-atom indices and explicit H assignments.
 */
export function prepareProductionLookup(
  molecule: OCL.Molecule,
  maxSpheres = MAX_SPHERES
): ProductionLookupContext {
  const normalized = molecule.getCompactCopy();
  assertRelevantAtomIndexesPreserved(molecule, normalized);
  normalized.removeExplicitHydrogens();
  normalized.ensureHelperArrays(OCL.Molecule.cHelperRings);
  assertHeavyAtomIndexesPreserved(molecule, normalized);

  const constitution = normalized.getCompactCopy();
  assertRelevantAtomIndexesPreserved(normalized, constitution);
  constitution.stripStereoInformation();
  constitution.ensureHelperArrays(OCL.Molecule.cHelperSymmetrySimple);

  const canonicalOrder = canonicalAtomOrder(normalized);
  const classes = symmetryClasses(constitution);
  const representativeByAtom = Array.from({ length: normalized.getAllAtoms() }, (_, atom) => atom);
  for (const atoms of classes) {
    const representative = canonicalRepresentative(atoms, canonicalOrder.inputToCanonical);
    for (const atom of atoms) representativeByAtom[atom] = representative;
  }

  return {
    carbonClasses: classes.filter((atoms) => normalized.getAtomicNo(atoms[0]) === 6),
    protonClasses: classes.filter((atoms) => normalized.getAllHydrogens(atoms[0]) > 0),
    maxSpheres,
    _canonicalMolecule: canonicalOrder.molecule,
    _inputToCanonical: canonicalOrder.inputToCanonical,
    _representativeByAtom: representativeByAtom,
    _codesByRepresentative: new Map()
  };
}

/**
 * The single production database lookup. Every atom in a constitutional class is resolved through
 * that class's OCL-canonical representative and environment codes from the canonical molecule.
 */
export function lookupProductionEnvironment(
  database: CompiledNmrDatabase,
  context: ProductionLookupContext,
  nucleus: NmrNucleus,
  atom: number
): ProductionLookupResult {
  const representativeAtom = context._representativeByAtom[atom];
  if (representativeAtom === undefined) {
    throw new Error(`Atom ${atom} is not present in the prepared production lookup molecule.`);
  }

  let codes = context._codesByRepresentative.get(representativeAtom);
  if (!codes) {
    const canonicalAtom = context._inputToCanonical[representativeAtom];
    if (canonicalAtom === undefined) {
      throw new Error(`Atom ${representativeAtom} has no OCL canonical index.`);
    }
    codes = atomEnvironmentCodes(context._canonicalMolecule, canonicalAtom, context.maxSpheres);
    context._codesByRepresentative.set(representativeAtom, codes);
  }

  for (const code of codes) {
    const entry = database.entries[environmentKey(nucleus, code)];
    if (entry) return { representativeAtom, codes, match: { code, entry } };
  }
  return { representativeAtom, codes };
}

export function shiftFor(entry: NmrDatabaseEntry, statistic: NmrPredictionOptions["statistic"]): number {
  return statistic === "mean" ? entry.mean : entry.median;
}

function symmetryClasses(molecule: OCL.Molecule): number[][] {
  const byRank = new Map<number, number[]>();
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    // Plain H atoms have already been removed. Any remaining isotope/special H is not a host class.
    if (molecule.getAtomicNo(atom) === 1) continue;
    const rank = molecule.getSymmetryRank(atom);
    const atoms = byRank.get(rank);
    if (atoms) atoms.push(atom);
    else byRank.set(rank, [atom]);
  }
  return [...byRank.values()];
}

function canonicalAtomOrder(molecule: OCL.Molecule): {
  molecule: OCL.Molecule;
  inputToCanonical: readonly number[];
} {
  const canonizer = new OCL.Canonizer(molecule);
  const inputToCanonical = Array.from(canonizer.getGraphIndexes());
  const canonical = canonizer.getCanMolecule(true);
  canonical.ensureHelperArrays(OCL.Molecule.cHelperRings);

  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const canonicalAtom = inputToCanonical[atom];
    if (canonicalAtom === undefined || canonical.getAtomicNo(canonicalAtom) !== molecule.getAtomicNo(atom)) {
      throw new Error("OpenChemLib canonicalization did not preserve the atom mapping.");
    }
  }
  return { molecule: canonical, inputToCanonical };
}

function canonicalRepresentative(atoms: readonly number[], inputToCanonical: readonly number[]): number {
  return atoms.reduce((best, atom) =>
    inputToCanonical[atom] < inputToCanonical[best] ? atom : best
  );
}

function assertRelevantAtomIndexesPreserved(source: OCL.Molecule, copy: OCL.Molecule): void {
  if (source.getAllAtoms() !== copy.getAllAtoms() || source.getAllBonds() !== copy.getAllBonds()) {
    throw new Error("OpenChemLib molecule copy changed the atom or bond count.");
  }
  for (let atom = 0; atom < source.getAllAtoms(); atom += 1) {
    if (
      source.getAtomicNo(atom) !== copy.getAtomicNo(atom) ||
      source.getAtomCharge(atom) !== copy.getAtomCharge(atom) ||
      source.getAtomMass(atom) !== copy.getAtomMass(atom)
    ) {
      throw new Error(`OpenChemLib molecule copy changed atom index ${atom}.`);
    }
  }
}

function assertHeavyAtomIndexesPreserved(source: OCL.Molecule, normalized: OCL.Molecule): void {
  for (let atom = 0; atom < source.getAtoms(); atom += 1) {
    if (source.getAtomicNo(atom) === 1) continue;
    if (
      normalized.getAtomicNo(atom) !== source.getAtomicNo(atom) ||
      normalized.getAtomCharge(atom) !== source.getAtomCharge(atom) ||
      normalized.getAtomMass(atom) !== source.getAtomMass(atom)
    ) {
      throw new Error(`Removing explicit hydrogens changed heavy-atom index ${atom}.`);
    }
  }
}
