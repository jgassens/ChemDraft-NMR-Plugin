/**
 * ¹⁹F prediction for CF3 groups (docs/f19-benchmark.md §5 and §6), as the owner approved it after the
 * pre-registered test.
 *
 * 1. Scope (`fluorineScope`). A molecule with more than one fluorine environment, or with a single
 *    environment of any type but CF3, gets no ¹⁹F shift and a plain warning naming the reason. Neither
 *    the model nor the HOSE table is consulted for it: no guess, and no HOSE-only value.
 * 2. A single-environment CF3 molecule is predicted on its fluorine-bearing fragment. The GNN predicts
 *    the class at its canonical representative atom; it declines the class when the §5 decline rules
 *    (`domainRules.assessNode`, with the ¹⁹F model's own training domain) decline any member atom.
 * 3. Fallback (§5): a declined class, or the class when the model is missing, fails its checksum, fails
 *    to load or fails at inference, takes the gate table's HOSE match with its `benchmarkTier` tier,
 *    labeled "HOSE lookup"; with no match it gets no shift. Nothing is ever averaged.
 * 4. Tiers for a GNN value (§5): with a HOSE match, |GNN − HOSE| ≤ band gives high at sphere 3–4 and
 *    medium at sphere 1–2; above the band the GNN value is kept with tier low, the warning "model and
 *    reference lookup disagree" and both values. Without a match: medium when every member atom and
 *    its neighbors have ≥ 500 training atoms of their (element, charge, radical) state, else low.
 *
 * The model and the table load lazily: only a CF3 molecule triggers either.
 */
import type * as OCL from "openchemlib";

import type { NmrPredictionModel, NmrReferenceDatabase, NmrResonance } from "../../../domain/contracts";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../../../domain/warnings";
import { nucleusLabel } from "../../../domain/nucleusLabel";
import { prepareProductionLookup, productionClassRepresentative, type ProductionLookupContext } from "../../ocl/productionLookup";
import {
  assessNode,
  describeNode,
  GNN_DECLINE_RULE_DESCRIPTIONS,
  GNN_DECLINE_RULES,
  gnnDisagrees,
  gnnTier,
  type GnnDeclineRule
} from "../domainRules";
import { featurizeMolecule, type GnnMoleculeFeatures } from "../featurize";
import {
  F19_AGREEMENT_BAND_PPM,
  F19_DATA_CREDIT,
  F19_HOSE_TABLE,
  F19_MODEL_RELEASE,
  GNN_METHOD_LABEL,
  HOSE_METHOD_LABEL
} from "../modelRelease";
import type { GnnModelProvider } from "../runtime";
import { packGnnInputs } from "../tensors";
import type { F19Assets } from "./assets";
import { fluorineFragment, fluorineScope, type FluorineFragment } from "./fluorineScope";
import { lookupF19Hose, type F19HoseMatch } from "./hoseTable";

const F19 = "19F" as const;
const F19_LABEL = nucleusLabel(F19);

/** The phrase docs/f19-benchmark.md §5 prescribes for a disagreement (same as ¹H/¹³C). */
const DISAGREEMENT_PHRASE = "model and reference lookup disagree";

/** The two plain decline warnings of this version (docs/f19-benchmark.md §6). */
export const F19_MULTIPLE_ENVIRONMENTS_MESSAGE =
  `${F19_LABEL} prediction is limited to molecules with one fluorine environment in this version.`;
export function f19TypeNotPredictedMessage(type: string): string {
  return `${F19_LABEL} prediction covers CF3 groups only in this version; ${type} is not predicted.`;
}

/** Loads the ¹⁹F training domain and gate table (a dynamic import by default). */
export type F19AssetLoader = () => Promise<F19Assets>;

export const loadBundledF19Assets: F19AssetLoader = async () => (await import("./assets")).F19_ASSETS;

export interface FluorinePredictionOptions {
  /** The normalized input molecule and the production lookup prepared on it. */
  molecule: OCL.Molecule;
  context: ProductionLookupContext;
  models: GnnModelProvider;
  loadAssets: F19AssetLoader;
  band?: number;
  /** Called between asynchronous steps; throws to cancel. */
  checkAborted?: () => void;
}

