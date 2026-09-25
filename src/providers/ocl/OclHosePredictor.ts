import * as OCL from "openchemlib";

import type {
  NmrEstimateProvenance,
  NmrMultiplet,
  NmrNucleus,
  NmrPredictionOptions,
  NmrPredictionRequest,
  NmrPredictionResult,
  NmrPredictor,
  NmrPredictorCapabilities,
  NmrResonance
} from "../../domain/contracts";
import { PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM } from "../../domain/contracts";
import { NmrError, NmrErrorCodes } from "../../domain/errors";
import { fingerprintStructureInput } from "../../domain/fingerprint";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../../domain/warnings";
import { normalizeStructure } from "../../application/normalizeStructure";
import { computeMultiplet } from "./coupling";
import { atomEnvironmentCodes, environmentKey, MAX_SPHERES } from "./environmentCode";
import { estimateCarbonShiftWithApplicability } from "./functionalGroupFallback";
import { estimateProtonIncrement } from "./incrementEstimator";
import type { CompiledNmrDatabase, NmrDatabaseEntry, NmrDatabaseProvenance } from "./localDatabase";
import { buildStructureDepiction } from "./structureDepiction";
import bundledDatabase from "./nmrshiftdb2.database.json";

const SMALL_POPULATION_THRESHOLD = 3;
const LABILE_HYDROGEN_HOSTS = new Set([7, 8, 16]);

export interface OclHosePredictorOptions {
  database?: CompiledNmrDatabase;
  now?: () => string;
}

export interface Match {
  code: string;
  entry: NmrDatabaseEntry;
}

interface PredictionCounts {
  estimated: number;
  omitted: number;
}

interface CanonicalAtomOrder {
  molecule: OCL.Molecule;
  inputToCanonical: readonly number[];
}

type Statistic = NmrPredictionOptions["statistic"];

/**
 * Experimentally-grounded predictor: derive local OCL environments, search the bundled HOSE database
 * deepest-first, and disclose thin matches. A rule estimate is emitted only when its estimator says
 * the chemistry is applicable; otherwise the unsupported unmatched environment is omitted with a
 * stable warning. All output remains serializable worker/store data.
 */
export class OclHosePredictor implements NmrPredictor {
  private readonly database: CompiledNmrDatabase;
  private readonly now: () => string;

  constructor(options: OclHosePredictorOptions = {}) {
    this.database = options.database ?? (bundledDatabase as unknown as CompiledNmrDatabase);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get provenance(): NmrDatabaseProvenance {
    return this.database.provenance;
  }

  getCapabilities(): NmrPredictorCapabilities {
    return {
      id: "chemdraft.ocl-hose",
      version: this.database.provenance.version,
      execution: "worker-js",
      nuclei: this.database.provenance.nuclei,
      supportsAtomAssignments: true,
      supportsUncertainty: true,
      supportsCouplings: true,
      supportsSolvent: false,
      supportsConformers: false,
      supportsStereochemistry: false
    };
  }

  async predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    throwIfAborted(signal);
    const { molecule, normalized } = normalizeStructure(request.structure);
    const maxSpheres = Math.max(
      1,
      ...(request.options.hoseLevels.length ? request.options.hoseLevels : [MAX_SPHERES])
    );

    // Normalization warnings describe chemistry the parser preserved but the predictor cannot fully
    // model. They must survive into the final result rather than being discarded at this boundary.
    const warnings: NmrPredictionWarning[] = [...normalized.warnings];
    const resonances: NmrResonance[] = [];
    const totals: PredictionCounts = { estimated: 0, omitted: 0 };
    const canonicalOrder = canonicalAtomOrder(molecule);

    for (const nucleus of dedupeNuclei(request.nuclei)) {
      throwIfAborted(signal);
      const resonanceStart = resonances.length;
      const counts =
        nucleus === "13C"
          ? predictCarbon(
              this.database,
              molecule,
              canonicalOrder,
              request.options.statistic,
              maxSpheres,
              resonances,
              warnings
            )
          : predictProton(this.database, molecule, canonicalOrder, request, maxSpheres, resonances, warnings);
      totals.estimated += counts.estimated;
      totals.omitted += counts.omitted;
      warnPotentiallyDiastereotopicMethyls(molecule, nucleus, resonances.slice(resonanceStart), warnings);
    }

    if (totals.estimated > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.RuleEstimated,
          `${totals.estimated} resonance(s) had no database match and are shown as disclosed rule estimates (low confidence).`,
          { severity: "warning" }
        )
      );
    }
    if (totals.omitted > 0) {
      warnings.push(
        nmrWarning(
          NmrWarningCodes.PartialPrediction,
          `${totals.omitted} unmatched atom environment(s) were omitted because no applicable rule estimate exists.`,
          { severity: "warning", details: { omittedEnvironmentCount: totals.omitted } }
        )
      );
    }

    return {
      schemaVersion: "1",
      sourceFingerprint: request.sourceFingerprint || fingerprintStructureInput(request.structure),
      backend: {
        id: "chemdraft.ocl-hose",
        version: this.database.provenance.version,
        dataVersion: this.database.provenance.name,
        method: "hose-fragment",
        license: this.database.provenance.license,
        attribution: this.database.provenance.attribution,
        source: this.database.provenance.source,
        ...(this.database.provenance.inputSha256 ? { dataChecksum: this.database.provenance.inputSha256 } : {})
      },
      resonances,
      warnings,
      generatedAt: this.now(),
      depiction: buildStructureDepiction(molecule)
    };
  }
}

