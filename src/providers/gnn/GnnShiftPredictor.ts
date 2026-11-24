/**
 * The plugin's ¹H/¹³C predictor: the trained GNN first, the HOSE lookup as cross-check and fallback.
 * ³¹P is HOSE-only and passes through unchanged.
 *
 * For each requested ¹H/¹³C constitutional class (the same classes the HOSE engine reports):
 *
 * 1. The GNN declines the class when ABSTENTION.md rules 1-5 decline any member atom
 *    (`domainRules.assessNode`, a port of the experiment's evaluator). A declined class, and every
 *    class when the model is missing, fails its checksum, fails to load or fails at inference, shows
 *    the HOSE engine's own resonance for it, unchanged except for the label "HOSE lookup" (section 2).
 *    With no HOSE resonance either, the class gets no shift: nothing is fabricated.
 * 2. Otherwise the class shows the GNN value of its canonical representative atom, labeled
 *    "GNN prediction", with tier high/medium/low from the HOSE match's sphere and the frozen
 *    agreement band (section 3). When |GNN − HOSE| exceeds the band the GNN value is still reported,
 *    with tier low, the warning "model and reference lookup disagree", and both values (section 4).
 *
 * The HOSE engine (`OclHosePredictor`) runs unmodified on the same request. Its warnings that
 * describe a resonance the GNN replaced (thin-match notices, omissions, the rule-estimate summary) are
 * dropped or recounted, so every remaining notice describes what is shown.
 *
 * The model loads lazily on the first ¹H/¹³C prediction (see `runtime.ts`).
 *
 * ¹⁹F (CF3 only) runs its own model and its own NMRexp HOSE table (`f19/predictFluorine.ts`,
 * docs/f19-benchmark.md §5–6). A request without ¹⁹F takes exactly the ¹H/¹³C/³¹P path above; the
 * ¹⁹F model and table are never loaded for it.
 */
import type * as OCL from "openchemlib";

import type {
  NmrAtomReference,
  NmrMultiplet,
  NmrNucleus,
  NmrPredictionRequest,
  NmrPredictionResult,
  NmrPredictor,
  NmrPredictorCapabilities,
  NmrReferenceLookup,
  NmrResonance
} from "../../domain/contracts";
import { isRuleEstimated } from "../../domain/contracts";
import { NmrError, NmrErrorCodes } from "../../domain/errors";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../../domain/warnings";
import { nucleusLabel } from "../../domain/nucleusLabel";
import { normalizeStructure } from "../../application/normalizeStructure";
import { computeMultiplet } from "../ocl/coupling";
import { MAX_SPHERES } from "../ocl/environmentCode";
import { protonCount } from "../ocl/hydrogenIsotopes";
import {
  discloseResonanceLimitations,
  OclHosePredictor,
  type OclHosePredictorOptions,
  type ResonanceDisclosureState
} from "../ocl/OclHosePredictor";
import { prepareProductionLookup, type ProductionLookupContext } from "../ocl/productionLookup";
import { featurizationErrorCode } from "./canonicalDump";
import {
  assessNode,
  describeNode,
  GNN_DECLINE_RULE_DESCRIPTIONS,
  GNN_DECLINE_RULES,
  gnnDisagrees,
  gnnTier,
  type GnnDeclineRule,
  type GnnTier,
  type GnnTrainingDomain
} from "./domainRules";
import { featurizeMolecule, type GnnMoleculeFeatures } from "./featurize";
import {
  F19_AGREEMENT_BAND_PPM,
  GNN_AGREEMENT_BANDS,
  GNN_METHOD_LABEL,
  GNN_MODEL_RELEASE,
  HOSE_METHOD_LABEL,
  type GnnNucleus
} from "./modelRelease";
import { loadBundledF19Assets, predictFluorine, type F19AssetLoader } from "./f19/predictFluorine";
import { GnnModelRuntime, type GnnModelProvider, type GnnModelState } from "./runtime";
import { packGnnInputs } from "./tensors";
import { GNN_TRAINING_DOMAIN } from "./trainingDomain";

