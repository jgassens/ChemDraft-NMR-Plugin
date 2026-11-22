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

export const GNN_NUCLEI: readonly GnnNucleus[] = ["1H", "13C"];

/**
 * Every bundled GNN model the runtime can load: the ¹H/¹³C models above and the separately trained
 * ¹⁹F model (CF3 only; see `F19_MODEL_RELEASE`). The ¹⁹F model has its own training data, license,
 * band and figures, so it is not a `GnnNucleus`.
 */
export type GnnModelKey = GnnNucleus | "19F";

/** Method labels carried by every ¹H/¹³C resonance (ABSTENTION.md section 5). */
export const GNN_METHOD_LABEL = "GNN prediction" as const;
export const HOSE_METHOD_LABEL = "HOSE lookup" as const;

export interface GnnModelFile {
  nucleus: GnnModelKey;
  /** File name inside `src/providers/gnn/model/` (¹H/¹³C) or `src/providers/gnn/model-19F/` (¹⁹F). */
  file: string;
  /** Lowercase hex SHA-256 of the exact bytes; verified on every load. */
  sha256: string;
  bytes: number;
}

export const GNN_MODEL_FILES: Readonly<Record<GnnModelKey, GnnModelFile>> = {
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
  },
  "19F": {
    nucleus: "19F",
    file: "19F.fp16.onnx",
    sha256: "fc2abb4f978b873fc899b8d57834c6df4daa19a1a2b23caf25ff58e388ea31aa",
    bytes: 5128032
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

/**
 * The shipped ¹⁹F predictor (docs/f19-benchmark.md, protocol commit 7794cd9; clarifications in §10).
 *
 * Same architecture as ¹H/¹³C: the trained GNN predicts each fluorine class at its canonical
 * representative atom, and the gate HOSE table (NMRexp train + validation rows) is its cross-check and
 * fallback. What ships is exactly what the gate scored: this model with this table. Only molecules with
 * one fluorine environment whose type is CF3 are predicted (§6, §7: CF3 is the only eligible type);
 * every other fluorinated molecule gets no ¹⁹F shift and a warning.
 *
 * Every value is copied from the frozen run's records (`selection.json`, `done.json`,
 * `onnx/export.json`, `onnx/export_check.json`, `tables.json`); nothing is tuned in the plugin.
 */
export const F19_MODEL_RELEASE = {
  id: "chemdraft.gnn-shift-19F",
  /** The selected trial of the pre-registered ¹⁹F run (`selection.json` → `trial.id`). */
  version: "19F-seed-1",
  nucleus: "19F",
  featureSchemaVersion: "1",
  /** docs/f19-benchmark.md as pre-registered (the split records this commit). */
  protocolCommit: "7794cd9",
  /** Experiment repository commit that exported the ONNX graph (`onnx/export.json`). */
  experimentCommit: "87dae5be6dd09963dc6f981092f77ef7dc86cf56",
  /** The kept PyTorch checkpoint of the selected seed (`selection.json` → `best_sha256`). */
  checkpointSha256: "59923f6d9a5d8c3a661cf27aa9b499e98dda63ba6c41643f08f2ef7a326a4afc",
  selectedSeed: 1,
  /** SHA-256 of the run's `selection.json` (recorded in `onnx/export.json`). */
  selectionSha256: "6214b46aa6576004844db2dd0787d5b429c6eb9bb9c07af16006933e0893fca8",
  /** Validation MAE of the kept checkpoint, the seed-selection criterion (validation, not a test figure). */
  selectionValidationMaePpm: 4.40895414352417,
  /** Plugin commit whose featurizer and production lookup built the tables and the feature parity. */
  featurizerPluginCommit: "fe97e5bdf97964ea024f3d988c760d19246d5e01",
  openchemlib: "9.24.0",
  trainingData:
    "NMRexp ¹⁹F rows (Wang and Zhu, Zenodo doi:10.5281/zenodo.17296666), training partition of the held-out-source-file split, single fluorine environment, single peak, deduplicated and outlier-filtered",
  dataLicense: "CC BY 4.0 (NMRexp)"
} as const;

/** SHA-256 of `model-19F/domain.json`, the ¹⁹F training-partition domain stored with the model. */
export const F19_TRAINING_DOMAIN_SHA256 = "add7e563af39fa8ebb33685d02dc7d86a0c3bd784455d7af7b837196fb19f0e7";

/**
 * The shipped ¹⁹F HOSE fallback: the protocol's gate table (§5), built from NMRexp train + validation
 * rows (never in-source test rows; NMRShiftDB2 is never an input). `tables.json` → `tables.gate`.
 */
export const F19_HOSE_TABLE = {
  file: "hose-table.json",
  /** SHA-256 of the bundled file's bytes. */
  sha256: "ea9d980d8f924309afa2a7179e01f21cb576b17d56c295c423a86a89a3bce758",
  bytes: 533804,
  /**
   * SHA-256 of the compiled observations the table was built from, carried inside the table
   * (`input.sha256`). A result reports it as `dataChecksum`, and the panel shows the ¹⁹F figures only
   * when it equals this value (and the model is this release).
   */
  inputSha256: "b53fcd52693bdaeca2963e9d9cb2c31f65f1b099152f825af5fbe1cddfb6f44d",
  name: "NMRexp-derived ¹⁹F HOSE shift statistics (gate table)",
  version: "f19-gate-7794cd9",
  partitions: "NMRexp training and validation partitions of the held-out-source-file split",
  license: "CC BY 4.0 (NMRexp)"
} as const;

/**
 * The ¹⁹F agreement band in ppm (§5): the nearest-rank 90th percentile of |GNN − observed| over
 * non-declined validation observations, with the selected model and the benchmark (train-only) table,
 * rounded up to the next 0.5 ppm (§10.2). The run's frozen value; §8 records it in `freeze.json` before
 * either scored set is opened.
 */
export const F19_AGREEMENT_BAND_PPM = 5.5;

/**
 * Measured accuracy of the combined ¹⁹F predictor (GNN with the gate-table HOSE fallback) on CF3
 * molecules, for this exact release only. Each figure is shown only next to its partition. These are
 * figures of the predictor over the scored molecules; they are not per-tier figures and are not
 * calibrated probabilities.
 */
export const F19_MEASURED_ACCURACY = {
  scope: "CF3 only",
  /** Primary: the independent NMRShiftDB2 gate (never a training or table input). */
  gate:
    "NMRShiftDB2 single-environment CF3 molecules (independent gate, first opening): MAE 3.47 ppm [95% interval 2.25, 5.02], 157 molecules",
  /** Secondary: the NMRexp in-source test partition (held-out source files; §3 claims source-file,
   *  not paper-level, independence). */
  inSourceTest:
    "held-out NMRexp source files (10%, molecule-deduplicated), CF3: MAE 3.53 ppm [2.10, 5.23], 6,903 molecules"
} as const;

/**
 * The credit line for every ¹⁹F asset (model weights, training-domain counts, HOSE table), as CC BY 4.0
 * §3(a) asks: creators, title, source, license name and URI, and the changes made. Shown in the panel's
 * reference-database section for ¹⁹F results and declared in `package.json` → `dataLicenses`.
 */
export const F19_DATA_CREDIT =
  "Wang, Jun-Jie and Zhu, Rong, NMRexp (Zenodo, doi:10.5281/zenodo.17296666), licensed under CC BY 4.0 " +
  "(https://creativecommons.org/licenses/by/4.0/); dataset paper: Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., " +
  "Scientific Data 12, 1954 (2025), doi:10.1038/s41597-025-06245-5. Changes were made: the ¹⁹F rows were " +
  "filtered (single fluorine environment, single peak), deduplicated, cleaned by an outlier rule and " +
  "transformed into aggregated HOSE shift statistics and GNN model weights by ChemDraft; no structures are " +
  "included. Not endorsed by the dataset authors. NMRShiftDB2 was used only as the independent test gate; it " +
  "is not a source of the ¹⁹F model or table.";

/** Bundled ¹⁹F files, all NMRexp-derived under CC BY 4.0 (never MIT, never the NMRShiftDB2 license). */
export const F19_DATA_FILES = [
  "src/providers/gnn/model-19F/19F.fp16.onnx",
  "src/providers/gnn/model-19F/domain.json",
  "src/providers/gnn/model-19F/hose-table.json"
] as const;

export const F19_NOTICE_FILE = "src/providers/gnn/model-19F/NMREXP_LICENSE.md";

/**
 * The `package.json` → `dataLicenses` entry that declares the ¹⁹F assets (docs/f19-benchmark.md §9).
 * `src/tests/dataLicense.test.ts` requires the package metadata to carry exactly this entry.
 */
export const F19_DATA_LICENSE_ENTRY = {
  name: "NMRexp-derived ¹⁹F GNN model weights, training-domain counts and HOSE shift statistics",
  attribution: F19_DATA_CREDIT,
  url: "https://doi.org/10.5281/zenodo.17296666",
  citation:
    "Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025), doi:10.1038/s41597-025-06245-5",
  authors: "Wang, Jun-Jie; Zhu, Rong",
  doi: "10.5281/zenodo.17296666",
  path: "src/providers/gnn/model-19F",
  files: [...F19_DATA_FILES],
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  changes:
    "¹⁹F rows filtered (single fluorine environment, single peak), deduplicated, cleaned by the pre-registered outlier rule, and transformed into aggregated HOSE shift statistics and GNN model weights; no structures are included.",
  noticeFile: F19_NOTICE_FILE,
  note:
    "Trained and compiled under the pre-registered protocol docs/f19-benchmark.md (commit 7794cd9). NMRShiftDB2 was used only as the independent test gate; it is not a source of these files."
} as const;