/** The production database lookup: first (deepest) environment code with an entry wins. Exported so
 * the leakage-free benchmark scores exactly this path, never a reimplementation of it. */
export function matchEnvironment(
  database: CompiledNmrDatabase,
  nucleus: NmrNucleus,
  codes: readonly string[]
): Match | undefined {
  for (const code of codes) {
    const entry = database.entries[environmentKey(nucleus, code)];
    if (entry) return { code, entry };
  }
  return undefined;
}

function predictCarbon(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  canonicalOrder: CanonicalAtomOrder,
  statistic: Statistic,
  maxSpheres: number,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): PredictionCounts {
  let estimated = 0;
  let omitted = 0;

  for (const atoms of symmetryClasses(molecule, (atom) => molecule.getAtomicNo(atom) === 6)) {
    const representative = canonicalRepresentative(atoms, canonicalOrder.inputToCanonical);
    const codes = atomEnvironmentCodes(
      canonicalOrder.molecule,
      canonicalOrder.inputToCanonical[representative],
      maxSpheres
    );
    const found = matchEnvironment(database, "13C", codes);
    if (found) {
      resonances.push(
        buildResonance(
          "13C",
          found,
          statistic,
          atoms,
          atoms.length,
          atoms.map(() => ({ element: "C", count: 1 })),
          warnings
        )
      );
      continue;
    }

    const code = codes[codes.length - 1];
    const estimate = estimateCarbonShiftWithApplicability(molecule, representative);
    if (!estimate.applicable) {
      omitted += atoms.length;
      warnOmitted(warnings, "13C", atoms, code, estimate.reason);
      continue;
    }
    estimated += 1;
    resonances.push(
      buildEstimatedResonance(
        "13C",
        atoms,
        atoms.length,
        atoms.map(() => ({ element: "C", count: 1 })),
        estimate.ppm,
        code,
        estimate.estimator
      )
    );
  }
  return { estimated, omitted };
}

