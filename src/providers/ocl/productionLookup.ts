import * as OCL from "openchemlib";

import type { NmrNucleus, NmrPredictionOptions } from "../../domain/contracts";
import { atomEnvironmentCodes, environmentKey, MAX_SPHERES, protonHostAtom } from "./environmentCode";
import type { CompiledNmrDatabase, NmrDatabaseEntry } from "./localDatabase";
import { isDeuterium, protonCount } from "./hydrogenIsotopes";
import type { NmredataRecord } from "./nmredata";
import type { IndexedNmredataMolecule } from "./nmredataMolecule";

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
  phosphorusClasses: readonly (readonly number[])[];
  maxSpheres: number;
  /** Internal data is deliberately opaque so callers cannot accidentally recreate lookup logic. */
  readonly _canonicalMolecule: OCL.Molecule;
  readonly _inputToCanonical: readonly number[];
  readonly _representativeByAtom: readonly number[];
  readonly _codesByRepresentative: Map<string, readonly string[]>;
  /** Isotope-blind shift model only; the original molecule still owns counts and couplings. */
  readonly _shiftMolecule: OCL.Molecule;
  readonly _inputToShift: readonly number[];
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
  // Atom-map numbers (e.g. NMReDATA molfile indices) are bookkeeping, never part of an environment key.
  for (let atom = 0; atom < normalized.getAllAtoms(); atom += 1) normalized.setAtomMapNo(atom, 0, false);
  normalized.ensureHelperArrays(OCL.Molecule.cHelperRings);
  assertHeavyAtomIndexesPreserved(molecule, normalized);

  const constitution = normalized.getCompactCopy();
  assertRelevantAtomIndexesPreserved(normalized, constitution);
  constitution.stripStereoInformation();
  constitution.ensureHelperArrays(OCL.Molecule.cHelperSymmetrySimple);

  const canonicalOrder = canonicalAtomOrder(normalized);
  // D on any host (including O/N) is folded to implicit H only for shift lookup/rules.
  // Preserve isotope-aware constitutional classes so CH3, CHD2 and CD3 are never merged into one
  // proton population. The predictor warns
  // that this first-order lookup does not model isotope shifts.
  const deuteriums: number[] = [];
  for (let atom = 0; atom < normalized.getAllAtoms(); atom += 1) {
    if (isDeuterium(normalized, atom)) deuteriums.push(atom);
  }
  const shiftMolecule = deuteriums.length > 0 ? normalized.getCompactCopy() : normalized;
  for (const deuterium of deuteriums) {
    shiftMolecule.markAtomForDeletion(deuterium);
  }
  const inputToShift = deuteriums.length > 0
    ? shiftMolecule.deleteMarkedAtomsAndBonds() as number[] | null
    : null;
  shiftMolecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const shiftOrder = inputToShift ? canonicalAtomOrder(shiftMolecule) : canonicalOrder;
  const classes = symmetryClasses(constitution);
  const representativeByAtom = Array.from({ length: normalized.getAllAtoms() }, (_, atom) => atom);
  for (const atoms of classes) {
    const representative = canonicalRepresentative(atoms, canonicalOrder.inputToCanonical);
    for (const atom of atoms) representativeByAtom[atom] = representative;
  }

  return {
    carbonClasses: classes.filter((atoms) => normalized.getAtomicNo(atoms[0]) === 6),
    protonClasses: classes.filter((atoms) => protonCount(normalized, atoms[0]) > 0),
    phosphorusClasses: classes.filter((atoms) => normalized.getAtomicNo(atoms[0]) === 15),
    maxSpheres,
    _canonicalMolecule: shiftOrder.molecule,
    _inputToCanonical: canonicalOrder.inputToCanonical.map((_, atom) =>
      shiftOrder.inputToCanonical[inputToShift ? inputToShift[atom] : atom] ?? -1
    ),
    _representativeByAtom: representativeByAtom,
    _codesByRepresentative: new Map(),
    _shiftMolecule: inputToShift ? shiftMolecule : molecule,
    _inputToShift: inputToShift ?? Array.from({ length: molecule.getAllAtoms() }, (_, atom) => atom)
  };
}

/**
 * The input-molecule index of the canonical representative of `atom`'s stereo-free constitutional
 * symmetry class. Atoms in one class share a representative; an atom outside every class (a
 * remaining special hydrogen) is its own representative. Throws when `atom` is not an atom of the
 * molecule passed to `prepareProductionLookup`.
 */