export interface FluorinePredictionOutcome {
  resonances: NmrResonance[];
  warnings: NmrPredictionWarning[];
  /** The ¹⁹F table's provenance; `dataChecksum` is present when the table itself was loaded. */
  database: NmrReferenceDatabase;
  /** The ¹⁹F model, present when a GNN prediction is shown. */
  model?: NmrPredictionModel;
}

/** Static provenance of the ¹⁹F HOSE table, as shown in the panel's reference database section. */
export function f19ReferenceDatabase(dataChecksum?: string): NmrReferenceDatabase {
  return {
    version: F19_HOSE_TABLE.version,
    dataVersion: F19_HOSE_TABLE.name,
    license: F19_HOSE_TABLE.license,
    attribution: F19_DATA_CREDIT,
    source: "https://doi.org/10.5281/zenodo.17296666",
    ...(dataChecksum ? { dataChecksum } : {})
  };
}

export function f19PredictionModel(): NmrPredictionModel {
  return {
    id: F19_MODEL_RELEASE.id,
    version: F19_MODEL_RELEASE.version,
    nuclei: [F19],
    trainingData: F19_MODEL_RELEASE.trainingData,
    dataLicense: F19_MODEL_RELEASE.dataLicense
  };
}

/** Run the ¹⁹F predictor on one molecule. Never throws for chemistry; cancellation propagates. */
export async function predictFluorine(options: FluorinePredictionOptions): Promise<FluorinePredictionOutcome> {
  const { molecule, context, models, loadAssets } = options;
  const band = options.band ?? F19_AGREEMENT_BAND_PPM;
  const checkAborted = options.checkAborted ?? (() => undefined);
  const warnings: NmrPredictionWarning[] = [];
  const declined = (): FluorinePredictionOutcome => ({ resonances: [], warnings, database: f19ReferenceDatabase() });

  const scope = fluorineScope(molecule, context);
  switch (scope.kind) {
    case "none":
      return declined();
    case "multiple-environments":
      warnings.push(nmrWarning(NmrWarningCodes.FluorineMultipleEnvironments, F19_MULTIPLE_ENVIRONMENTS_MESSAGE, {
        atomIndices: scope.fluorines,
        details: { nucleus: F19, environments: scope.environments }
      }));
      return declined();
    case "multiple-fragments":
      warnings.push(nmrWarning(
        NmrWarningCodes.FluorineMultipleEnvironments,
        `${F19_MULTIPLE_ENVIRONMENTS_MESSAGE.slice(0, -1)}; here the fluorine atoms are in ${scope.fragments} separate fragments, which this version does not treat as one environment.`,
        { atomIndices: scope.fluorines, details: { nucleus: F19, fragments: scope.fragments } }
      ));
      return declined();
    case "type-not-predicted":
      warnings.push(nmrWarning(NmrWarningCodes.FluorineTypeNotPredicted, f19TypeNotPredictedMessage(scope.type), {
        atomIndices: scope.fluorines,
        details: { nucleus: F19, fluorineType: scope.type }
      }));
      return declined();
    case "cf3":
      break;
  }

  const atoms = scope.fluorines;
  let assets: F19Assets;
  try {
    assets = await loadAssets();
  } catch (error) {
    checkAborted();
    warnings.push(nmrWarning(
      NmrWarningCodes.GnnModelUnavailable,
      `The ${F19_LABEL} model data could not be loaded, so no ${F19_LABEL} shift is shown. ${error instanceof Error ? error.message : String(error)}`,
      { atomIndices: atoms, details: { nucleus: F19, reason: "load-failed" } }
    ));
    // The gate table is unreadable too, so no HOSE value can stand in: the CF3 group has no shift. The
    // analysis status counts GnnModelUnavailable alone as complete, so say that the result is partial.
    warnings.push(nmrWarning(
      NmrWarningCodes.PartialPrediction,
      `No ${F19_LABEL} shift was predicted for atoms ${atoms.join(", ")} (zero-based) because the ${F19_LABEL} data could not be loaded.`,
      { atomIndices: atoms, details: { nucleus: F19, reason: "load-failed" } }
    ));
    return declined();
  }
  checkAborted();
  const database = f19ReferenceDatabase(assets.table.input?.sha256);

  // §2.2: the molecule is the fluorine-bearing fragment. With a single fragment this is the input
  // molecule itself and the prepared context is reused.
  let fragment: FluorineFragment | undefined;
  let fragmentContext: ProductionLookupContext | undefined;
  try {
    fragment = fluorineFragment(molecule, atoms);
    fragmentContext = fragment.molecule === molecule ? context : prepareProductionLookup(fragment.molecule, context.maxSpheres);
  } catch {
    fragment = undefined;
  }

  // The HOSE match, from the input's own graph when the fragment could not be cut (environment codes
  // reach at most four bonds, so they never see another fragment).
  const hose = fragment && fragmentContext
    ? lookupF19Hose(assets.table, fragmentContext, fragment.fromInput[atoms[0]])
    : lookupF19Hose(assets.table, context, atoms[0]);

  const fallback = (declines: readonly GnnDeclineRule[]): FluorinePredictionOutcome => {
    if (declines.length > 0) {
      const reasons = declines.map((rule) => GNN_DECLINE_RULE_DESCRIPTIONS[rule]).join("; ");
      warnings.push(nmrWarning(
        NmrWarningCodes.GnnDeclined,
        `GNN prediction withheld for ${F19_LABEL} atoms ${atoms.join(", ")} (zero-based): ${reasons}. The HOSE lookup value is shown instead where one exists.${hose ? "" : " No HOSE lookup value exists for them, so no shift is shown there."}`,
        { atomIndices: atoms, details: { nucleus: F19, rules: [...declines] } }
      ));
    }
    if (!hose) {
      warnings.push(nmrWarning(
        NmrWarningCodes.NoFragmentMatch,
        `No ${F19_LABEL} HOSE lookup match for atoms ${atoms.join(", ")}; no ${F19_LABEL} shift is shown.`,
        { atomIndices: atoms, details: { nucleus: F19 } }
      ));
      return { resonances: [], warnings, database };
    }
    if (hose.sphere <= 1) {
      warnings.push(nmrWarning(
        NmrWarningCodes.LowHoseSphereMatch,
        `${F19_LABEL} ${hose.deltaPpm} ppm matched only a 1-sphere environment; confidence is low.`,
        { severity: "info", atomIndices: atoms }
      ));
    }
    return { resonances: [hoseResonance(atoms, hose, declines)], warnings, database };
  };

  // What happens to the class when the model cannot give a value: the HOSE value, or nothing. The
  // warning says which, so it never implies a value that is not shown.
  const fallbackOutcome = hose
    ? `${F19_LABEL} shifts are HOSE lookup values.`
    : `no HOSE lookup value exists for these atoms, so no ${F19_LABEL} shift is shown.`;

  // Decline assessment over every member atom of the class (§5, rules 1–5).
  let features: GnnMoleculeFeatures | undefined;
  if (fragment && fragmentContext) {
    try {
      features = featurizeMolecule(fragment.molecule);
    } catch {
      features = undefined;
    }
  }
  if (!fragment || !fragmentContext || !features) return fallback(["graph"]);
  const nodeByAtom = new Map(features.heavyAtomIndexMap.map((atom, node) => [atom, node]));
  const reasons = new Set<GnnDeclineRule>();
  let margin = true;
  for (const atom of atoms) {
    const node = nodeByAtom.get(fragment.fromInput[atom]);
    if (node === undefined || describeNode(features.atoms[node]).element !== "F") {
      reasons.add("graph");
      margin = false;
      continue;
    }
    const assessment = assessNode(features, node, assets.domain);
    for (const rule of assessment.declines) reasons.add(rule);
    margin &&= assessment.margin;
  }
  const representativeNode = nodeByAtom.get(productionClassRepresentative(fragmentContext, fragment.fromInput[atoms[0]]));
  if (representativeNode === undefined) reasons.add("graph");
  const declines = GNN_DECLINE_RULES.filter((rule) => reasons.has(rule));
  if (declines.length > 0 || representativeNode === undefined) return fallback(declines);

  // The model, and with it ONNX Runtime, is requested only now that the domain assessment passed.
  const state = await models.load(F19);
  checkAborted();
  if (state.status === "unavailable") {
    warnings.push(nmrWarning(
      NmrWarningCodes.GnnModelUnavailable,
      `The ${F19_LABEL} GNN model is unavailable (${state.reason}); ${fallbackOutcome} ${state.message}`,
      { details: { nucleus: F19, reason: state.reason } }
    ));
    return fallback([]);
  }

  let predictions: Float32Array;
  try {
    predictions = await state.model.run({ features, tensors: packGnnInputs(features) });
  } catch (error) {
    checkAborted();
    warnings.push(nmrWarning(
      NmrWarningCodes.GnnInferenceFailed,
      `GNN inference failed for ${F19_LABEL}; ${fallbackOutcome} ${error instanceof Error ? error.message : String(error)}`,
      { details: { nucleus: F19 } }
    ));
    return fallback([]);
  }
  checkAborted();

  const value = predictions[representativeNode];
  if (!Number.isFinite(value)) return fallback(["graph"]);
  const lookup = hose?.deltaPpm ?? null;
  const sphere = hose?.sphere ?? null;
  const tier = gnnTier(value, lookup, sphere, band, margin && reasons.size === 0);
  const disagrees = gnnDisagrees(value, lookup, sphere, band);
  const resonance = gnnResonance(atoms, value, tier, hose, disagrees);
  if (disagrees && hose) {
    warnings.push(nmrWarning(
      NmrWarningCodes.ModelLookupDisagreement,
      `${F19_LABEL} atoms ${atoms.join(", ")}: ${DISAGREEMENT_PHRASE} (GNN prediction ${resonance.deltaPpm.toFixed(2)} ppm, HOSE lookup ${hose.deltaPpm.toFixed(2)} ppm, agreement band ${band} ppm). The GNN value is shown with tier low; the values are not averaged.`,
      { atomIndices: atoms, details: { nucleus: F19, gnnPpm: resonance.deltaPpm, lookupPpm: hose.deltaPpm, bandPpm: band } }
    ));
  }
  return { resonances: [resonance], warnings, database, model: f19PredictionModel() };
}