function predictProton(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  canonicalOrder: CanonicalAtomOrder,
  request: NmrPredictionRequest,
  maxSpheres: number,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): PredictionCounts {
  let estimated = 0;
  let omitted = 0;
  let omittedLabile = 0;

  const potentiallyDiastereotopic = potentiallyDiastereotopicMethyleneAtoms(molecule);
  if (potentiallyDiastereotopic.length > 0) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.PotentiallyDiastereotopicHydrogens,
        `${potentiallyDiastereotopic.length} methylene site(s) in this stereogenic structure may contain chemically nonequivalent hydrogens; when predicted, this model reports one carbon-hosted shift per site and does not predict separate diastereotopic values.`,
        {
          severity: "info",
          atomIndices: potentiallyDiastereotopic,
          details: { methyleneSiteCount: potentiallyDiastereotopic.length }
        }
      )
    );
  }

  for (const atoms of symmetryClasses(molecule, (atom) => molecule.getAllHydrogens(atom) > 0)) {
    const representative = canonicalRepresentative(atoms, canonicalOrder.inputToCanonical);
    const protonCounts = atoms.map((atom) => molecule.getAllHydrogens(atom));
    if (
      LABILE_HYDROGEN_HOSTS.has(molecule.getAtomicNo(representative)) &&
      request.options.ignoreLabileHydrogens
    ) {
      omittedLabile += protonCounts.reduce((sum, count) => sum + count, 0);
      continue;
    }
    const codes = atomEnvironmentCodes(
      canonicalOrder.molecule,
      canonicalOrder.inputToCanonical[representative],
      maxSpheres
    );
    const found = matchEnvironment(database, "1H", codes);
    if (found) {
      const multiplet = computeMultiplet(molecule, representative);
      const crossCheck = protonCrossCheck(molecule, representative, found.entry, request.options.statistic);
      resonances.push(
        buildResonance(
          "1H",
          found,
          request.options.statistic,
          atoms,
          protonCounts.reduce((sum, count) => sum + count, 0),
          protonCounts.map((count) => ({ element: "H", count })),
          warnings,
          multiplet,
          crossCheck
        )
      );
      continue;
    }

    const code = codes[codes.length - 1];
    const estimate = estimateProtonIncrement(molecule, representative);
    if (!estimate.applicable) {
      omitted += atoms.length;
      warnOmitted(warnings, "1H", atoms, code, estimate.reason);
      continue;
    }
    estimated += 1;
    resonances.push(
      buildEstimatedResonance(
        "1H",
        atoms,
        protonCounts.reduce((sum, count) => sum + count, 0),
        protonCounts.map((count) => ({ element: "H", count })),
        estimate.ppm,
        code,
        estimate.estimator,
        computeMultiplet(molecule, representative)
      )
    );
  }

  if (omittedLabile > 0) {
    warnings.push(
      nmrWarning(NmrWarningCodes.LabileProtonOmitted, `${omittedLabile} exchangeable (labile) proton(s) were omitted.`, {
        severity: "info"
      })
    );
  }

  return { estimated, omitted };
}

/** Independent additive comparison. Applicability determines whether a value is available; the
 * selected HOSE mean/median remains primary and its quality only affects interpretation. */
const CROSS_CHECK_ABS_FLOOR_PPM = 0.4;
const CROSS_CHECK_SIGMA_MULTIPLE = 1.5;
function protonCrossCheck(
  molecule: OCL.Molecule,
  atom: number,
  entry: NmrDatabaseEntry,
  statistic: Statistic
): NmrResonance["crossCheck"] | undefined {
  const estimate = estimateProtonIncrement(molecule, atom);
  if (!estimate.applicable) return undefined;
  const reason = protonCrossCheckReason(entry);
  const referencePpm = shiftFor(entry, statistic);
  const threshold = Math.max(CROSS_CHECK_ABS_FLOOR_PPM, CROSS_CHECK_SIGMA_MULTIPLE * (entry.stdev ?? 0));
  return {
    incrementPpm: estimate.ppm,
    disagrees: Math.abs(referencePpm - estimate.ppm) > threshold,
    reason,
    estimator: estimate.estimator
  };
}

function protonCrossCheckReason(
  entry: NmrDatabaseEntry
): "routine-applicability" | "weak-applicability" | "high-dispersion" {
  if (entry.sphere <= 1 || entry.n < SMALL_POPULATION_THRESHOLD) return "weak-applicability";
  if ((entry.stdev ?? 0) >= PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM) return "high-dispersion";
  return "routine-applicability";
}

/** A CH₂ group in a constitutionally stereogenic molecule may contain a diastereotopic proton pair.
 * This is a disclosure detector only: it never splits the host or fabricates two shifts. */
function potentiallyDiastereotopicMethyleneAtoms(molecule: OCL.Molecule): number[] {
  if (!hasStereoCenter(molecule)) return [];

  const methylenes: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 6 && molecule.getAllHydrogens(atom) === 2) {
      methylenes.push(atom);
    }
  }
  return methylenes;
}

/** A geminal pair of constitutionally equivalent methyls may be diastereotopic when another
 * stereocenter is present. This disclosure follows emitted classes and never splits a class. */