export const GNN_HOSE_BACKEND_ID = "chemdraft.gnn-hose";
/** The phrase ABSTENTION.md section 4 prescribes for a disagreement. */
export const MODEL_LOOKUP_DISAGREEMENT_PHRASE = "model and reference lookup disagree";

const LABILE_HYDROGEN_HOSTS = new Set([7, 8, 16]);

export interface GnnShiftPredictorOptions extends OclHosePredictorOptions {
  /** Model source. Default: the bundled models, loaded lazily. */
  models?: GnnModelProvider;
  /** HOSE lookup engine. Default: an `OclHosePredictor` with the same database options. */
  hose?: NmrPredictor;
  /** Training domain and agreement bands. Default: the frozen values shipped with the model. */
  domain?: GnnTrainingDomain;
  bands?: Readonly<Record<GnnNucleus, number>>;
  /**
   * Observer for the features this prediction computed (or the featurizer's error code), called once
   * per ¹H/¹³C prediction before any model runs. Used by the worker-path parity checks; it cannot
   * change the result.
   */
  onFeatures?: (outcome: { features: GnnMoleculeFeatures } | { error: string }) => void;
  /** Loader of the ¹⁹F training domain and HOSE table. Default: the bundled files, loaded lazily. */
  fluorineAssets?: F19AssetLoader;
  /** The ¹⁹F agreement band. Default: the frozen value shipped with the ¹⁹F model. */
  fluorineBand?: number;
}

/** The GNN's outcome for one constitutional class. */
interface ClassOutcome {
  nucleus: GnnNucleus;
  atoms: readonly number[];
  /** The HOSE engine's resonance for these atoms, if it produced one. */
  hose?: NmrResonance;
  /** What is shown: a GNN resonance, the labeled HOSE resonance, or nothing. */
  shipped?: NmrResonance;
  declines: readonly GnnDeclineRule[];
}

export class GnnShiftPredictor implements NmrPredictor {
  private readonly hose: NmrPredictor;
  private readonly models: GnnModelProvider;
  private readonly domain: GnnTrainingDomain;
  private readonly bands: Readonly<Record<GnnNucleus, number>>;
  private readonly onFeatures?: GnnShiftPredictorOptions["onFeatures"];
  private readonly fluorineAssets: F19AssetLoader;
  private readonly fluorineBand: number;

  constructor(options: GnnShiftPredictorOptions = {}) {
    const { models, hose, domain, bands, onFeatures, fluorineAssets, fluorineBand, ...hoseOptions } = options;
    this.onFeatures = onFeatures;
    this.fluorineAssets = fluorineAssets ?? loadBundledF19Assets;
    this.fluorineBand = fluorineBand ?? F19_AGREEMENT_BAND_PPM;
    this.hose = hose ?? new OclHosePredictor(hoseOptions);
    this.models = models ?? new GnnModelRuntime();
    this.domain = domain ?? GNN_TRAINING_DOMAIN;
    this.bands = bands ?? GNN_AGREEMENT_BANDS;
  }

  /** Never loads a model. */
  async getCapabilities(): Promise<NmrPredictorCapabilities> {
    const hose = await this.hose.getCapabilities();
    return { ...hose, id: GNN_HOSE_BACKEND_ID, execution: "wasm", nuclei: dedupeNuclei([...hose.nuclei, "19F"]) };
  }