function atomRefs(atoms: readonly number[]): NmrResonance["atomRefs"] {
  return atoms.map((atom) => ({ sourceAtomIndex: atom, element: "F", equivalentCount: 1 }));
}

function gnnResonance(
  atoms: readonly number[],
  value: number,
  tier: NmrResonance["tier"],
  hose: F19HoseMatch | undefined,
  disagrees: boolean
): NmrResonance {
  return {
    id: `f-${Math.min(...atoms)}`,
    nucleus: F19,
    source: "model",
    method: GNN_METHOD_LABEL,
    tier,
    ...(hose
      ? {
          reference: {
            method: HOSE_METHOD_LABEL,
            deltaPpm: hose.deltaPpm,
            matchedSphere: hose.sphere,
            sampleCount: hose.sampleCount,
            environmentCode: hose.environmentCode
          }
        }
      : {}),
    ...(disagrees ? { disagreesWithReference: true } : {}),
    deltaPpm: Math.round(value * 100) / 100,
    atomRefs: atomRefs(atoms),
    equivalentNuclei: atoms.length,
    evidence: { method: "gnn" },
    flags: disagrees ? ["model-lookup-disagreement"] : []
  };
}

function hoseResonance(atoms: readonly number[], hose: F19HoseMatch, declines: readonly GnnDeclineRule[]): NmrResonance {
  return {
    id: `f-${Math.min(...atoms)}`,
    nucleus: F19,
    source: "lookup",
    method: HOSE_METHOD_LABEL,
    tier: hose.tier,
    ...(declines.length ? { modelDeclines: [...declines] } : {}),
    deltaPpm: hose.deltaPpm,
    atomRefs: atomRefs(atoms),
    equivalentNuclei: atoms.length,
    evidence: {
      method: "hose-fragment",
      matchedSphere: hose.sphere,
      sampleCount: hose.sampleCount,
      environmentCode: hose.environmentCode
    },
    flags: []
  };
}
