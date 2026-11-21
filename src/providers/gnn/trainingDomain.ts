/**
 * The training-partition domain stored with the model (`model/domain.json`, SHA-256
 * `GNN_TRAINING_DOMAIN_SHA256`): per-element and per-(element, charge, radical) training atom counts
 * and the heavy-atom size limit that ABSTENTION.md section 1 reads. Aggregate counts derived from the
 * NMRShiftDB2 training partition; kept in its own module so only the prediction path bundles it.
 */
import type { GnnTrainingDomain } from "./domainRules";
import trainingDomain from "./model/domain.json";

export const GNN_TRAINING_DOMAIN = trainingDomain as unknown as GnnTrainingDomain;