  async predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    throwIfAborted(signal);
    if (request.nuclei.includes("19F")) return this.predictWithFluorine(request, signal);
    return this.predictHoseAndGnn(request, signal);
  }

  /**
   * ¹⁹F with any other requested nuclei. The other nuclei take the unchanged ¹H/¹³C/³¹P path; ¹⁹F is
   * predicted by `predictFluorine` and its provenance is reported beside them. For a ¹⁹F-only request
   * the backend's reference database and model fields describe the ¹⁹F table and model, as a
   * ³¹P-only result's describe the ³¹P table.
   */
  private async predictWithFluorine(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    const nuclei = dedupeNuclei(request.nuclei);
    const others = nuclei.filter((nucleus) => nucleus !== "19F");
    // With no other nucleus the HOSE engine still parses the structure, reports its structure-level
    // notices and builds the depiction; it predicts nothing.
    const base = others.length > 0
      ? await this.predictHoseAndGnn({ ...request, nuclei: others }, signal)
      : await this.hose.predict({ ...request, nuclei: [] }, signal);
    throwIfAborted(signal);

    const { molecule } = normalizeStructure(request.structure);
    const maxSpheres = Math.max(1, ...(request.options.hoseLevels.length ? request.options.hoseLevels : [MAX_SPHERES]));
    const fluorine = await predictFluorine({
      molecule,
      context: prepareProductionLookup(molecule, maxSpheres),
      models: this.models,
      loadAssets: this.fluorineAssets,
      band: this.fluorineBand,
      checkAborted: () => throwIfAborted(signal)
    });
    throwIfAborted(signal);

    const resonances = nuclei.flatMap((nucleus) =>
      nucleus === "19F" ? fluorine.resonances : base.resonances.filter((resonance) => resonance.nucleus === nucleus)
    );
    const gnnShown = fluorine.resonances.some((resonance) => resonance.method === GNN_METHOD_LABEL);
    if (others.length > 0) {
      return {
        ...base,
        backend: {
          ...base.backend,
          method: gnnShown ? "gnn" : base.backend.method,
          fluorineDatabase: fluorine.database,
          ...(fluorine.model ? { fluorineModel: fluorine.model } : {})
        },
        resonances,
        warnings: [...base.warnings, ...fluorine.warnings]
      };
    }
    const { version, ...database } = fluorine.database;
    return {
      ...base,
      backend: {
        id: GNN_HOSE_BACKEND_ID,
        version,
        method: gnnShown ? "gnn" : "hose-fragment",
        ...database,
        ...(fluorine.model ? { model: fluorine.model } : {})
      },
      resonances,
      warnings: [...base.warnings, ...fluorine.warnings]
    };
  }

  /** ¹H/¹³C (GNN first) and ³¹P (HOSE lookup). Never loads the ¹⁹F model or table. */
  private async predictHoseAndGnn(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult> {
    throwIfAborted(signal);
    const hoseResult = await this.hose.predict(request, signal);
    const nuclei = dedupeNuclei(request.nuclei);
    const gnnNuclei = nuclei.filter((nucleus): nucleus is GnnNucleus => nucleus === "1H" || nucleus === "13C");
    if (gnnNuclei.length === 0) {
      // ³¹P only: the HOSE result, unchanged apart from the method label.
      return { ...hoseResult, resonances: hoseResult.resonances.map(labelHose) };
    }

    const { molecule } = normalizeStructure(request.structure);
    let features: GnnMoleculeFeatures | undefined;
    let featureError: string | undefined;
    try {
      features = featurizeMolecule(molecule);
    } catch (error) {
      featureError = featurizationErrorCode(error);
    }
    this.onFeatures?.(features ? { features } : { error: featureError ?? "GNN_FEATURIZATION_FAILED" });
    const maxSpheres = Math.max(1, ...(request.options.hoseLevels.length ? request.options.hoseLevels : [MAX_SPHERES]));
    const context = prepareProductionLookup(molecule, maxSpheres);
    const hoseByClass = new Map(
      hoseResult.resonances.map((resonance) => [
        classKey(resonance.nucleus, resonance.atomRefs.map((ref) => ref.sourceAtomIndex)),
        resonance
      ])
    );

    const gnnWarnings: NmrPredictionWarning[] = [];
    const outcomes = new Map<GnnNucleus, ClassOutcome[]>();
    const disclosureState: ResonanceDisclosureState = { heavyAtomDiastereotopyAttempted: false };
    for (const nucleus of gnnNuclei) {
      throwIfAborted(signal);
      const classes = (nucleus === "13C" ? context.carbonClasses : context.protonClasses).filter(
        (atoms) =>
          !(nucleus === "1H" && request.options.ignoreLabileHydrogens &&
            LABILE_HYDROGEN_HOSTS.has(molecule.getAtomicNo(representativeOf(context, atoms))))
      );
      const state = await this.models.load(nucleus);
      throwIfAborted(signal);
      const nucleusOutcomes =
        await this.predictNucleus(nucleus, classes, state, features, featureError, molecule, context, request, hoseByClass, gnnWarnings);
      outcomes.set(nucleus, nucleusOutcomes);
      // The HOSE engine disclosed the limitations of the classes it showed. A class it did not show
      // and the GNN does gets the same checks here (the checks are per resonance).
      const gnnOnly = nucleusOutcomes.flatMap((outcome) => (!outcome.hose && outcome.shipped ? [outcome.shipped] : []));
      if (gnnOnly.length > 0) {
        discloseResonanceLimitations(
          molecule, nucleus, gnnOnly, gnnWarnings, request.options.ignoreLabileHydrogens, disclosureState
        );
      }
      throwIfAborted(signal);
    }

    const resonances: NmrResonance[] = [];
    for (const nucleus of nuclei) {
      if (nucleus === "31P") {
        resonances.push(...hoseResult.resonances.filter((resonance) => resonance.nucleus === "31P").map(labelHose));
      } else if (nucleus === "1H" || nucleus === "13C") {
        for (const outcome of outcomes.get(nucleus) ?? []) {
          if (outcome.shipped) resonances.push(outcome.shipped);
        }
      }
    }
    const allOutcomes = [...outcomes.values()].flat();
    const warnings = [
      ...reconcileHoseWarnings(hoseResult.warnings, hoseResult.resonances, allOutcomes, nuclei, resonances),
      ...mergeWarningsByCode(gnnWarnings, MERGED_GNN_CODES)
    ];
    const gnnShippedNuclei = gnnNuclei.filter((nucleus) =>
      resonances.some((resonance) => resonance.nucleus === nucleus && resonance.method === GNN_METHOD_LABEL)
    );
    return {
      ...hoseResult,
      backend: {
        ...hoseResult.backend,
        id: GNN_HOSE_BACKEND_ID,
        method: gnnShippedNuclei.length > 0 ? "gnn" : hoseResult.backend.method,
        ...(gnnShippedNuclei.length > 0
          ? {
              model: {
                id: GNN_MODEL_RELEASE.id,
                version: GNN_MODEL_RELEASE.version,
                nuclei: gnnShippedNuclei,
                trainingData: GNN_MODEL_RELEASE.trainingData,
                dataLicense: GNN_MODEL_RELEASE.dataLicense
              }
            }
          : {})
      },
      resonances,
      warnings
    };
  }

  private async predictNucleus(
    nucleus: GnnNucleus,
    classes: readonly (readonly number[])[],
    state: GnnModelState,
    features: GnnMoleculeFeatures | undefined,
    featureError: string | undefined,
    molecule: OCL.Molecule,
    context: ProductionLookupContext,
    request: NmrPredictionRequest,
    hoseByClass: ReadonlyMap<string, NmrResonance>,
    warnings: NmrPredictionWarning[]
  ): Promise<ClassOutcome[]> {
    const fallback = (atoms: readonly number[], declines: readonly GnnDeclineRule[] = []): ClassOutcome => {
      const hose = hoseByClass.get(classKey(nucleus, atoms));
      return {
        nucleus,
        atoms,
        hose,
        declines,
        shipped: hose ? { ...labelHose(hose), ...(declines.length ? { modelDeclines: [...declines] } : {}) } : undefined
      };
    };
    if (classes.length === 0) return [];
    if (state.status === "unavailable") {
      warnings.push(nmrWarning(
        NmrWarningCodes.GnnModelUnavailable,
        `The ${nucleusLabel(nucleus)} GNN model is unavailable (${state.reason}); ${nucleusLabel(nucleus)} shifts are HOSE lookup values. ${state.message}`,
        { details: { nucleus, reason: state.reason } }
      ));
      return classes.map((atoms) => fallback(atoms));
    }

    // Decline assessment per class: the union over its member atoms (constitutionally equivalent
    // atoms share every input the rules read, so this equals the per-atom decision).
    const nodeByAtom = new Map(features?.heavyAtomIndexMap.map((atom, node) => [atom, node]) ?? []);
    const assessments = classes.map((atoms) => {
      if (!features) return { declines: ["graph"] as GnnDeclineRule[], margin: false, node: -1 };
      const reasons = new Set<GnnDeclineRule>();
      let margin = true;
      for (const atom of atoms) {
        const node = nodeByAtom.get(atom);
        const element = node === undefined ? undefined : describeNode(features.atoms[node]).element;
        // The model predicts on heavy-atom nodes only, and ¹³C on carbon nodes.
        if (node === undefined || element === "H" || (nucleus === "13C" && element !== "C")) {
          reasons.add("graph");
          margin = false;
          continue;
        }
        const assessment = assessNode(features, node, this.domain);
        for (const rule of assessment.declines) reasons.add(rule);
        margin &&= assessment.margin;
      }
      const node = nodeByAtom.get(representativeOf(context, atoms)) ?? -1;
      return { declines: GNN_DECLINE_RULES.filter((rule) => reasons.has(rule)), margin: margin && reasons.size === 0, node };
    });

    let predictions: Float32Array | undefined;
    if (features && assessments.some((assessment) => assessment.declines.length === 0)) {
      try {
        predictions = await state.model.run({ features, tensors: packGnnInputs(features) });
      } catch (error) {
        warnings.push(nmrWarning(
          NmrWarningCodes.GnnInferenceFailed,
          `GNN inference failed for ${nucleusLabel(nucleus)}; ${nucleusLabel(nucleus)} shifts are HOSE lookup values. ${error instanceof Error ? error.message : String(error)}`,
          { details: { nucleus } }
        ));
        return classes.map((atoms) => fallback(atoms));
      }
    }

    const band = this.bands[nucleus];
    const outcomes = classes.map((atoms, index): ClassOutcome => {
      const assessment = assessments[index];
      if (assessment.declines.length > 0 || !predictions || assessment.node < 0) {
        return fallback(atoms, assessment.declines.length > 0 ? assessment.declines : ["graph"]);
      }
      const hose = hoseByClass.get(classKey(nucleus, atoms));
      const value = predictions[assessment.node];
      const reference = hoseMatch(hose);
      const lookup = reference?.deltaPpm ?? null;
      const sphere = reference?.matchedSphere ?? null;
      const tier = gnnTier(value, lookup, sphere, band, assessment.margin);
      const disagrees = gnnDisagrees(value, lookup, sphere, band);
      const shipped = gnnResonance(nucleus, atoms, value, tier, reference, disagrees, hose, molecule, context, request);
      if (disagrees && reference) {
        warnings.push(nmrWarning(
          NmrWarningCodes.ModelLookupDisagreement,
          `${nucleusLabel(nucleus)} ${nucleus === "1H" ? "host atoms" : "atoms"} ${atoms.join(", ")}: ${MODEL_LOOKUP_DISAGREEMENT_PHRASE} (GNN prediction ${shipped.deltaPpm.toFixed(2)} ppm, HOSE lookup ${reference.deltaPpm.toFixed(2)} ppm, agreement band ${band} ppm). The GNN value is shown with tier low; the values are not averaged.`,
          {
            atomIndices: [...atoms],
            details: { nucleus, gnnPpm: shipped.deltaPpm, lookupPpm: reference.deltaPpm, bandPpm: band }
          }
        ));
      }
      return { nucleus, atoms, hose, declines: [], shipped };
    });

    // One notice per distinct set of decline rules, naming the rules and the atoms.
    const byRules = new Map<string, { declines: readonly GnnDeclineRule[]; atoms: number[]; withoutShift: number[] }>();
    for (const outcome of outcomes) {
      if (outcome.declines.length === 0) continue;
      const key = outcome.declines.join(",");
      const group = byRules.get(key) ?? { declines: outcome.declines, atoms: [], withoutShift: [] };
      group.atoms.push(...outcome.atoms);
      if (!outcome.shipped) group.withoutShift.push(...outcome.atoms);
      byRules.set(key, group);
    }
    for (const { declines, atoms, withoutShift } of byRules.values()) {
      const sorted = [...atoms].sort((a, b) => a - b);
      const reasons = declines.map((rule) => GNN_DECLINE_RULE_DESCRIPTIONS[rule]).join("; ");
      const noShift = withoutShift.length
        ? ` No HOSE lookup value exists for ${withoutShift.length === sorted.length ? "them" : `atoms ${[...withoutShift].sort((a, b) => a - b).join(", ")}`}, so no shift is shown there.`
        : "";
      warnings.push(nmrWarning(
        NmrWarningCodes.GnnDeclined,
        `GNN prediction withheld for ${nucleusLabel(nucleus)} ${nucleus === "1H" ? "host atoms" : "atoms"} ${sorted.join(", ")} (zero-based): ${reasons}. The HOSE lookup value is shown instead where one exists.${noShift}`,
        {
          atomIndices: sorted,
          details: { nucleus, rules: [...declines], ...(featureError && declines.includes("graph") ? { featurizerError: featureError } : {}) }
        }
      ));
    }
    return outcomes;
  }
}

