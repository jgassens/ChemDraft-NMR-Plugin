import { isRuleEstimated, type NmrPredictionResult } from "../domain/contracts";
import { NmrWarningCodes } from "../domain/warnings";

export type NmrAnalysisStatus = "complete" | "partial" | "failed";

/**
 * Classify a produced result for the analysis record: nothing predicted → failed; an omitted,
 * unsupported, rule-estimated, or deuterium-approximated environment → partial; otherwise complete.
 * Cancellation never reaches here (it throws and writes no record).
 */
export function determineAnalysisStatus(result: NmrPredictionResult): NmrAnalysisStatus {
  if (result.resonances.length === 0) {
    return "failed";
  }
  const partialWarningCodes = new Set<string>([
    NmrWarningCodes.NoFragmentMatch,
    NmrWarningCodes.PartialPrediction,
    NmrWarningCodes.RuleEstimated,
    NmrWarningCodes.UnsupportedElement,
    NmrWarningCodes.ChargedStructure,
    NmrWarningCodes.IsotopeNotSupported,
    NmrWarningCodes.DeuteriumShiftNotModelled,
    NmrWarningCodes.CarbonDeuteriumSplittingNotModelled,
    NmrWarningCodes.DeuteriumCouplingNotShown,
    NmrWarningCodes.RadicalNotSupported
  ]);
  const partial =
    result.resonances.some(isRuleEstimated) ||
    result.warnings.some((warning) => partialWarningCodes.has(warning.code));
  return partial ? "partial" : "complete";
}
