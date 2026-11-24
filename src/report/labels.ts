/**
 * Estimate wording shown to the user. Exported so the release label gate
 * (src/tests/releaseLabelGate.test.ts) checks the exact strings the report and the exported SVG use,
 * rather than re-typing or regex-extracting them from source. Do not reword without updating the docs.
 */

/** Inline marker on a rule-estimated shift or confidence cell (docs/gnn-model.md). */
export const RULE_ESTIMATE_MARKER = "est.";

/** Inline label on H–D multiplet descriptions, spectrum peak labels and J lists. */
export const HD_ESTIMATE_LABEL = "H–D est.";

/** The sentence fragment that marks a coupling as a typical first-order estimate. */
export const FIRST_ORDER_ESTIMATE_PHRASE = "typical first-order estimate";

/** Figure caption sentence for ¹H–¹H couplings. */
export const HH_ESTIMATE_CAPTION_SENTENCE = "¹H–¹H couplings are typical first-order estimates. ";

/** Figure caption sentence appended when the result has H–D couplings. */
export const HD_ESTIMATE_CAPTION_SENTENCE =
  " H–D couplings are typical first-order estimates; H–D multiplets use spin-1 intensities and follow the selected spectrometer field (see H–D coupling legend).";

/** Footer line of an exported stick-spectrum SVG with H–D couplings (the frequency is appended by the caller). */
export const HD_SVG_FOOTER_PREFIX = "H–D: typical first-order estimates; spin-1 intensities; ";

/** Inline suffix on one H–D coupling value in a J cell. */
export const HD_ESTIMATE_J_SUFFIX = ` (${HD_ESTIMATE_LABEL})`;
