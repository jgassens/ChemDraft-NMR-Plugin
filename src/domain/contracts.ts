/**
 * Framework- and provider-neutral NMR prediction contracts. Every type here is JSON-serializable so
 * a result can cross the worker boundary (M7) and enter the generic analysis store (M8) unchanged —
 * no OpenChemLib instances, functions, maps, or cyclic references.
 *
 * Shapes follow PLANS.md ("Structure normalization…", "Hydrogen treatment", and the NmrPredictor
 * block). These are domain contracts, not the generic plugin API — nothing here leaks into
 * `@chemdraft/plugin-api`.
 */
import type { NmrPredictionWarning } from "./warnings";

export type NmrNucleus = "1H" | "13C" | "31P" | "19F";
/** Heuristic ¹H reference-spread threshold for flagging a broad HOSE reference distribution; not an accuracy claim. */
export const PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM = 0.5;

/** The predictor's input structure. Deliberately excludes "unknown": a selection may report unknown,
 *  but request construction must reject it (NMR_UNSUPPORTED_STRUCTURE_FORMAT) before this type. */
export interface ChemicalStructureInput {
  format: "smiles" | "molfile-v2000" | "molfile-v3000";
  value: string;
}

export interface NmrPredictorCapabilities {
  id: string;
  version: string;
  execution: "worker-js" | "wasm" | "native-service" | "remote";
  nuclei: readonly NmrNucleus[];
  supportsAtomAssignments: boolean;
  supportsUncertainty: boolean;
  supportsCouplings: boolean;
  supportsSolvent: boolean;
  supportsConformers: boolean;
  supportsStereochemistry: boolean;
}

export interface NmrPredictionOptions {
  statistic: "median" | "mean";
  hoseLevels: readonly number[];
  ignoreLabileHydrogens: boolean;
}

export interface NmrPredictionRequest {
  structure: ChemicalStructureInput;
  nuclei: readonly NmrNucleus[];
  options: NmrPredictionOptions;
  /**
   * Optional selection fingerprint carried through from the M4 selection snapshot. When present the
   * result echoes it so downstream staleness detection compares against the exact source; when
   * absent the provider derives a structure-only fingerprint. (Documented extension of the PLANS
   * request shape — see fingerprint.ts.)
   */
  sourceFingerprint?: string;
}

export interface NmrAtomReference {
  sourceAtomIndex: number;
  element: string;
  equivalentCount?: number;
  backendAtomId?: string;
  chemDraftAtomId?: string;
}

interface NmrPredictionEvidenceBase {
  matchedSphere?: number;
  sampleCount?: number;
  environmentCode?: string;
}

/** Serializable identity for a per-resonance estimate. Keeping this on the estimate (rather than
 * only on the overall backend) prevents an additive rule value from being mistaken for a HOSE
 * database value when one result contains both methods. */
export interface NmrEstimateProvenance {
  id: string;
  version: string;
  method: string;
}

export type NmrPredictionEvidence =
  | (NmrPredictionEvidenceBase & {
      method: "rule-estimated";
      /** Current producers always supply this. Optionality preserves older schema-v1 session data. */
      estimator?: NmrEstimateProvenance;
    })
  | (NmrPredictionEvidenceBase & {
      method: "fixture-fragment" | "hose-fragment" | "gnn" | "dft" | "hybrid";
      estimator?: never;
    });

export interface NmrPredictionUncertainty {
  standardDeviationPpm?: number;
  minimumPpm?: number;
  maximumPpm?: number;
}

/** One first-order scalar coupling: a typical J for its class and how many equivalent partners
 *  contribute it. J values are class-typical estimates from the bond topology, not measured. */
export interface NmrCoupling {
  jHz: number;
  partnerCount: number;
  /** Absent means ¹H (I = 1/2); ²H partners have I = 1 and give 2n+1 lines. */
  partnerNucleus?: "2H";
  kind: "vicinal" | "aromatic-ortho" | "aromatic-meta" | "aldehyde" | "other";
  /** A representative partner atom index (for future peak↔peak linking). */
  toAtomIndex?: number;
}

