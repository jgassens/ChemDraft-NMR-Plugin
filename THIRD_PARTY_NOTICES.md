# Third-party notices

## Runtime dependencies

- **openchemlib** (BSD-3-Clause) — molecule parsing, aromaticity perception, and
  atom/bond topology used by `application/normalizeStructure.ts` and the fixture
  environment generator. This is the same OpenChemLib version ChemDraft already
  ships (`^9.22.1`); the plugin deliberately reuses it rather than introducing a
  second OCL runtime.
- **zod** (MIT) — runtime validation of the serializable prediction request/result.
- **@chemdraft/plugin-api** (workspace) — the generic plugin contracts.
- **onnxruntime-web 1.22.0** (MIT, Copyright (c) Microsoft Corporation) — runs the
  bundled GNN models on its single-threaded WebAssembly backend inside the plugin
  worker. The package ships its JavaScript (`ort.wasm.bundle.min-*.js`, which
  includes `onnxruntime-common` 1.22.0, MIT, Microsoft), its WebAssembly loader
  module (`ort-wasm-simd-threaded-*.mjs`) and its WebAssembly binary
  (`ort-wasm-simd-threaded-*.wasm`), all unmodified. The WebAssembly binary is
  ONNX Runtime compiled with Emscripten; the open-source components it
  statically links are listed, with their licenses, in ONNX Runtime's
  [ThirdPartyNotices.txt for v1.22.0](https://github.com/microsoft/onnxruntime/blob/v1.22.0/ThirdPartyNotices.txt).
  License text:

  ```
  MIT License

  Copyright (c) Microsoft Corporation

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  ```

## Prediction data

The ¹H/¹³C predictor is a GNN with the OCL-native HOSE lookup as cross-check and
fallback; its model weights are separately-tracked data:

- **GNN shift model weights** (`src/providers/gnn/model/1H.fp16.onnx`,
  `src/providers/gnn/model/13C.fp16.onnx`) and its **training-domain counts**
  (`src/providers/gnn/model/domain.json`) — fitted to NMRShiftDB2 atom
  assignments, so offered under the same **nmrshiftdb2 Database License**
  (ODbL-derived) as the HOSE statistics, never under MIT. They contain no
  structures. Provenance and license: `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.

Two lookup providers ship, with separately-tracked data:

- **Fixture provider** (`providers/fixture/fixtureDatabase.ts`) — **ChemDraft-owned
  synthetic fixtures**, not derived from any experimental dataset. Used for
  deterministic tests / offline fallback.
- **OCL-native provider** (default) — its reference database
  `src/providers/ocl/nmrshiftdb2.database.json` is a **derivative database compiled
  from NMRShiftDB2** assignments (the database does not mark which are experimental), under the **nmrshiftdb2 Database
  License** (ODbL-derived; commercial use permitted, share-alike, attribution).
  Provenance, license, and attribution: `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`.
  It contains aggregated statistics only, no structures. Rebuild via
  `scripts/build-database.ts`.
- **Ilm-NMR-P31-derived ³¹P HOSE shift statistics** (`src/providers/ocl/ilm-nmr-p31.database.json`)
  — aggregated statistics from Ilm-NMR-P31 v3.0 (Zenodo,
  DOI 10.5281/zenodo.20762603; 43,317 entries), licensed under
  [**CC BY 4.0**](https://creativecommons.org/licenses/by/4.0/); see also
  Hack et al. (2023), DOI 10.1186/s13321-023-00792-y. About 27,000 of those entries
  come from NMRexp (Wang, Jun-Jie and Zhu, Rong, Zenodo DOI 10.5281/zenodo.17296666,
  **CC BY 4.0**; Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., Scientific Data 12, 1954
  (2025), DOI 10.1038/s41597-025-06245-5). The values were filtered and transformed
  into aggregated HOSE statistics. The table was built from the GitHub copy
  clacor/Ilm-NMR-P31 at ead6f914, identical in content to v3.0; that copy carries a
  **BSD-3-Clause** license, copyright (c) 2026 Robert Geitner, which is kept as
  credit. Redistributed with the author's permission (owner, 2026-11-20).
  [Ilm-NMR-P31 v3.0](https://doi.org/10.5281/zenodo.20762603) · [NMRexp](https://doi.org/10.5281/zenodo.17296666) · [Dataset paper](https://doi.org/10.1186/s13321-023-00792-y) · [clacor/Ilm-NMR-P31 at ead6f914d2bdfb60e4befea72ea503d32978d358](https://github.com/clacor/Ilm-NMR-P31/tree/ead6f914d2bdfb60e4befea72ea503d32978d358) · [Attribution and license text](src/providers/ocl/ILM_NMR_P31_LICENSE.md)

The plugin's original **code is MIT-licensed**, as recorded in `LICENSE`. The root
`package.json` declares the compiled data assets (both HOSE tables and the GNN
model weights) and their separate licenses under `dataLicenses`. The panel's
"Reference database" section shows the license for each database used, and its "GNN
model" section shows the model's training data and license. The installable package
includes that package metadata, this notice, and both data license files.

## Rule-parameter sources

The aliphatic additive estimator's compact sp3 C-H base values and alpha/beta/gamma
increments are transcribed numerical facts from P. S. Beauchamp and R. Marquez,
"A General Approach for Calculating Proton Chemical Shifts for Methyl, Methylene,
and Methine Protons When There Are One or More Substituents within Three Carbons,"
*J. Chem. Educ.* **1997**, 74, 1483-1485, DOI
[10.1021/ed074p1483](https://doi.org/10.1021/ed074p1483). ChemDraft's topology
classification and implementation are original; no article text or figures ship.

The aromatic benzene ortho/meta/para correction table consolidates numerical
values commonly reproduced in spectroscopy teaching tables, including:

- Royal Society of Chemistry, *Modern Chemical Techniques: Nuclear magnetic
  resonance spectroscopy*, Table 2
  ([PDF](https://edu.rsc.org/download?ac=13847)); and
- MIT OpenCourseWare, *UACA Appendix #2: Proton NMR Chemical Shift
  Substituent Effects*,
  ([PDF](https://mitocw.ups.edu.ec/courses/chemistry/5-311-introductory-chemical-experimentation-fall-2005/labs/uaca_appendix2.pdf)).

ChemDraft normalizes those standard numerical teaching values into its own
compact topology keys; it does not reproduce one source's prose, layout, or
table verbatim.

The aldehyde (9.7 ppm), terminal-alkyne (2.4 ppm), and vinylic (5.7 ppm)
fallbacks are ChemDraft-owned **coarse representative in-range heuristics**,
selected from the functional-class ranges in Beauchamp's teaching handout,
*1H NMR Chemical Shift Ranges* (pages 17-18,
[PDF](https://chemistryconnected.com/psb/pdf/NMR_Info_Tables_12-31-09.pdf)).
They are not outputs of the alpha/beta/gamma calculation and are surfaced as
functional-class estimates.
