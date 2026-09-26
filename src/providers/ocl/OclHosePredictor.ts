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
import { MAX_SPHERES } from "./environmentCode";
import { estimateCarbonShiftWithApplicability } from "./functionalGroupFallback";
import { estimateProtonIncrement } from "./incrementEstimator";
import type { CompiledNmrDatabase, NmrDatabaseEntry, NmrDatabaseProvenance } from "./localDatabase";
import {
  lookupProductionEnvironment,
  prepareProductionLookup,
  shiftFor,
  type Match,
  type ProductionLookupContext
} from "./productionLookup";
import { buildStructureDepiction } from "./structureDepiction";
import bundledDatabase from "./nmrshiftdb2.database.json";

const SMALL_POPULATION_THRESHOLD = 3;
const LABILE_HYDROGEN_HOSTS = new Set([7, 8, 16]);

export interface OclHosePredictorOptions {
  database?: CompiledNmrDatabase;
  now?: () => string;
}

interface PredictionCounts {
  estimated: number;
  omitted: number;
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
    const lookupContext = prepareProductionLookup(molecule, maxSpheres);

    for (const nucleus of dedupeNuclei(request.nuclei)) {
      throwIfAborted(signal);
      const resonanceStart = resonances.length;
      const counts =
        nucleus === "13C"
          ? predictCarbon(
              this.database,
              molecule,
              lookupContext,
              request.options.statistic,
              resonances,
              warnings
            )
          : predictProton(this.database, molecule, lookupContext, request, resonances, warnings);
      totals.estimated += counts.estimated;
      totals.omitted += counts.omitted;
      const nucleusResonances = resonances.slice(resonanceStart);
      const specificallyWarnedMethylAtoms = warnPotentiallyDiastereotopicMethyls(
        molecule,
        nucleus,
        nucleusResonances,
        warnings
      );
      warnStereochemicallyDistinctMergedClasses(
        molecule,
        nucleus,
        nucleusResonances,
        specificallyWarnedMethylAtoms,
        warnings
      );
      if (nucleus === "1H") warnLikelySecondOrderPatterns(molecule, nucleusResonances, warnings);
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

function predictCarbon(
  database: CompiledNmrDatabase,
  molecule: OCL.Molecule,
  lookupContext: ProductionLookupContext,
  statistic: Statistic,
  resonances: NmrResonance[],
  warnings: NmrPredictionWarning[]
): PredictionCounts {
  let estimated = 0;
  let omitted = 0;

  for (const atoms of lookupContext.carbonClasses) {
    const lookup = lookupProductionEnvironment(database, lookupContext, "13C", atoms[0]);
    const representative = lookup.representativeAtom;
    const codes = lookup.codes;
    const found = lookup.match;
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
  lookupContext: ProductionLookupContext,
  request: NmrPredictionRequest,
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

  for (const atoms of lookupContext.protonClasses) {
    const lookup = lookupProductionEnvironment(database, lookupContext, "1H", atoms[0]);
    const representative = lookup.representativeAtom;
    const protonCounts = atoms.map((atom) => molecule.getAllHydrogens(atom));
    if (
      LABILE_HYDROGEN_HOSTS.has(molecule.getAtomicNo(representative)) &&
      request.options.ignoreLabileHydrogens
    ) {
      omittedLabile += protonCounts.reduce((sum, count) => sum + count, 0);
      continue;
    }
    const codes = lookup.codes;
    const found = lookup.match;
    if (found) {
      const multiplet = computeMultiplet(molecule, representative, atoms);
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
        computeMultiplet(molecule, representative, atoms)
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
  const atomsInStereogenicComponents = stereogenicComponentAtoms(molecule);

  const methylenes: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (
      atomsInStereogenicComponents.has(atom) &&
      molecule.getAtomicNo(atom) === 6 &&
      molecule.getAllHydrogens(atom) === 2
    ) {
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
): ReadonlySet<number> {
  const atomsInStereogenicComponents = stereogenicComponentAtoms(molecule);

  const emittedClassByAtom = new Map<number, number>();
  resonances.forEach((resonance, classIndex) => {
    for (const ref of resonance.atomRefs) emittedClassByAtom.set(ref.sourceAtomIndex, classIndex);
  });

  const methylAtoms = new Set<number>();
  let methylPairCount = 0;
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) !== 6 || !atomsInStereogenicComponents.has(atom)) continue;
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

  if (methylPairCount === 0) return methylAtoms;
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
  return methylAtoms;
}

/** Disclose a constitutional class whose heavy-atom members OCL identifies as diastereotopic. The
 * class remains one record: there is no defensible source for separate shifts. The legacy methyl
 * warning takes precedence for its exact atoms so downstream consumers keep that stable code
 * without receiving a duplicate general warning. */
function warnStereochemicallyDistinctMergedClasses(
  molecule: OCL.Molecule,
  nucleus: NmrNucleus,
  resonances: readonly NmrResonance[],
  specificallyWarnedMethylAtoms: ReadonlySet<number>,
  warnings: NmrPredictionWarning[]
): void {
  const diastereotopicIds = componentLocalDiastereotopicAtomIds(molecule);
  const disclosedAtoms = new Set<number>();
  let mergedClassCount = 0;

  for (const resonance of resonances) {
    const atoms = resonance.atomRefs.map((ref) => ref.sourceAtomIndex);
    if (atoms.length < 2 || new Set(atoms.map((atom) => diastereotopicIds[atom])).size < 2) continue;
    const uncoveredAtoms = atoms.filter((atom) => !specificallyWarnedMethylAtoms.has(atom));
    if (uncoveredAtoms.length === 0) continue;
    mergedClassCount += 1;
    for (const atom of uncoveredAtoms) disclosedAtoms.add(atom);
  }

  if (mergedClassCount === 0) return;
  const atomIndices = [...disclosedAtoms].sort((a, b) => a - b);
  warnings.push(
    nmrWarning(
      NmrWarningCodes.StereoNonequivalentMerged,
      `${formatAtoms(molecule, atomIndices)} are stereochemically distinct members of ${mergedClassCount} constitutionally merged ${nucleus} class(es). These atoms may give separate signals; this model reports one shift for each merged class and does not predict separate values.`,
      {
        severity: "info",
        atomIndices,
        details: { nucleus, mergedClassCount }
      }
    )
  );
}

/** OCL's molecule-wide diastereotopic IDs allow a stereocenter in one disconnected component to
 * distinguish enantiotopic atoms in another. Compute the IDs on isolated components instead, using
 * and validating OCL's explicit source-to-component atom map before returning input-indexed IDs. */
function componentLocalDiastereotopicAtomIds(molecule: OCL.Molecule): string[] {
  const atomCount = molecule.getAllAtoms();
  const componentByAtom = connectedComponentNumbers(molecule);
  const componentCount = Math.max(...componentByAtom) + 1;
  const inputIndexedIds = Array<string | undefined>(atomCount).fill(undefined);

  for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
    const includedAtoms = componentByAtom.map((component) => component === componentIndex);
    const component = new OCL.Molecule(atomCount, molecule.getAllBonds());
    const inputToComponent = Array<number>(atomCount).fill(-1);
    molecule.copyMoleculeByAtoms(component, includedAtoms, false, inputToComponent);
    assertComponentAtomMapping(molecule, component, includedAtoms, inputToComponent);

    const componentIds = component.getDiastereotopicAtomIDs();
    for (let atom = 0; atom < atomCount; atom += 1) {
      if (!includedAtoms[atom]) continue;
      const componentAtom = inputToComponent[atom];
      const id = componentIds[componentAtom];
      if (id === undefined) {
        throw new Error(`OpenChemLib did not return a diastereotopic ID for mapped atom ${atom}.`);
      }
      inputIndexedIds[atom] = id;
    }
  }

  return inputIndexedIds.map((id, atom) => {
    if (id === undefined) {
      throw new Error(`OpenChemLib component mapping did not cover input atom ${atom}.`);
    }
    return id;
  });
}

function assertComponentAtomMapping(
  source: OCL.Molecule,
  component: OCL.Molecule,
  includedAtoms: readonly boolean[],
  inputToComponent: readonly number[]
): void {
  const mappedAtoms = new Set<number>();
  for (let atom = 0; atom < source.getAllAtoms(); atom += 1) {
    const mappedAtom = inputToComponent[atom];
    if (!includedAtoms[atom]) {
      if (mappedAtom !== -1) throw new Error(`OpenChemLib unexpectedly mapped excluded atom ${atom}.`);
      continue;
    }
    if (
      mappedAtom < 0 ||
      mappedAtom >= component.getAllAtoms() ||
      mappedAtoms.has(mappedAtom) ||
      source.getAtomicNo(atom) !== component.getAtomicNo(mappedAtom) ||
      source.getAtomCharge(atom) !== component.getAtomCharge(mappedAtom) ||
      source.getAtomMass(atom) !== component.getAtomMass(mappedAtom)
    ) {
      throw new Error(`OpenChemLib component copy did not preserve input atom ${atom}.`);
    }
    mappedAtoms.add(mappedAtom);
  }
  if (mappedAtoms.size !== component.getAllAtoms()) {
    throw new Error("OpenChemLib component atom map did not match the copied atom count.");
  }
}

/** The scalar first-order display intentionally removes couplings within an emitted chemical class.
 * Symmetric substituted aromatic systems can nevertheless be strongly coupled (AA'XX'-like), so
 * explicitly disclose that the displayed pattern is not a spin analysis. */
function warnLikelySecondOrderPatterns(
  molecule: OCL.Molecule,
  resonances: readonly NmrResonance[],
  warnings: NmrPredictionWarning[]
): void {
  const disclosedAtoms = new Set<number>();
  let patternClassCount = 0;
  for (const resonance of resonances) {
    const atoms = resonance.atomRefs.map((ref) => ref.sourceAtomIndex);
    if (!isLikelySecondOrderClass(molecule, atoms)) continue;
    patternClassCount += 1;
    for (const atom of atoms) disclosedAtoms.add(atom);
  }
  if (patternClassCount === 0) return;

  const atomIndices = [...disclosedAtoms].sort((a, b) => a - b);
  warnings.push(
    nmrWarning(
      NmrWarningCodes.SecondOrderPatternLikely,
      `${formatAtoms(molecule, atomIndices)} may form a chemically equivalent but magnetically nonequivalent spin system. The reported multiplicity and J values are first-order topology estimates, not an exact pattern; a full spin analysis may be needed.`,
      {
        severity: "info",
        atomIndices,
        details: { nucleus: "1H", patternClassCount }
      }
    )
  );
}

function isLikelySecondOrderClass(molecule: OCL.Molecule, atoms: readonly number[]): boolean {
  // An isochronous set on its own is observed through its total-spin operator, so internal scalar
  // couplings cannot make its single line second order. Require a coupling that this model actually
  // estimates to a proton-bearing host outside the emitted chemical class.
  if (!atoms.some((atom) => computeMultiplet(molecule, atom, atoms).couplings.length > 0)) return false;

  if (atoms.length > 1 && atoms.every((atom) => molecule.isAromaticAtom(atom))) {
    const chemicalClass = new Set(atoms);
    const aromaticSystem = new Set<number>();
    const pending = [atoms[0]];
    aromaticSystem.add(atoms[0]);
    while (pending.length > 0) {
      const atom = pending.pop()!;
      for (let connection = 0; connection < molecule.getConnAtoms(atom); connection += 1) {
        const neighbor = molecule.getConnAtom(atom, connection);
        if (!molecule.isAromaticAtom(neighbor) || aromaticSystem.has(neighbor)) continue;
        aromaticSystem.add(neighbor);
        pending.push(neighbor);
      }
    }
    // A fully protonated homogeneous ring (benzene) is the simple Aₙ case. A repeated class in a
    // substituted/fused aromatic system is conservatively disclosed as potentially AA'XX'-like.
    if ([...aromaticSystem].some((atom) => !chemicalClass.has(atom))) return true;
  }

  return false;
}

function formatAtoms(molecule: OCL.Molecule, atoms: readonly number[]): string {
  return `Atoms ${atoms.map((atom) => `${molecule.getAtomLabel(atom)}${atom}`).join(", ")}`;
}

/** Return connected-component indexes, treating all bonds, including zero-order metal-ligand bonds,
 * as connections. This is the definition used for component-local stereochemistry throughout this
 * predictor. */
function connectedComponentNumbers(molecule: OCL.Molecule): number[] {
  const componentByAtom = Array<number>(molecule.getAllAtoms()).fill(-1);
  molecule.getFragmentNumbers(componentByAtom, false, true);
  return componentByAtom;
}

/** All atoms in connected components that contain a possible or assigned atom stereocenter. Keeping
 * this component-local prevents an unrelated chiral salt/mixture component from triggering the
 * legacy CH₂ or gem-dimethyl disclosures. */
function stereogenicComponentAtoms(molecule: OCL.Molecule): Set<number> {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  const atomCount = molecule.getAllAtoms();
  const componentByAtom = connectedComponentNumbers(molecule);
  const stereogenicComponents = new Set<number>();

  for (let atom = 0; atom < atomCount; atom += 1) {
    if (molecule.isAtomStereoCenter(atom)) stereogenicComponents.add(componentByAtom[atom]);
  }

  const atoms = new Set<number>();
  for (let atom = 0; atom < atomCount; atom += 1) {
    if (stereogenicComponents.has(componentByAtom[atom])) atoms.add(atom);
  }
  return atoms;
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

function dedupeNuclei(nuclei: readonly NmrNucleus[]): NmrNucleus[] {
  return [...new Set(nuclei)];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NmrError(NmrErrorCodes.PredictionCancelled, "Prediction was cancelled.");
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