function gnnResonance(
  nucleus: GnnNucleus,
  atoms: readonly number[],
  value: number,
  tier: GnnTier,
  reference: NmrReferenceLookup | undefined,
  disagrees: boolean,
  hose: NmrResonance | undefined,
  molecule: OCL.Molecule,
  context: ProductionLookupContext,
  request: NmrPredictionRequest
): NmrResonance {
  let atomRefs: readonly NmrAtomReference[];
  let equivalentNuclei: number;
  let multiplet: NmrMultiplet | undefined;
  if (hose) {
    atomRefs = hose.atomRefs;
    equivalentNuclei = hose.equivalentNuclei ?? atoms.length;
    multiplet = hose.multiplet;
  } else if (nucleus === "13C") {
    atomRefs = atoms.map((atom) => ({ sourceAtomIndex: atom, element: "C", equivalentCount: 1 }));
    equivalentNuclei = atoms.length;
  } else {
    const counts = atoms.map((atom) => protonCount(molecule, atom));
    atomRefs = atoms.map((atom, index) => ({ sourceAtomIndex: atom, element: "H", equivalentCount: counts[index] }));
    equivalentNuclei = counts.reduce((sum, count) => sum + count, 0);
    multiplet = computeMultiplet(molecule, representativeOf(context, atoms), atoms, request.options.ignoreLabileHydrogens);
  }
  return {
    id: `${nucleus === "13C" ? "c" : "h"}-${Math.min(...atoms)}`,
    nucleus,
    source: "model",
    method: GNN_METHOD_LABEL,
    tier,
    ...(reference ? { reference } : {}),
    ...(disagrees ? { disagreesWithReference: true } : {}),
    deltaPpm: round2(value),
    atomRefs,
    equivalentNuclei,
    evidence: { method: "gnn" },
    ...(multiplet ? { multiplet } : {}),
    flags: disagrees ? ["model-lookup-disagreement"] : []
  };
}

