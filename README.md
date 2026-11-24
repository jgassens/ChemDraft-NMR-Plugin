# @chemdraft/plugin-nmr-predictor

Standalone repository for ChemDraft's first-party **NMR shift predictor** plugin.
Select a structure and use the **Analyze** menu to see a predicted ¹³C, ¹H
(experimental), ³¹P, or ¹⁹F (CF3 only) stick spectrum and shift table. The host stores predictions
and flags them as stale when the structure changes.

¹H and ¹³C shifts come from a bundled **graph neural network (GNN)**, with the HOSE
lookup over NMRShiftDB2 statistics as cross-check and fallback; ³¹P shifts come
from the HOSE lookup alone. ¹⁹F shifts are given for **CF3 only**: a GNN trained on
NMRexp, with an NMRexp HOSE table as cross-check and fallback. Every shift is labeled
**GNN prediction** or **HOSE lookup**. See [GNN shift predictor](docs/gnn-model.md).

This repo builds the **installable plugin package** — the `nmr-predictor-<version>.zip`
a ChemDraft host downloads and installs (ADR-0029/M35). It compiles only against
the vendored ChemDraft plugin SDK; no monorepo is required.

## Download and install

Download the current `nmr-predictor-<version>.zip` from the
[latest GitHub release](https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/latest).
Do not unzip it.

In the ChemDraft desktop app:

1. Choose **Plugins → Add or Remove Plugins…**.
2. Select **Add plugin from package…** and choose the downloaded ZIP.
3. Review the plugin identity and declared permissions, then select **Install**.
   Besides selection, analysis and UI access, the plugin declares `model.load`:
   it loads the GNN model files bundled in the package. It downloads nothing and
   needs no network access.
4. Select a structure and use the **Analyze** menu to predict ¹³C, ¹H
   (experimental), ³¹P, or ¹⁹F (CF3 only) shifts.

Each release also includes a `.zip.sha256` sidecar for verifying the downloaded
package. The plugin requires ChemDraft 1.2 or later, with plugin API
`^0.1.25`.

## Provenance

The M6–M36 development history is preserved in this repository. The plugin was
extracted from the ChemDraft monorepo at `125aebeb`; commit `37d61e6` then made
it a self-contained repository with vendored SDK archives and standalone release
packaging. ChemDraft intentionally loads it as an installable plugin rather than
bundling its implementation in the core application.

## The SDK is vendored (ADR-0031)

The plugin depends on the ChemDraft plugin SDK through **vendored tarballs**, not
an npm registry:

- `@chemdraft/plugin-api` → `file:./vendor/chemdraft-plugin-api-0.1.0.tgz`
  (runtime dependency: manifest schema/validation, permission model, worker
  runtime `runPluginWorker`, packaged-manifest helpers). These are the
  self-contained SDK builds (chem-core bundled in; only `zod` as an external dep).