export function productionClassRepresentative(context: ProductionLookupContext, atom: number): number {
  const representativeAtom = Number.isInteger(atom) ? context._representativeByAtom[atom] : undefined;
  if (representativeAtom === undefined) {
    throw new Error(`Atom ${atom} is not present in the prepared production lookup molecule.`);
  }
  return representativeAtom;
}

/**
 * The heavy atom whose environment keys a resonance: the atom itself for ¹³C and ³¹P, the attached
 * heavy atom for an explicit ¹H. Returns -1 when the atom cannot carry that nucleus. Indices are into the
 * molecule passed to `prepareProductionLookup`, which keeps heavy-atom indices unchanged.
 */
export function productionCodeAtom(molecule: OCL.Molecule, nucleus: NmrNucleus, atom: number): number {
  if (nucleus === "13C") return molecule.getAtomicNo(atom) === 6 ? atom : -1;
  if (nucleus === "31P") return molecule.getAtomicNo(atom) === 15 ? atom : -1;
  return molecule.getAtomicNo(atom) === 1 && !isDeuterium(molecule, atom) ? protonHostAtom(molecule, atom) : -1;
}

/** Share assignment weighting across compilation and evaluation. Observations are counted once
 * per symmetry class within each assignment. */
export function* assignedProductionAtoms(
  record: NmredataRecord,
  { molecule, oclAtomByMolfileIndex }: IndexedNmredataMolecule,
  context: ProductionLookupContext,
  nuclei?: readonly NmrNucleus[]
): Generator<{ nucleus: NmrNucleus; atom: number; shift: number }> {
  const classByAtom = {
    "13C": indexProductionClasses(context.carbonClasses),
    "1H": indexProductionClasses(context.protonClasses),
    "31P": indexProductionClasses(context.phosphorusClasses)
  };
  for (const assignment of record.assignments) {
    const { label, shift } = assignment;
    const nucleus = record.carbonLabels.has(label) ? "13C"
      : record.protonLabels.has(label) ? "1H"
      : record.phosphorusLabels.has(label) ? "31P"
      : undefined;
    if (!nucleus || (nuclei && !nuclei.includes(nucleus))) continue;

    const seen = new Set<number>();
    for (const reference of assignment.atoms) {
      const mapped = oclAtomByMolfileIndex.get(reference);
      if (mapped === undefined) continue;
      const atom = productionCodeAtom(molecule, nucleus, mapped);
      if (atom < 0) continue;
      const observation = classByAtom[nucleus].get(atom);
      if (observation === undefined || seen.has(observation)) continue;
      seen.add(observation);
      yield { nucleus, atom, shift };
    }
  }
}

function indexProductionClasses(classes: readonly (readonly number[])[]): ReadonlyMap<number, number> {
  const classByAtom = new Map<number, number>();
  for (let index = 0; index < classes.length; index += 1) {
    for (const atom of classes[index]) classByAtom.set(atom, index);
  }
  return classByAtom;
}

/**
 * The single source of production environment codes, deepest first. Database ingestion keys every
 * assigned atom with exactly these codes and lookup queries exactly these codes, so both sides see
 * the same class representative, canonical molecule and canonical index. Codes are cached per class
 * representative and code format. A phosphorus atom can also host a ¹H environment.
 */
export function productionEnvironmentCodes(
  context: ProductionLookupContext,
  nucleus: NmrNucleus,
  atom: number
): readonly string[] {
  const representativeAtom = context._representativeByAtom[atom];
  if (representativeAtom === undefined) {
    throw new Error(`Atom ${atom} is not present in the prepared production lookup molecule.`);
  }

  // The existing ³¹P table writes q0 explicitly. For ¹H and ¹³C, an omitted charge means zero.
  const includeZeroNeighborCharges = nucleus === "31P";
  const cacheKey = `${representativeAtom}:${includeZeroNeighborCharges}`;
  let codes = context._codesByRepresentative.get(cacheKey);
  if (!codes) {
    const canonicalAtom = context._inputToCanonical[representativeAtom];
    if (canonicalAtom === undefined) {
      throw new Error(`Atom ${representativeAtom} has no OCL canonical index.`);
    }
    codes = atomEnvironmentCodes(context._canonicalMolecule, canonicalAtom, context.maxSpheres, includeZeroNeighborCharges);
    context._codesByRepresentative.set(cacheKey, codes);
  }
  return codes;
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
  const codes = productionEnvironmentCodes(context, nucleus, atom);
  const representativeAtom = context._representativeByAtom[atom];
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