/** A HOSE match (not a rule estimate) for the tiers and the disagreement test. */
function hoseMatch(resonance: NmrResonance | undefined): NmrReferenceLookup | undefined {
  if (!resonance || isRuleEstimated(resonance) || resonance.evidence?.method !== "hose-fragment") return undefined;
  const { matchedSphere, sampleCount, environmentCode } = resonance.evidence;
  if (matchedSphere === undefined || sampleCount === undefined) return undefined;
  return {
    method: HOSE_METHOD_LABEL,
    deltaPpm: resonance.deltaPpm,
    matchedSphere,
    sampleCount,
    ...(environmentCode ? { environmentCode } : {})
  };
}

function labelHose(resonance: NmrResonance): NmrResonance {
  return { ...resonance, method: HOSE_METHOD_LABEL };
}

/**
 * Keep the HOSE engine's notices that still describe what is shown. A notice about a resonance the
 * GNN replaced is dropped (thin-match notices, "no database match" omissions); the rule-estimate
 * summary and the omission count are recounted over what is shown. When the GNN shows nothing (model
 * unavailable, everything declined), every notice is kept exactly as the HOSE engine wrote it.
 */
function reconcileHoseWarnings(
  hoseWarnings: readonly NmrPredictionWarning[],
  hoseResonances: readonly NmrResonance[],
  outcomes: readonly ClassOutcome[],
  nuclei: readonly NmrNucleus[],
  shown: readonly NmrResonance[]
): NmrPredictionWarning[] {
  const replaced = outcomes.filter((outcome) => outcome.shipped?.method === GNN_METHOD_LABEL);
  if (replaced.length === 0) return [...hoseWarnings];
  const replacedKeys = new Set(replaced.map((outcome) => classKey(outcome.nucleus, outcome.atoms)));
  const replacedHose = hoseResonances.filter((resonance) =>
    replacedKeys.has(classKey(resonance.nucleus, resonance.atomRefs.map((ref) => ref.sourceAtomIndex)))
  );
  const thinMatchMessages = new Set(
    replacedHose.flatMap((resonance) => {
      const atoms = atomsKey(resonance.atomRefs.map((ref) => ref.sourceAtomIndex));
      const sampleCount = resonance.evidence?.sampleCount;
      return [
        `${atoms}|Only ${sampleCount} reference shift(s) for ${nucleusLabel(resonance.nucleus)} ${resonance.deltaPpm} ppm.`,
        `${atoms}|${nucleusLabel(resonance.nucleus)} ${resonance.deltaPpm} ppm matched only a 1-sphere environment; confidence is low.`
      ];
    })
  );

  const estimates = shown.filter(isRuleEstimated);
  const omittedAtoms = outcomes
    .filter((outcome) => !outcome.shipped)
    .reduce((sum, outcome) => sum + outcome.atoms.length, 0);
  const kept: NmrPredictionWarning[] = [];
  for (const warning of hoseWarnings) {
    switch (warning.code) {
      case NmrWarningCodes.SmallReferencePopulation:
      case NmrWarningCodes.LowHoseSphereMatch:
        if (thinMatchMessages.has(`${atomsKey(warning.atomIndices ?? [])}|${warning.message}`)) continue;
        break;
      case NmrWarningCodes.NoFragmentMatch: {
        const nucleus = warning.details?.nucleus;
        if ((nucleus === "1H" || nucleus === "13C") && replacedKeys.has(classKey(nucleus, warning.atomIndices ?? []))) continue;
        break;
      }
      case NmrWarningCodes.RuleEstimated:
        if (estimates.length > 0) kept.push(ruleEstimateWarning(estimates, nuclei));
        continue;
      case NmrWarningCodes.PartialPrediction:
        if (warning.details?.nucleus === "31P") break;
        if (omittedAtoms > 0) {
          kept.push(nmrWarning(
            NmrWarningCodes.PartialPrediction,
            `${omittedAtoms} unmatched atom environment(s) were omitted because no applicable rule estimate exists.`,
            { severity: "warning", details: { omittedEnvironmentCount: omittedAtoms } }
          ));
        }
        continue;
    }
    kept.push(warning);
  }
  return kept;
}