/** First-order multiplicity for a ¹H resonance: a label (s, d, t, q, quint, sext, sept, dd, dt, ddd,
 *  m, …) and the distinct J groups (merged by value, largest first) that produce it. */
export interface NmrMultiplet {
  label: string;
  couplings: readonly NmrCoupling[];
}

/** Method label every resonance carries (ABSTENTION.md section 5). */
export type NmrResonanceMethod = "GNN prediction" | "HOSE lookup";

/** Tier of a GNN prediction (ABSTENTION.md section 3). A name only, never a probability. */
export type NmrModelTier = "high" | "medium" | "low";

/** The HOSE lookup's match for the same atoms, shown beside a GNN prediction. */
export interface NmrReferenceLookup {
  method: "HOSE lookup";
  deltaPpm: number;
  matchedSphere: number;
  sampleCount: number;
  environmentCode?: string;
}

export interface NmrResonance {
  id: string;
  nucleus: NmrNucleus;
  /** Origin of the primary shift. Optional only for older schema-v1 session data. */
  source?: "lookup" | "rule-estimate" | "model";
  /**
   * "GNN prediction" or "HOSE lookup" (rule estimates and HOSE matches shown as the fallback are
   * both "HOSE lookup"). Optional only for session data that predates the GNN.
   */
  method?: NmrResonanceMethod;
  /**
   * Tier of a GNN prediction. ¹H/¹³C HOSE lookup values leave it absent and keep their own match tiers
   * (from `evidence`); a ¹⁹F HOSE lookup value carries its match tier here too (docs/f19-benchmark.md
   * §5: low at sphere 1 or n < 3, high at sphere ≥ 3 with n ≥ 8, medium otherwise).
   */
  tier?: NmrModelTier;
  /** For a GNN prediction: the HOSE match for the same atoms, when one exists. */
  reference?: NmrReferenceLookup;
  /** True when |GNN − HOSE| exceeds the frozen agreement band. The GNN value is reported with tier
   *  low and both values are shown; they are never averaged. */
  disagreesWithReference?: boolean;
  /** For a HOSE lookup value shown because the GNN declined these atoms: the decline rules. */
  modelDeclines?: readonly string[];
  deltaPpm: number;
  atomRefs: readonly NmrAtomReference[];
  /** Predicted count of equivalent nuclei. This is NOT an experimental integral. */
  equivalentNuclei?: number;
  uncertainty?: NmrPredictionUncertainty;
  evidence?: NmrPredictionEvidence;
  /** First-order multiplicity + estimated couplings (¹H only; absent for ¹³C or when not computed). */
  multiplet?: NmrMultiplet;
  /**
   * Independent additive-increment estimate for any HOSE match whose chemistry is supported by the
   * bounded table. `disagrees` is true when it differs from `deltaPpm` beyond max(0.4 ppm, 1.5σ).
   * `deltaPpm` stays the HOSE value; applicability controls availability while reference quality
   * controls interpretation (ADR-0024 / M25).
   */
  crossCheck?: {
    incrementPpm: number;
    disagrees: boolean;
    /** Optional so earlier schema-v1 session payloads remain readable. */
    reason?: "routine-applicability" | "weak-applicability" | "high-dispersion";
    /** Current producers always supply this. Optionality preserves older schema-v1 session data. */
    estimator?: NmrEstimateProvenance;
  };
  flags: readonly string[];
}

/** Preserve estimate labelling for saved results predating the explicit source field. */
export function isRuleEstimated(resonance: NmrResonance): boolean {
  return resonance.source === "rule-estimate" || resonance.evidence?.method === "rule-estimated";
}

