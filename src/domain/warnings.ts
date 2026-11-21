/**
 * Non-fatal warning codes attached to a produced {@link NmrPredictionResult}. Unlike errors, these
 * never abort prediction — they record where the fixture provider under-delivered (unmatched
 * environments, small reference populations, omitted labile protons) so the desktop can disclose it.
 */
export const NmrWarningCodes = {
  UnsupportedElement: "NMR_UNSUPPORTED_ELEMENT",
  ChargedStructure: "NMR_CHARGED_STRUCTURE",
  IsotopeNotSupported: "NMR_ISOTOPE_NOT_SUPPORTED",
  DeuteriumShiftNotModelled: "NMR_DEUTERIUM_SHIFT_NOT_MODELLED",
  CarbonDeuteriumSplittingNotModelled: "NMR_CARBON_DEUTERIUM_SPLITTING_NOT_MODELLED",
  DeuteriumCouplingNotShown: "NMR_DEUTERIUM_COUPLING_NOT_SHOWN",
  RadicalNotSupported: "NMR_RADICAL_NOT_SUPPORTED",
  LabileProtonOmitted: "NMR_LABILE_PROTON_OMITTED",
  NoFragmentMatch: "NMR_NO_FRAGMENT_MATCH",
  PhosphorusDatabaseNotInstalled: "NMR_PHOSPHORUS_DATABASE_NOT_INSTALLED",
  LowHoseSphereMatch: "NMR_LOW_HOSE_SPHERE_MATCH",
  SmallReferencePopulation: "NMR_SMALL_REFERENCE_POPULATION",
  PartialPrediction: "NMR_PARTIAL_PREDICTION",
  RuleEstimated: "NMR_RULE_ESTIMATED",
  SecondOrderPatternLikely: "NMR_SECOND_ORDER_PATTERN_LIKELY",
  StereoNonequivalentMerged: "NMR_STEREO_NONEQUIVALENT_MERGED",
  PotentiallyDiastereotopicHydrogens: "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS",
  PotentiallyDiastereotopicMethyls: "NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS",
  /** The GNN model for a nucleus is missing, failed its checksum, or failed to load: HOSE lookup used. */
  GnnModelUnavailable: "NMR_GNN_MODEL_UNAVAILABLE",
  /** GNN inference failed for this structure: HOSE lookup used. */
  GnnInferenceFailed: "NMR_GNN_INFERENCE_FAILED",
  /** The GNN declined atoms under ABSTENTION.md section 1; the message names the rules. */
  GnnDeclined: "NMR_GNN_DECLINED",
  /** |GNN − HOSE lookup| exceeds the agreement band (ABSTENTION.md section 4). */
  ModelLookupDisagreement: "NMR_MODEL_LOOKUP_DISAGREEMENT"
} as const;

export type NmrWarningCode = (typeof NmrWarningCodes)[keyof typeof NmrWarningCodes];

export type NmrWarningSeverity = "info" | "warning" | "error";

export interface NmrPredictionWarning {
  code: string;
  message: string;
  severity: NmrWarningSeverity;
  atomIndices?: readonly number[];
  details?: Readonly<Record<string, unknown>>;
}

export function nmrWarning(
  code: NmrWarningCode,
  message: string,
  options: {
    severity?: NmrWarningSeverity;
    atomIndices?: readonly number[];
    details?: Readonly<Record<string, unknown>>;
  } = {}
): NmrPredictionWarning {
  const warning: NmrPredictionWarning = {
    code,
    message,
    severity: options.severity ?? "warning"
  };
  if (options.atomIndices !== undefined) {
    warning.atomIndices = options.atomIndices;
  }
  if (options.details !== undefined) {
    warning.details = options.details;
  }
  return warning;
}
