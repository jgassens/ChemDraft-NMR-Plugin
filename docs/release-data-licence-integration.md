# Data license integration

Root `package.json` declares three bundled data assets under `dataLicenses`.
The NMRShiftDB2-derived ¹H/¹³C shift statistics and the NMRShiftDB2-derived GNN
model weights (with their training-domain counts) use the **nmrshiftdb2 Database
License (ODbL-derived)**. The Ilm-NMR-P31-derived ³¹P shift statistics use
**BSD-3-Clause**. The plugin code uses MIT.
[NMRShiftDB2 notice](../src/providers/ocl/NMRSHIFTDB2_LICENSE.md) · [Ilm-NMR-P31 license](../src/providers/ocl/ILM_NMR_P31_LICENSE.md)

The host's `tools/plugin-extract/gates.ts` reads `package.json` and validates
`dataLicenses`: each dataset requires non-empty `name` and `license` fields,
and each declared `noticeFile` must exist. The optional `path` records the source
artifact the declaration covers. The explicit declarations cover JSON artifacts
outside the data directories detected by the host's `findBundledDataPaths` heuristic.

Every entry also carries two optional display fields: `attribution`, the exact credit
line a user should see (authors, title, year, license), and `url`, one https link to the
dataset's DOI or homepage. `src/tests/dataLicense.test.ts` requires both on every entry.
The packager copies `package.json` unchanged, so the fields ship in the ZIP.

The vendored SDK's strict `PluginManifest` schema governs `src/manifest.ts`.
The data license declarations live in the package metadata.

## Installable package

`npm run package` invokes `scripts/package.ts`, which calls the existing standalone
bundler and then `scripts/package-notices.ts`. The latter uses `dataLicenses` as
the notice inclusion configuration: it copies every declared `noticeFile` at its
original relative path, root `package.json`, and `THIRD_PARTY_NOTICES.md` into the
staged package. It recreates the ZIP and SHA-256 sidecar after those additions.
Missing notices fail packaging and remove the ZIP and sidecar.

Vite compiles both databases and the GNN training-domain counts into the
predictor's JavaScript chunks, and emits the two GNN model files (`1H.fp16-*.onnx`,
`13C.fp16-*.onnx`) as package files. Each `path` identifies the source artifact; the
model entry lists its `files`. Both notice files keep their source paths in the ZIP.

## Verification

`src/tests/manifest.test.ts` validates and registers the runtime manifest with the
vendored SDK/host. `src/tests/dataLicense.test.ts` verifies the package declaration,
dataset paths, notice contents, ZIP inclusion, updated checksum, and missing-notice
failure. The package integration test runs both the ¹³C and ³¹P commands against
the built predictor, so it verifies the bundled tables can be used from the ZIP.

Release artifact tests require a clean committed checkout and a current package:

```sh
npm run package
CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 npx vitest run src/tests/dataLicense.test.ts
CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 npx vitest run src/tests/packageAssetReferences.test.ts
CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 npx vitest run src/tests/packageIntegration.test.ts
```