/** The HOSE engine's rule-estimate summary, recounted over the estimates still shown. */
function ruleEstimateWarning(estimates: readonly NmrResonance[], nuclei: readonly NmrNucleus[]): NmrPredictionWarning {
  const estimateAtoms = (values: readonly NmrResonance[]): number[] =>
    [...new Set(values.flatMap((resonance) => resonance.atomRefs.map((ref) => ref.sourceAtomIndex)))].sort((a, b) => a - b);
  const atomLists = nuclei.flatMap((nucleus) => {
    const atoms = estimateAtoms(estimates.filter((resonance) => resonance.nucleus === nucleus));
    return atoms.length ? [`${nucleusLabel(nucleus)} ${nucleus === "1H" ? "host atoms" : "atoms"} ${atoms.join(", ")}`] : [];
  });
  return nmrWarning(
    NmrWarningCodes.RuleEstimated,
    `${estimates.length} resonance(s) had no database match and are shown as rule estimates (est.): ${atomLists.join("; ")}. Atom indices are zero-based; ¹H indices identify the host atom.`,
    { severity: "warning", atomIndices: estimateAtoms(estimates) }
  );
}

/**
 * One entry per warning code, in first-seen order. Same-code warnings (one per atom class, or per
 * nucleus) merge: atomIndices become the sorted union, the messages are kept in full (each names its
 * own atoms), and details keep the keys all entries agree on plus an `entries` list of every
 * original details object. A code that occurs once is returned untouched.
 */
