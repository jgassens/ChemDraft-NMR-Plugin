# @chemdraft/plugin-nmr-predictor

Standalone, self-contained repository for ChemDraft's first-party **NMR shift
predictor** plugin. Select a structure, run **Analyze → Predict ¹³C NMR Shifts**
(or the experimental ¹H command), and see a stick-spectrum + shift table in a
declarative panel. Predictions are written to the host's generic analysis store
and flagged stale when the structure changes.

This repo builds the **installable plugin package** — the `nmr-predictor-<version>.zip`
a ChemDraft host downloads and installs (ADR-0029/M35). It compiles only against
the vendored ChemDraft plugin SDK; no monorepo is required.

## Provenance

Extracted from the ChemDraft monorepo (`codex/nmr-plugin` @ `125aebeb`); full
development history is preserved on that branch and can be grafted in later via
`git subtree split` once the source repo is off iCloud. This repository begins
with a single squashed initial commit by design.

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

## Install

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
   filename, and provenance) and copies `LICENSE`;
4. emits `dist/plugin-packages/nmr-predictor-<version>.zip` and a
   `.zip.sha256` sidecar (integrity only — never a trust gate, ADR-0029 §4).

Because the Git-clean gate must see a committed, clean tree, run `npm run package`
**after** the initial commit; `dist/` is git-ignored, so building never dirties the
tree.

## Providers

- **OCL-native (default)** — uses OpenChemLib to derive atom environment codes and
  looks them up in a database compiled from **NMRShiftDB2** experimental
  assignments (deepest-sphere-first, with honest coverage warnings). Requests honor
  either the database median or mean. Every ¹H HOSE match whose chemistry is
  supported by the bounded tables may carry a second opinion from the versioned
  additive-increment estimator, but only when its tabulated scheme explicitly
  applies; heteroarenes, imines, unsupported S/Si substituents, charge, isotopes,
  and radicals are never silently treated as generic carbon/alkyl chemistry. The
  HOSE value remains the stored primary value; the panel always shows the
  HOSE/increment comparison state and reports exact coverage. In stereogenic
  structures, potentially nonequivalent CH₂ hydrogens receive a disclosure rather
  than fabricated separate shifts.
- **Fixture** — deterministic synthetic data; used for tests and as an offline /
  no-`Worker` fallback.

Both implement the same `NmrPredictor` interface, so the command / worker / panel
are provider-agnostic. Prediction runs off the main thread in a Web Worker
(request-id protocol), with an in-thread fallback where `Worker` is unavailable.

## ⚠️ Data provenance

- The OCL provider's `src/providers/ocl/nmrshiftdb2.database.json` is a
  **derivative database** of aggregated shift statistics (no structures) under the
  **nmrshiftdb2 Database License** (ODbL-derived; commercial use OK, share-alike,
  attribution) — see `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.
- The fixture provider's values are **synthetic**, labeled as such everywhere.
- Coverage is intentionally narrow. Applicable coarse estimates are marked partial
  and include per-resonance estimator ID, version, and method. An unmatched
  unsupported environment is omitted with a stable warning instead of receiving a
  fabricated generic value.

See `THIRD_PARTY_NOTICES.md` for the full third-party attribution.

## Layout

```
src/
├── manifest.ts        contributions (¹³C default + ¹H experimental commands, menu, panel, analyzer)
├── register.ts        command handlers + onPanelClosed lifecycle
├── workerEntry.ts     the worker entry the release bundles into entry.js
├── domain/            serializable contracts, errors, warnings, schemas
├── application/       normalization, selection mapping, status, the command
├── providers/         fixture/ (synthetic) and ocl/ (NMRShiftDB2, default)
├── worker/            protocol, core handler, entry, client
└── report/            declarative panel composition + stick-spectrum SVG
scripts/build-database.ts   compile a NMReDATA/SDF export → the bundled database
tools/                      vendored packaging tool (plugin-package + boundary/gate checks)
vendor/                     vendored SDK tarballs (ADR-0031)
```

Rebuild the reference database (the `n >= 5` bundle-size prune is the default; the
raw input's SHA-256 is embedded in the artifact's provenance for reproducibility):

```bash
npx tsx scripts/build-database.ts \
  <nmrshiftdb2rawdata.nmredata.sd> \
  src/providers/ocl/nmrshiftdb2.database.json \
  --min-observations 5
```
