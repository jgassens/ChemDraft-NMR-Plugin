/**
 * The shipped GNN shift models: file identities, the frozen agreement bands, and provenance.
 *
 * Every value here is copied from the frozen experiment record (nmr-model-experiment run nmrexp-02,
 * code commit c05b91c, `freeze.json` and `tuning.json`). Nothing is tuned in the plugin. The decline
 * and tier rules that use these values live in `domainRules.ts`; they reproduce the experiment's
 * `py/abstention.py` and `py/evaluate.py` exactly (ABSTENTION.md, ABSTENTION-NOTES.md).
 *
 * A model whose bytes do not hash to the SHA-256 below is treated as unavailable, and every atom
 * falls back to the HOSE lookup (ABSTENTION.md section 2).
 */
export type GnnNucleus = "1H" | "13C";

/** Method labels carried by every ¹H/¹³C resonance (ABSTENTION.md section 5). */
export const GNN_METHOD_LABEL = "GNN prediction" as const;
export const HOSE_METHOD_LABEL = "HOSE lookup" as const;

export interface GnnModelFile {
  nucleus: GnnNucleus;
  /** File name inside `src/providers/gnn/model/`. */
  file: string;
  /** Lowercase hex SHA-256 of the exact bytes; verified on every load. */
  sha256: string;
  bytes: number;
}

export const GNN_MODEL_FILES: Readonly<Record<GnnNucleus, GnnModelFile>> = {
  "1H": {
    nucleus: "1H",
    file: "1H.fp16.onnx",
    sha256: "9220a054a8ff42fbc9fb5d7dc1ecd412ccc832ccebb261e4145df024724d67e8",
    bytes: 2325343
  },
  "13C": {
    nucleus: "13C",
    file: "13C.fp16.onnx",
    sha256: "17cfea4892b2f447a8d703095bb5025c0121a05402b735b2ad0ed2edbe95eade",
    bytes: 5128031
  }
};

/**
 * Agreement bands, in ppm, from `tuning.json` → `abstention.nuclei.<nucleus>.band` (bound by
 * `freeze.json` → `abstention_sha256`). Each is the 90th percentile (nearest rank) of |GNN − observed|
 * on non-declined validation atoms, rounded up to 0.05 ppm (¹H) or 0.5 ppm (¹³C).
 */
export const GNN_AGREEMENT_BANDS: Readonly<Record<GnnNucleus, number>> = {
  "1H": 0.65,
  "13C": 4.0
};

/** SHA-256 of `model/domain.json`, the training-partition domain stored with the model. */
export const GNN_TRAINING_DOMAIN_SHA256 = "d97f9f3fa7f594b64ec6f183ccb42e8fd9cade15b06dc0f25940a963d5582ee2";

export const GNN_MODEL_RELEASE = {
  id: "chemdraft.gnn-shift",
  /** Experiment run that produced, selected and froze the models. */
  version: "nmrexp-02",
  featureSchemaVersion: "1",
  experimentCommit: "c05b91c303d018d4083d91cee615d74943b210d4",
  /** SHA-256 of the experiment's freeze.json, which binds the bands, the domain and the selection. */
  freezeSha256: "d73a27417bda08edc7c26dda9212701940c6723f9cd493b5673729c1bc1c64c7",
  tuningSha256: "f3b51bc4409a6ecb913bedd6ab52f04dee6c647508815829800126d2c21d1950",
  abstentionSha256: "1acf1d7f368f3327e40d44a794f1f5175cf577aab603fef0497c9f2326872e89",
  abstentionMdSha256: "4b620ad5238771666186fdcdee8eca9c03d8f812faafa45fbb781b26e4c87d23",
  abstentionNotesSha256: "fa900be351fe048caf0cb45f66fa5a1a8686ad83b7fd331637f847d1ec06f2c0",
  /** The plugin commit whose featurizer computed the training features. */
  featurizerPluginCommit: "03b7771932cb2a7c846aca5655b5ed77b8ab10e8",
  openchemlib: "9.24.0",
  trainingData: "NMRShiftDB2 assignments (training partition of the scaffold split)",
  dataLicense: "nmrshiftdb2 Database License (ODbL-derived)"
} as const;

/**
 * Measured test-set accuracy of the GNN models. Shown only next to the partition and the opening it
 * was measured on (ABSTENTION.md section 5). These are figures for the raw model on every scored test
 * atom; they are not per-tier figures and are not calibrated probabilities.
 */
export const GNN_MEASURED_ACCURACY = {
  partition: "scaffold-held-out test, 10% of Murcko scaffolds",
  opening:
    "second, non-independent opening of that test set (the first opening, nmrexp-01 on 2026-11-20, was not certified as a one-shot test)",
  maePpm: { "1H": 0.277, "13C": 1.75 } as Readonly<Record<GnnNucleus, number>>
} as const;