function mergeWarningsByCode(
  warnings: readonly NmrPredictionWarning[],
  codes: ReadonlySet<string>
): NmrPredictionWarning[] {
  const passthrough = warnings.filter((warning) => !codes.has(warning.code));
  const groups = new Map<string, NmrPredictionWarning[]>();
  for (const warning of warnings.filter((item) => codes.has(item.code))) {
    const group = groups.get(warning.code);
    if (group) group.push(warning);
    else groups.set(warning.code, [warning]);
  }
  const merged = [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const atoms = group.flatMap((warning) => warning.atomIndices ?? []);
    const detailList = group.flatMap((warning) => (warning.details ? [warning.details] : []));
    const shared: Record<string, unknown> = {};
    for (const key of Object.keys(detailList[0] ?? {})) {
      const value = JSON.stringify(detailList[0][key]);
      if (detailList.every((details) => key in details && JSON.stringify(details[key]) === value)) {
        shared[key] = detailList[0][key];
      }
    }
    const entry: NmrPredictionWarning = {
      code: group[0].code,
      message: [...new Set(group.map((warning) => warning.message))].join(" "),
      severity: group.some((warning) => warning.severity === "error")
        ? "error"
        : group.some((warning) => warning.severity === "warning") ? "warning" : "info"
    };
    if (atoms.length > 0) entry.atomIndices = [...new Set(atoms)].sort((a, b) => a - b);
    if (detailList.length > 0) entry.details = { ...shared, entries: detailList };
    return entry;
  });
  return [...merged, ...passthrough];
}

const MERGED_GNN_CODES: ReadonlySet<string> = new Set([
  NmrWarningCodes.ModelLookupDisagreement,
  NmrWarningCodes.GnnDeclined
]);

function representativeOf(context: ProductionLookupContext, atoms: readonly number[]): number {
  return context._representativeByAtom[atoms[0]] ?? atoms[0];
}

function classKey(nucleus: NmrNucleus, atoms: readonly number[]): string {
  return `${nucleus}:${atomsKey(atoms)}`;
}

function atomsKey(atoms: readonly number[]): string {
  return [...atoms].sort((a, b) => a - b).join(",");
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