- `@chemdraft/plugin-host` → `file:./vendor/chemdraft-plugin-host-0.1.0.tgz`
  (devDependency; the host contract the plugin's tests exercise).

Nothing is published to or fetched from a private registry. To move the plugin to
a newer SDK, drop the new tarballs into `vendor/` and update the `file:` versions.

## Developer setup

```bash
npm install
```

This resolves the two vendored SDK tarballs from `vendor/` plus `openchemlib`,
`onnxruntime-web` (pinned to 1.22.0) and `zod` from the public npm registry.

## Build the release package

```bash
npm run package
```

This runs the packaging tool in `tools/plugin-package/package.ts`, which:

1. enforces the fail-closed distribution gates (SDK boundary clean — the runtime
   source imports only `@chemdraft/plugin-api`; Git tree clean & committed so the
   recorded provenance commit describes the shipped bytes; a `LICENSE` is present);
2. bundles `src/workerEntry.ts` with Vite (`worker.format: "es"`, relative
   `base: "./"`) so the package is relocatable and its nested OpenChemLib worker
   resolves against its own co-located files;
3. writes `manifest.json` (identity, permissions, contributions, built `entry.js`
   filename, and provenance) and stages `LICENSE`, package metadata, and the
   declared data notices;
4. emits `dist/plugin-packages/nmr-predictor-<version>.zip` and a
   `.zip.sha256` sidecar (integrity only — never a trust gate, ADR-0029 §4).

Because the Git-clean gate must see a committed, clean tree, run `npm run package`
**after** the initial commit; `dist/` is git-ignored, so building never dirties the
tree.

## Providers

- **GNN-first (default)** — for ¹H and ¹³C, a per-atom graph neural network trained
  on NMRShiftDB2 assignments runs locally through ONNX Runtime Web (WebAssembly, one
  thread) on the plugin's own schema-1 features. The model files ship inside the
  package (about 19 MB with the runtime), load only on the first ¹H/¹³C prediction,
  and must match their frozen SHA-256 values. The GNN declines atoms outside its
  training domain (rare elements, rare charge or radical states, isotope labels other
  than ²H/¹³C, molecules above 103 heavy atoms, unsupported structures); those atoms,
  and every atom when the model is unavailable, show the OCL-native HOSE lookup below,
  labeled **HOSE lookup**. Each GNN prediction carries a tier: **high** (a HOSE match
  at sphere ≥ 3 agrees within 0.65 ppm for ¹H or 4.0 ppm for ¹³C), **medium** (a
  sphere 1–2 match agrees, or no match and the atom is well inside the training
  domain), or **low** (the GNN and the HOSE lookup disagree beyond that band, or the
  atom is in the domain only by the minimum counts). On a disagreement the GNN value
  is reported with tier low, the warning "model and reference lookup disagree", and
  both values; they are never averaged. Tiers are names, not probabilities. The
  rules were fixed before the test set was opened. See
  [GNN shift predictor](docs/gnn-model.md).
- **OCL-native HOSE lookup** (cross-check and fallback for ¹H/¹³C; the ³¹P
  predictor) — uses OpenChemLib to derive atom environment codes and
  looks them up in statistics compiled from **NMRShiftDB2** assignments
  (the database does not mark which are experimental) (deepest-sphere-first, with honest coverage warnings). Requests honor
  either the database median or mean. Every ¹H HOSE match whose chemistry is
  supported by the bounded tables may carry a second opinion from the versioned
  additive-increment estimator, but only when its tabulated scheme explicitly
  applies; heteroarenes, imines, unsupported S/Si substituents, charge, unsupported isotope labels,
  and radicals are never silently treated as generic carbon/alkyl chemistry. The
  HOSE value remains the stored primary value; the panel always shows the
  HOSE/increment comparison state and reports exact coverage. Every CH₂ is checked
  on a component-local copy with explicit hydrogens; when OpenChemLib assigns its
  two hydrogens different diastereotopic IDs, they receive a disclosure rather
  than fabricated separate shifts. This includes alkene and ring stereochemistry,
  not only structures containing an atom stereocenter. When a carbon carries
  exactly two methyl groups and the structure contains a stereocenter, the pair may be
  diastereotopic; the warning is shown for both ¹H and ¹³C, while the model keeps
  one shift for the pair and does not fabricate separate values. Tert-butyl
  groups are excluded. More generally, `NMR_STEREO_NONEQUIVALENT_MERGED`
  identifies emitted constitutional classes whose OpenChemLib diastereotopic
  atom IDs differ; those atoms may give separate signals, but the model keeps the
  class merged and never copies or invents separate shifts. The older methyl code
  takes precedence for the same methyl atoms. The older CH₂-hydrogen code remains
  separate because it describes two hydrogens represented by one host atom rather
  than multiple heavy-atom class members. `NMR_SECOND_ORDER_PATTERN_LIKELY` marks a
  chemically equivalent proton class only when its members have different
  model-reported J values to an outside proton in the same connected spin system;
  an externally uncoupled isochronous set is not warned. Model-reported J values
  and displayed multiplets share one exchange-decoupling policy: O–H, N–H, and
  S–H coupling paths are excluded when labile hydrogens are ignored and retained
  when they are requested. Multiplicity and J are only first-order, topology-based
  estimates, and a full spin analysis may be needed. Disclosure checks are
  advisory: if OpenChemLib cannot complete one, the predictor reports that
  limitation and still returns the available shifts.
  Deuterium on any host, including O/N (molfile `D` or explicit `H` with `M ISO`
  mass 2), is excluded from ¹H counts: only the replaced proton's signal disappears.
  Database environment matching and rule estimates for both ¹H and ¹³C treat D
  as H, with `NMR_DEUTERIUM_SHIFT_NOT_MODELLED` disclosing that isotope shifts
  are ignored at first order. Other isotope labels (including ¹³C, ¹⁵N and ³H/T)
  retain the existing unsupported-isotope behavior. Carbon-bound vicinal H–D
  couplings are **typical first-order estimates**, using
  the existing H–H class constant × γ(²H)/γ(¹H) = 0.1535 (Harris et al., IUPAC
  Recommendations 2001, Table 1 (¹H) and Table 2 (²H), doi:10.1351/pac200173111795;
  ratio verified against the paper on 2026-11-10). Equivalent D partners have spin 1:
  one/two/three D give triplet/quintet/septet intensities 1:1:1,
  1:2:3:2:1, and 1:3:6:7:6:3:1, nested with H–H splitting. Geminal H–D is
  omitted because the model has no geminal H–H constant. ¹³C predictions on
  D-bearing carbons additionally carry `NMR_CARBON_DEUTERIUM_SPLITTING_NOT_MODELLED`,
  identifying the carbon indices and stating that C–D splitting and isotope shifts
  are not modelled. H–D and nested H–H line spacing follows the host's
  selected spectrometer field, preserving J in Hz and spin-1 intensities. Standalone
  SVGs accept `protonFrequencyMHz` (default 400 MHz) and display the field.
  See [H–D implementation notes](docs/deuterium-coupling.md).
- **Fixture** — deterministic synthetic data used for tests and explicit fixture
  provider requests.

All implement the same `NmrPredictor` interface, so the command / worker / panel
are provider-agnostic. Prediction runs off the main thread in a Web Worker
(request-id protocol). Where `Worker` is unavailable, the fallback runs the real
GNN-first predictor (with its HOSE fallback) in-thread; it does not substitute
fixture values.

Deuterium on any host, including O/N (molfile `D` or explicit `H` with `M ISO`
mass 2), is matched as hydrogen for both ¹H/¹³C database environments and rule
estimates. D is excluded from proton counts and equivalence populations: only
the replaced hydrogen's signal disappears. `NMR_DEUTERIUM_SHIFT_NOT_MODELLED`
discloses that isotope shifts are ignored at first order.
Carbon–carbon vicinal H–D coupling is shown as a typical first-order estimate
with spin-1 patterns, as described above. `NMR_DEUTERIUM_COUPLING_NOT_SHOWN` lists
proton host atoms only where geminal H–D or vicinal paths involving heteroatoms
are omitted. Computed carbon–carbon vicinal paths do not trigger that warning.
`NMR_DEUTERIUM_LONG_RANGE_COUPLING_NOT_SHOWN` lists proton host atoms with D four
or five bonds away (for example aromatic meta or para), which is not computed.
Existing H–H splitting uses only the remaining ordinary hydrogens.
¹³C predictions on D-bearing carbons also carry
`NMR_CARBON_DEUTERIUM_SPLITTING_NOT_MODELLED`: C–D splitting and isotope shifts
are not modelled. Deuterium caveats keep the analysis status partial even when
all shifts have database matches. Other isotope labels retain the existing refusal behavior.
See [deuterated environment matching](docs/deuterated-environments.md) for examples
and the warning range.

## ¹H and ¹³C accuracy

### GNN predictions

| Nucleus | MAE (ppm) | Partition |
| --- | ---: | --- |
| ¹H | 0.277 | scaffold-held-out test, 10% of Murcko scaffolds |
| ¹³C | 1.75 | scaffold-held-out test, 10% of Murcko scaffolds |

These are the GNN's errors on every scored atom of the **scaffold-held-out test,
10% of Murcko scaffolds** partition, measured at the **second, non-independent
opening** of that test set (the first opening, on 2026-11-20, was not certified as
a one-shot test). They do not apply to HOSE lookup values. See
[GNN shift predictor](docs/gnn-model.md).

### HOSE lookup

The ¹H and ¹³C lookup keys account for neighbor formal charges at every HOSE
sphere. In the held-out NMRShiftDB2 benchmark (OpenChemLib structure-idcode
split, seed 1, 20 per 1,000 buckets), the median lookup had the following results.

| Nucleus | Coverage | MAE (ppm) | Median AE (ppm) | P90 AE (ppm) |
| --- | ---: | ---: | ---: | ---: |
| ¹H | 98.7% | 0.358 | 0.17 | 0.92 |
| ¹³C | 99.3% | 3.517 | 1.56 | 8.69 |

See the [benchmark partition and per-tier results](docs/charge-aware-hose.md).

## ¹⁹F prediction (CF3 only)

Choose **Analyze → Predict ¹⁹F NMR Shifts (CF3 only)**. This version predicts ¹⁹F
only when all of the molecule's fluorine atoms form one fluorine environment of type
CF3. Every other fluorinated molecule gets no ¹⁹F shift and a plain warning that names
the reason. That covers a molecule with more than one fluorine environment, and any
CF2, aryl-F, hetero-F, acyl-F, vinyl-F, alkyl-F or other fluorine. A bundled GNN
trained on NMRexp ¹⁹F data predicts the CF3 shift. A HOSE lookup over NMRexp
statistics is its cross-check and its fallback when the GNN declines or the model is
unavailable. Each shift is labeled **GNN prediction** or **HOSE lookup** and carries a
tier (agreement band 5.5 ppm). The model loads only for a ¹⁹F prediction and must
match its frozen SHA-256.

Measured on the shipped predictor, CF3 only:

- NMRShiftDB2 single-environment CF3 molecules (independent gate, first opening):
  MAE 3.47 ppm [95% interval 2.25, 5.02], 157 molecules
- held-out NMRexp source files (10%, molecule-deduplicated), CF3: MAE 3.53 ppm
  [2.10, 5.23], 6,903 molecules

NMRShiftDB2 served only as that test gate; the model and table come from NMRexp
(CC BY 4.0). [¹⁹F method, rules and verification](docs/gnn-model.md) ·
[Pre-registered protocol](docs/f19-benchmark.md)

## ³¹P prediction

Select a phosphorus-containing structure and choose **Analyze → Predict ³¹P NMR
Shifts**. The default predictor searches the bundled Ilm-NMR-P31 v3.0 HOSE table from
sphere 4 down to sphere 1 and uses the median shift by default. The table contains
aggregated statistics built from the full pinned corpus and keeps environments
with at least five observations.

In the benchmark partition **held-out source references, 10%, molecule-deduplicated**,
the lookup matched 4,812 of 5,577 phosphorus observations (86.3%). The matched predictions had an
MAE of 6.817 ppm, an RMSE of 18.357 ppm, and a median absolute error of 2.335 ppm.
The benchmark training table used the same five-observation cutoff as the bundled table.
When the table's corpus checksum matches, the panel shows one row from this
benchmark: the median absolute error (2.335 ppm) followed by the per-tier median
absolute errors, the partition name and the benchmark date. Match rate, MAE and
RMSE are not shown in the panel. [Benchmark protocol and results](docs/p31-benchmark.md)

Confidence tiers describe match depth and reference population. With the bundled
table, high means sphere 3 or 4 with at least eight observations, low means a
sphere 1 match, and medium covers the other matches. In **held-out source references, 10%, molecule-deduplicated**,
median absolute errors were 0.96, 1.55, and 7.8 ppm for high, medium, and low tiers,
respectively. Individual shifts can have much larger errors.

Unmatched phosphorus sites are omitted with a warning. If the predictor is run
without a ³¹P table, it declines with `NMR_PHOSPHORUS_DATABASE_NOT_INSTALLED`.
The report flags sphere 1 matches and warns when a merged resonance contains
phosphorus atoms that may give separate stereochemical signals. The model
reports chemical shifts and leaves solvent effects and ³¹P splitting unmodeled.

## ⚠️ Data provenance

- The ¹H/¹³C GNN model weights (`src/providers/gnn/model/*.onnx`) and their training-domain
  counts (`src/providers/gnn/model/domain.json`) were fitted to NMRShiftDB2
  assignments. They are NMRShiftDB2-derived data under the **nmrshiftdb2 Database
  License** (ODbL-derived), not MIT — see `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.
  ONNX Runtime Web 1.22.0, which runs them, is MIT-licensed (Microsoft).
- The OCL provider's `src/providers/ocl/nmrshiftdb2.database.json` is a
  **derivative database** of aggregated shift statistics (no structures) under the
  **nmrshiftdb2 Database License** (ODbL-derived; commercial use OK, share-alike,
  attribution) — see `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.
- The ³¹P table is derived from Ilm-NMR-P31 v3.0 (Zenodo,
  [10.5281/zenodo.20762603](https://doi.org/10.5281/zenodo.20762603); Hack et al., 2023),
  under [**CC BY 4.0**](https://creativecommons.org/licenses/by/4.0/). About 27,000 of
  its 43,317 entries come from NMRexp (Wang and Zhu, [10.5281/zenodo.17296666](https://doi.org/10.5281/zenodo.17296666),
  **CC BY 4.0**). Values were filtered and transformed into HOSE statistics. The GitHub
  copy used to build the table is **BSD-3-Clause**, copyright (c) 2026 Robert Geitner;
  that credit is kept. Redistributed with the author's permission (owner, 2026-11-20).
  [Dataset paper](https://doi.org/10.1186/s13321-023-00792-y) · [Attribution and license text](src/providers/ocl/ILM_NMR_P31_LICENSE.md)
- The ¹⁹F model weights, training-domain counts and HOSE table
  (`src/providers/gnn/model-19F/`) are derived from NMRexp (Wang, Jun-Jie and Zhu, Rong,
  [10.5281/zenodo.17296666](https://doi.org/10.5281/zenodo.17296666); Wang, J.-J., Jin, Y.,
  Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025)), under
  [**CC BY 4.0**](https://creativecommons.org/licenses/by/4.0/). The rows were filtered,
  deduplicated, outlier-cleaned and transformed into HOSE statistics and GNN weights; no
  structures are included. NMRShiftDB2 was used only as the independent test gate and
  is not a source of these files.
  [Attribution and license text](src/providers/gnn/model-19F/NMREXP_LICENSE.md)
- The fixture provider's values are **synthetic**, labeled as such everywhere.
- Coverage is intentionally narrow. Applicable coarse estimates are marked partial
  and include per-resonance `source: "rule-estimate"`, estimator ID, version, and
  method; database matches carry `source: "lookup"`. Rule shifts have an `≈` prefix
  and `est.` table cell, `est.` spectrum labels, and dashed sticks in exported SVGs,
  with a legend. A warning lists the affected zero-based atom indices (host atoms
  for ¹H). Fully matched shifts carry no rule-estimate markers. An unmatched
  unsupported environment is omitted with a stable warning instead of receiving a
  fabricated generic value.

The original plugin code is **MIT-licensed** (`LICENSE`). The root `package.json`
declares each dataset's separate license, source artifact path, and notice file
under `dataLicenses`. `npm run package` includes that metadata, the declared notices,
and `THIRD_PARTY_NOTICES.md` in the installable ZIP.
[Data license packaging](docs/release-data-licence-integration.md)

See `THIRD_PARTY_NOTICES.md` for the full third-party attribution.

## Layout

```
src/
├── manifest.ts        contributions (¹³C, ¹H experimental, ³¹P and ¹⁹F CF3-only commands, menu, panel, analyzer)
├── register.ts        command handlers + onPanelClosed lifecycle
├── workerEntry.ts     the worker entry the release bundles into entry.js
├── domain/            serializable contracts, errors, warnings, schemas
├── application/       normalization, selection mapping, status, the command
├── providers/         gnn/ (default ¹H/¹³C GNN, featurizer, ONNX runtime, decline/tier rules;
│                      f19/ and model-19F/: the ¹⁹F CF3-only GNN and its NMRexp HOSE table),
│                      ocl/ (HOSE lookup: NMRShiftDB2 and Ilm-NMR-P31), fixture/ (synthetic)
├── worker/            protocol, core handler, entry, client
└── report/            declarative panel composition + stick-spectrum SVG
scripts/build-database.ts   compile NMReDATA/SDF exports into bundled databases
scripts/gnn-worker-parity.ts  prove worker-path GNN feature parity on an experiment extraction
tools/                      vendored packaging tool (plugin-package + boundary/gate checks)
vendor/                     vendored SDK tarballs (ADR-0031)
```

Rebuild the ¹H/¹³C reference database (the `n >= 5` bundle-size prune is the default; the
raw input's SHA-256 is embedded in the artifact's provenance for reproducibility):

```bash
npx tsx scripts/build-database.ts \
  <nmrshiftdb2rawdata.nmredata.sd> \
  src/providers/ocl/nmrshiftdb2.database.json \
  --min-observations 5
```