function warnPotentiallyDiastereotopicMethyls(
  molecule: OCL.Molecule,
  nucleus: NmrNucleus,
  resonances: readonly NmrResonance[],
  warnings: NmrPredictionWarning[]
): void {
  if (!hasStereoCenter(molecule)) return;

  const emittedClassByAtom = new Map<number, number>();
  resonances.forEach((resonance, classIndex) => {
    for (const ref of resonance.atomRefs) emittedClassByAtom.set(ref.sourceAtomIndex, classIndex);
  });

  const methylAtoms = new Set<number>();
  let methylPairCount = 0;
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) !== 6) continue;
    const methylNeighbors: number[] = [];
    for (let connection = 0; connection < molecule.getConnAtoms(atom); connection += 1) {
      const neighbor = molecule.getConnAtom(atom, connection);
      if (molecule.getAtomicNo(neighbor) === 6 && molecule.getAllHydrogens(neighbor) === 3) {
        methylNeighbors.push(neighbor);
      }
    }
    // Exactly two excludes tert-butyl groups, whose three methyls interconvert by rotation.
    if (methylNeighbors.length !== 2) continue;
    const [first, second] = methylNeighbors;
    const emittedClass = emittedClassByAtom.get(first);
    if (emittedClass === undefined || emittedClass !== emittedClassByAtom.get(second)) continue;
    methylPairCount += 1;
    methylAtoms.add(first);
    methylAtoms.add(second);
  }

  if (methylPairCount === 0) return;
  warnings.push(
    nmrWarning(
      NmrWarningCodes.PotentiallyDiastereotopicMethyls,
      "These methyl pairs may be chemically nonequivalent; this model reports one shift per pair and does not predict separate diastereotopic values.",
      {
        severity: "info",
        atomIndices: [...methylAtoms].sort((a, b) => a - b),
        details: { nucleus, methylPairCount }
      }
    )
  );
}

function hasStereoCenter(molecule: OCL.Molecule): boolean {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.isAtomStereoCenter(atom)) return true;
  }
  return false;
}

function buildResonance(
  nucleus: NmrNucleus,
  match: Match,
  statistic: Statistic,
  atoms: readonly number[],
  equivalentNuclei: number,
  refs: readonly { element: string; count: number }[],
  warnings: NmrPredictionWarning[],
  multiplet?: NmrMultiplet,
  crossCheck?: NmrResonance["crossCheck"]
): NmrResonance {
  const { entry, code } = match;
  const deltaPpm = shiftFor(entry, statistic);
  if (entry.n < SMALL_POPULATION_THRESHOLD) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.SmallReferencePopulation,
        `Only ${entry.n} reference shift(s) for ${nucleus} ${deltaPpm} ppm.`,
        { severity: "info", atomIndices: [...atoms] }
      )
    );
  }
  if (entry.sphere <= 1) {
    warnings.push(
      nmrWarning(
        NmrWarningCodes.LowHoseSphereMatch,
        `${nucleus} ${deltaPpm} ppm matched only a 1-sphere environment; confidence is low.`,
        { severity: "info", atomIndices: [...atoms] }
      )
    );
  }

  return {
    id: `${nucleus === "13C" ? "c" : "h"}-${Math.min(...atoms)}`,
    nucleus,
    deltaPpm,
    atomRefs: atoms.map((atom, index) => ({
      sourceAtomIndex: atom,
      element: refs[index].element,
      equivalentCount: refs[index].count
    })),
    equivalentNuclei,
    uncertainty: { standardDeviationPpm: entry.stdev, minimumPpm: entry.min, maximumPpm: entry.max },
    evidence: { method: "hose-fragment", matchedSphere: entry.sphere, sampleCount: entry.n, environmentCode: code },
    ...(multiplet ? { multiplet } : {}),
    ...(crossCheck ? { crossCheck } : {}),
    flags: []
  };
}

