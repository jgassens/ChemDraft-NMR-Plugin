# Data licence integration

Root `package.json` declares the bundled NMRShiftDB2-derived HOSE shift statistics
under `dataLicenses`. The code licence remains MIT; the database is under the
**nmrshiftdb2 Database License (ODbL-derived)**, with attribution and share-alike
obligations documented in `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.

```json
"dataLicenses": [
  {
    "name": "NMRShiftDB2-derived HOSE shift statistics",
    "path": "src/providers/ocl/nmrshiftdb2.database.json",
    "license": "nmrshiftdb2 Database License (ODbL-derived)",
    "noticeFile": "src/providers/ocl/NMRSHIFTDB2_LICENSE.md"
  }
]
```

The host's `tools/plugin-extract/gates.ts` reads `package.json` and validates
`dataLicenses`: each dataset requires non-empty `name` and `license` fields,
and each declared `noticeFile` must exist. The optional `path` above
records which source artifact this declaration covers; the host does not validate
that extra metadata. `findBundledDataPaths` in that host file detects common data
directories and extensions. Its heuristic does not detect this JSON outside a
data directory, so the explicit declaration is still necessary.

`src/manifest.ts` uses the vendored SDK's `PluginManifest` unchanged. Data licence
metadata belongs to package metadata, so no SDK or vendor update is needed.

## Installable package

`npm run package` invokes `scripts/package.ts`, which calls the existing standalone
bundler and then `scripts/package-notices.ts`. The latter uses `dataLicenses` as
the notice inclusion configuration: it copies every declared `noticeFile` at its
original relative path, root `package.json`, and `THIRD_PARTY_NOTICES.md` into the
staged package. It recreates the ZIP and SHA-256 sidecar after those additions.
Missing notices fail packaging and remove the ZIP and sidecar.

The database itself is compiled into the predictor's JavaScript chunks; `path`
identifies its source artifact rather than promising a separate JSON in the built
ZIP. The declared notice path exists in both the source tree and built ZIP.

## Verification

`src/tests/manifest.test.ts` validates and registers the runtime manifest with the
vendored SDK/host. `src/tests/dataLicense.test.ts` verifies the package declaration,
dataset path, notice contents, ZIP inclusion, updated checksum, and missing-notice
failure. It also checks the actual release ZIP when available.

Release artifact tests require a clean committed checkout and a current package:

```sh
npm run package
CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 npx vitest run src/tests/dataLicense.test.ts
CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 npx vitest run src/tests/packageAssetReferences.test.ts
CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 npx vitest run src/tests/packageIntegration.test.ts
```
