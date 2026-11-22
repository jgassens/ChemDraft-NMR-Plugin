/**
 * @chemdraft/plugin-nmr-predictor — public surface.
 *
 * M6 ships the provider core (domain contracts, normalization, fixture provider) and the manifest.
 * The worker (M7), command + analysis wiring (M8), and declarative panel report (M9) attach later.
 */

/**
 * CLI compatibility markers: constitutional-equivalence-grouping groups constitutionally equivalent
 * nuclei; diastereotopic-disclosure identifies diastereotopic nuclei; truthful-spectrum-caption labels
 * estimated spectrum data accurately. Entries are only ever added, never removed or renamed.
 */
export const NMR_PLUGIN_CAPABILITIES = ["constitutional-equivalence-grouping", "diastereotopic-disclosure", "truthful-spectrum-caption"] as const;

export * from "./domain/contracts";
export { NmrError, NmrErrorCodes, isNmrError, type NmrErrorCode } from "./domain/errors";
export {
  NmrWarningCodes,
  nmrWarning,
  type NmrWarningCode,
  type NmrWarningSeverity,
  type NmrPredictionWarning
} from "./domain/warnings";
export {
  NmrNucleusSchema,
  ChemicalStructureInputSchema,
  NmrPredictionOptionsSchema,
  NmrPredictionRequestSchema,
  NmrPredictionResultSchema
} from "./domain/schemas";
export { createStructureSourceFingerprint, fingerprintStructureInput } from "./domain/fingerprint";

export {
  normalizeStructure,
  toChemicalStructureInput,
  type NormalizedStructure
} from "./application/normalizeStructure";

export {
  FixtureHosePredictor,
  type FixtureHosePredictorOptions
} from "./providers/fixture/FixtureHosePredictor";
export {
  FIXTURE_DATABASE,
  FIXTURE_DATA_VERSION,
  type FixtureShift,
  type FixtureEnvironmentEntry
} from "./providers/fixture/fixtureDatabase";
export {
  describeAtomEnvironment,
  collectCarbonEnvironments,
  collectProtonEnvironments,
  elementSymbol,
  type AtomEnvironment,
  type ProtonEnvironment
} from "./providers/fixture/fixtureEnvironment";

export { OclHosePredictor, type OclHosePredictorOptions } from "./providers/ocl/OclHosePredictor";
export {
  GnnShiftPredictor,
  GNN_HOSE_BACKEND_ID,
  MODEL_LOOKUP_DISAGREEMENT_PHRASE,
  type GnnShiftPredictorOptions
} from "./providers/gnn/GnnShiftPredictor";
export {
  GnnModelRuntime,
  ONNX_RUNTIME_WEB_VERSION,
  type GnnModel,
  type GnnModelInput,
  type GnnModelProvider,
  type GnnModelState,
  type GnnModelUnavailableReason
} from "./providers/gnn/runtime";
export {
  F19_AGREEMENT_BAND_PPM,
  F19_DATA_CREDIT,
  F19_DATA_LICENSE_ENTRY,
  F19_HOSE_TABLE,
  F19_MEASURED_ACCURACY,
  F19_MODEL_RELEASE,
  F19_SHIPPED_TYPES,
  GNN_AGREEMENT_BANDS,
  GNN_MEASURED_ACCURACY,
  GNN_METHOD_LABEL,
  GNN_MODEL_FILES,
  GNN_MODEL_RELEASE,
  HOSE_METHOD_LABEL,
  type GnnModelKey,
  type GnnNucleus
} from "./providers/gnn/modelRelease";
export {
  F19_MULTIPLE_ENVIRONMENTS_MESSAGE,
  f19TypeNotPredictedMessage,
  predictFluorine,
  type F19AssetLoader,
  type FluorinePredictionOutcome
} from "./providers/gnn/f19/predictFluorine";
export {
  assessNode,
  gnnTier,
  shippedDecision,
  GNN_DECLINE_RULES,
  type GnnDeclineRule,
  type GnnTier
} from "./providers/gnn/domainRules";
export {
  estimateProtonIncrement,
  PROTON_INCREMENT_ESTIMATOR_ID,
  PROTON_INCREMENT_ESTIMATOR_VERSION,
  type ProtonIncrementEstimate,
  type ProtonIncrementUnavailableReason
} from "./providers/ocl/incrementEstimator";
export { buildNmrDatabase, type BuildDatabaseOptions } from "./providers/ocl/buildDatabase";
export {
  atomEnvironmentCodes,
  environmentKey,
  sphereDepthOf,
  MAX_SPHERES
} from "./providers/ocl/environmentCode";
export {
  summarizeShifts,
  type CompiledNmrDatabase,
  type NmrDatabaseEntry,
  type NmrDatabaseProvenance
} from "./providers/ocl/localDatabase";

export {
  nmrPredictorManifest,
  nmrPredictorPluginId,
  nmrPredictCarbonCommandId,
  nmrPredictProtonCommandId,
  nmrPredictPhosphorusCommandId,
  nmrPredictFluorineCommandId,
  nmrPredictorPanelId,
  nmrPredictorAnalyzerId,
  nmrForwardPredictionAnalysisType
} from "./manifest";

export type { NmrWorkerRequest, NmrWorkerResponse, NmrWorkerErrorPayload } from "./worker/protocol";
export { createNmrWorkerHandler, type NmrWorkerHandlerDeps } from "./worker/nmrWorkerCore";
export { createNmrWorkerClient, type NmrWorkerClient } from "./worker/nmrWorkerClient";

export {
  predictSelectedStructure,
  type NmrCommandServices,
  type NmrCommandConfig
} from "./application/predictSelectedStructure";
export { determineAnalysisStatus, type NmrAnalysisStatus } from "./application/determineAnalysisStatus";
export {
  mapSelectedMoleculeToPredictionInput,
  toCommandError,
  isCancellationError,
  type CommandError,
  type MappedStructure
} from "./application/mapSelection";
export { createWorkerBackedPredictor } from "./application/workerPredictor";
export { createNmrRegistration, createNmrCommandHandlers, type NmrPluginRegistration } from "./register";
export {
  composePendingReport,
  composePredictionReport,
  composeErrorReport
} from "./report/composePredictionReport";
export { renderStickSpectrumSvg, type StickSpectrumOptions } from "./report/stickSpectrumSvg";