export interface NmrReferenceDatabase {
  version: string;
  dataVersion?: string;
  /** Reference-database provenance, surfaced in the panel (see ADR-0014). */
  license?: string;
  attribution?: string;
  source?: string;
  /** SHA-256 of the raw corpus the active database was compiled from (M28). Lets the report layer
   * attach measured benchmark results to exactly the data they were measured on (ADR-0026). */
  dataChecksum?: string;
}

/** The trained model behind GNN predictions in a result. */
export interface NmrPredictionModel {
  id: string;
  version: string;
  /** Nuclei with at least one GNN prediction in this result. */
  nuclei: readonly NmrNucleus[];
  /** Data the weights were trained on, and that data's license. */
  trainingData: string;
  dataLicense: string;
}

export interface NmrPredictionBackend extends NmrReferenceDatabase {
  id: string;
  method: string;
  /** Separate reference provenance when phosphorus and other nuclei are requested together. */
  phosphorusDatabase?: NmrReferenceDatabase;
  /** Present when GNN predictions are part of the result. The reference database fields above
   *  then describe the HOSE lookup used as cross-check and fallback. */
  model?: NmrPredictionModel;
  /**
   * The ¹⁹F HOSE table (NMRexp-derived) when ¹⁹F was requested together with another nucleus. For a
   * ¹⁹F-only request the reference database fields above describe it instead.
   */
  fluorineDatabase?: NmrReferenceDatabase;
  /**
   * The ¹⁹F GNN model when ¹⁹F GNN predictions are part of a result that also holds another nucleus.
   * For a ¹⁹F-only result `model` describes it instead.
   */
  fluorineModel?: NmrPredictionModel;
}

export interface NmrStructureAtom {
  index: number;
  x: number;
  y: number;
  element: string;
  /** Formal charge; absent or 0 for a neutral atom. */
  charge?: number;
  /** Radical state; absent for none. */
  radical?: "singlet" | "doublet" | "triplet";
  /** Explicit isotope mass number; absent for natural abundance. Deuterium is carried as element "D". */
  isotopeMass?: number;
}

export interface NmrStructureBond {
  from: number;
  to: number;
  order: number;
}

/**
 * A chemistry-agnostic 2D depiction the desktop's interactive linked figure renders (ADR-0015).
 * Atom `index` values are the predictor's own atom indices, so they line up with resonance
 * `atomRefs.sourceAtomIndex` and the panel can cross-highlight peaks against atoms with no
 * re-derivation. Only backends that build a real molecule (the OCL predictor) emit this.
 */
export interface NmrStructureDepiction {
  atoms: readonly NmrStructureAtom[];
  bonds: readonly NmrStructureBond[];
}

export interface NmrPredictionResult {
  schemaVersion: "1";
  sourceFingerprint: string;
  backend: NmrPredictionBackend;
  resonances: readonly NmrResonance[];
  warnings: readonly NmrPredictionWarning[];
  generatedAt: string;
  /** Optional 2D structure geometry for the interactive panel figure. Absent for fixture backends. */
  depiction?: NmrStructureDepiction;
}

export interface NmrPredictor {
  getCapabilities(): NmrPredictorCapabilities | Promise<NmrPredictorCapabilities>;
  predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult>;
}

/**
 * The normalization boundary's output: a provider-ready molecule plus the atom mapping back to the
 * source ordering. The normalized OpenChemLib molecule is the internal object; this carries only
 * serializable summary data.
 */
export interface NormalizedMolecule {
  sourceFormat: "smiles" | "molfile-v2000" | "molfile-v3000";
  canonicalSmiles?: string;
  molfileV3000?: string;
  /** Atom count in the active provider's indexing. */
  providerAtomCount: number;
  /** Optional source-to-provider atom index mapping. */
  atomIndexMap?: readonly { sourceAtomIndex: number; providerAtomIndex: number }[];
  warnings: readonly NmrPredictionWarning[];
}