function buildEstimatedResonance(
  nucleus: NmrNucleus,
  atoms: readonly number[],
  equivalentNuclei: number,
  refs: readonly { element: string; count: number }[],
  shift: number,
  code: string,
  estimator: NmrEstimateProvenance,
  multiplet?: NmrMultiplet
): NmrResonance {
  const resonance: NmrResonance = {
    id: `${nucleus === "13C" ? "c" : "h"}-est-${Math.min(...atoms)}`,
    nucleus,
    deltaPpm: round2(shift),
    atomRefs: atoms.map((atom, index) => ({
      sourceAtomIndex: atom,
      element: refs[index].element,
      equivalentCount: refs[index].count
    })),
    equivalentNuclei,
    evidence: { method: "rule-estimated", environmentCode: code, estimator },
    flags: ["rule-estimated"]
  };
  if (multiplet) resonance.multiplet = multiplet;
  return resonance;
}

function warnOmitted(
  warnings: NmrPredictionWarning[],
  nucleus: NmrNucleus,
  atoms: readonly number[],
  code: string,
  reason: string
): void {
  warnings.push(
    nmrWarning(
      NmrWarningCodes.NoFragmentMatch,
      `No ${nucleus} database match or applicable rule estimate for atom${atoms.length === 1 ? "" : "s"} ${atoms.join(
        ", "
      )}; the resonance was omitted (${reason}).`,
      {
        severity: "warning",
        atomIndices: [...atoms],
        details: { nucleus, environmentCode: code, estimateInapplicableReason: reason }
      }
    )
  );
}

export function shiftFor(entry: NmrDatabaseEntry, statistic: Statistic): number {
  return statistic === "mean" ? entry.mean : entry.median;
}

/** Constitutionally equivalent atoms are isochronous unless a stereogenic environment makes them
 * diastereotopic. The model does not predict separate diastereotopic values, so symmetry is computed
 * after removing stereo from an index-preserving copy. The live molecule retains its stereo data for
 * warnings, fallback chemistry, multiplets, cross-checks, atomRefs, and depiction. */
function symmetryClasses(molecule: OCL.Molecule, include: (atom: number) => boolean): number[][] {
  const constitution = molecule.getCompactCopy();
  assertAtomIndexesPreserved(molecule, constitution);
  constitution.stripStereoInformation();
  constitution.ensureHelperArrays(OCL.Molecule.cHelperSymmetrySimple);
  const byRank = new Map<number, number[]>();
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (!include(atom)) continue;
    const rank = constitution.getSymmetryRank(atom);
    const atoms = byRank.get(rank);
    if (atoms) atoms.push(atom);
    else byRank.set(rank, [atom]);
  }
  return [...byRank.values()];
}

/** OCL's canonical graph order supplies one stable traversal and one stable class representative,
 * while all public atom indices remain those of the input molecule. */
function canonicalAtomOrder(molecule: OCL.Molecule): CanonicalAtomOrder {
  const canonizer = new OCL.Canonizer(molecule);
  const inputToCanonical = Array.from(canonizer.getGraphIndexes());
  const canonical = canonizer.getCanMolecule(true);
  canonical.ensureHelperArrays(OCL.Molecule.cHelperRings);

  for (let atom = 0; atom < molecule.getAtoms(); atom += 1) {
    const canonicalAtom = inputToCanonical[atom];
    if (canonicalAtom === undefined || canonical.getAtomicNo(canonicalAtom) !== molecule.getAtomicNo(atom)) {
      throw new Error("OpenChemLib canonicalization did not preserve the heavy-atom mapping.");
    }
  }
  return { molecule: canonical, inputToCanonical };
}

function canonicalRepresentative(atoms: readonly number[], inputToCanonical: readonly number[]): number {
  return atoms.reduce((best, atom) =>
    inputToCanonical[atom] < inputToCanonical[best] ? atom : best
  );
}

function assertAtomIndexesPreserved(source: OCL.Molecule, copy: OCL.Molecule): void {
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
  for (let bond = 0; bond < source.getAllBonds(); bond += 1) {
    if (
      source.getBondAtom(0, bond) !== copy.getBondAtom(0, bond) ||
      source.getBondAtom(1, bond) !== copy.getBondAtom(1, bond) ||
      source.getBondType(bond) !== copy.getBondType(bond)
    ) {
      throw new Error(`OpenChemLib molecule copy changed the atom indexing of bond ${bond}.`);
    }
  }
}

function dedupeNuclei(nuclei: readonly NmrNucleus[]): NmrNucleus[] {
  return [...new Set(nuclei)];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled.");
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
