# @chemdraft/plugin-nmr-predictor

Standalone repository for ChemDraft's first-party **NMR shift predictor** plugin.
Select a structure and use the **Analyze** menu to see a predicted ¹³C, ¹H
(experimental), or ³¹P stick spectrum and shift table. The host stores predictions
and flags them as stale when the structure changes.

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
4. Select a structure and use the **Analyze** menu to predict ¹³C, ¹H
   (experimental), or ³¹P shifts.

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

This resolves the two vendored SDK tarballs from `vendor/` plus `openchemlib` and
`zod` from the public npm registry.

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

- **OCL-native (default)** — uses OpenChemLib to derive atom environment codes and
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

Both implement the same `NmrPredictor` interface, so the command / worker / panel
are provider-agnostic. Prediction runs off the main thread in a Web Worker
(request-id protocol). Where `Worker` is unavailable, the fallback runs the real
OCL-native predictor in-thread; it does not substitute fixture values.

Deuterium on any host, including O/N (molfile `D` or explicit `H` with `M ISO`
mass 2), is matched as hydrogen for both ¹H/¹³C database environments and rule
estimates. D is excluded from proton counts and equivalence populations: only
the replaced hydrogen's signal disappears. `NMR_DEUTERIUM_SHIFT_NOT_MODELLED`
discloses that isotope shifts are ignored at first order.
Carbon–carbon vicinal H–D coupling is shown as a typical first-order estimate
with spin-1 patterns, as described above. `NMR_DEUTERIUM_COUPLING_NOT_SHOWN` lists
proton host atoms only where geminal H–D or vicinal paths involving heteroatoms
are omitted. Computed carbon–carbon vicinal paths do not trigger that warning.
Existing H–H splitting uses only the remaining ordinary hydrogens.
¹³C predictions on D-bearing carbons also carry
`NMR_CARBON_DEUTERIUM_SPLITTING_NOT_MODELLED`: C–D splitting and isotope shifts
are not modelled. Deuterium caveats keep the analysis status partial even when
all shifts have database matches. Other isotope labels retain the existing refusal behavior.
See [deuterated environment matching](docs/deuterated-environments.md) for examples
and the warning range.

## ³¹P prediction

Select a phosphorus-containing structure and choose **Analyze → Predict ³¹P NMR
Shifts**. The default predictor searches the bundled Ilm-NMR-P31 HOSE table from
sphere 4 down to sphere 1 and uses the median shift by default. The table contains
aggregated statistics built from the full pinned corpus and keeps environments
with at least five observations.

In the benchmark partition **held-out source references, 10%, molecule-deduplicated**,
the lookup matched 5,278 of 5,577 phosphorus observations (94.6%). The matched predictions had an
MAE of 7.565 ppm, an RMSE of 20.002 ppm, and a median absolute error of 2.23 ppm.
The benchmark used a training-only table that retained all observed environments.
The panel displays those benchmark measurements when the table's corpus checksum
matches. [Benchmark protocol and results](docs/p31-benchmark.md)

Confidence tiers describe match depth and reference population. With the bundled
table, high means sphere 3 or 4 with at least eight observations, low means a
sphere 1 match, and medium covers the other matches. In the held-out benchmark,
median absolute errors were 0.93, 1.58, and 4.20 ppm for high, medium, and low tiers,
respectively. These values summarize match groups. Individual shifts can have much
larger errors.

Unmatched phosphorus sites are omitted with a warning. If the predictor is run
without a ³¹P table, it declines with `NMR_PHOSPHORUS_DATABASE_NOT_INSTALLED`.
The report flags sphere 1 matches and warns when a merged resonance contains
phosphorus atoms that may give separate stereochemical signals. The model
reports chemical shifts and leaves solvent effects and ³¹P splitting unmodeled.

## ⚠️ Data provenance

- The OCL provider's `src/providers/ocl/nmrshiftdb2.database.json` is a
  **derivative database** of aggregated shift statistics (no structures) under the
  **nmrshiftdb2 Database License** (ODbL-derived; commercial use OK, share-alike,
  attribution) — see `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.
- The ³¹P table is derived from Ilm-NMR-P31 (Hack et al., 2023), under
  **BSD-3-Clause**, copyright (c) 2026 Robert Geitner. Redistributed with the
  author's permission (owner, 2026-11-20). [Dataset paper](https://doi.org/10.1186/s13321-023-00792-y) · [License text](src/providers/ocl/ILM_NMR_P31_LICENSE.md)
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
├── manifest.ts        contributions (¹³C, ¹H experimental, and ³¹P commands, menu, panel, analyzer)
├── register.ts        command handlers + onPanelClosed lifecycle
├── workerEntry.ts     the worker entry the release bundles into entry.js
├── domain/            serializable contracts, errors, warnings, schemas
├── application/       normalization, selection mapping, status, the command
├── providers/         fixture/ (synthetic) and ocl/ (NMRShiftDB2 and Ilm-NMR-P31, default)
├── worker/            protocol, core handler, entry, client
└── report/            declarative panel composition + stick-spectrum SVG
scripts/build-database.ts   compile NMReDATA/SDF exports into bundled databases
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
