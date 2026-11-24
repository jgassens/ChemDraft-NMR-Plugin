# GNN shift predictor (¹H, ¹³C, and ¹⁹F for CF3 only)

Since experiment run nmrexp-02, a per-atom graph neural network (GNN) is the plugin's main ¹H and ¹³C predictor. The HOSE lookup over NMRShiftDB2 statistics stays as the cross-check and the fallback. ³¹P is unchanged: HOSE lookup over the Ilm-NMR-P31 table only. ¹⁹F is predicted for **CF3 only**, by a separate GNN trained on NMRexp with an NMRexp HOSE table as its cross-check and fallback; see the section "¹⁹F: CF3 only" below.

Every ¹H/¹³C resonance carries its method label, **GNN prediction** or **HOSE lookup**. A GNN prediction also carries a tier, **high**, **medium** or **low**. Tiers are names, not probabilities, and the plugin shows no calibrated percentages.

## Measured accuracy

| Nucleus | GNN MAE (ppm) | Partition |
| --- | ---: | --- |
| ¹H | 0.277 | scaffold-held-out test, 10% of Murcko scaffolds |
| ¹³C | 1.75 | scaffold-held-out test, 10% of Murcko scaffolds |

Both figures come from the **second, non-independent opening** of that test set. The first opening (run nmrexp-01, 2026-11-20) was not certified as a one-shot test, so these numbers are not an independent first look at the test partition. They describe the raw model on every scored test atom. They are not per-tier figures, and they do not apply to the HOSE lookup values shown where the GNN declines. The panel shows the same figures, with the same partition and opening, in its "GNN model" section, and only for the exact model release they were measured on.

The HOSE lookup's own figures (README, "¹H and ¹³C accuracy") come from a different benchmark partition and remain labeled with it.

## Method

- **Features.** The plugin's own featurizer, schema 1 (41 atom and 11 bond features; see [gnn-features.md](gnn-features.md)). The model was trained on features this code computed, so training and runtime share one code path.
- **Network.** `nmr-model-experiment/py/model.py` at commit `c05b91c`: a linear atom encoder, 8 gated message-passing layers (mean of sigmoid-gated neighbor messages, residual update, LayerNorm) and a two-layer decoder. Hidden width 256 for ¹H and 384 for ¹³C (the validation-selected trials). The output is in ppm; the training normalization is built into the exported graph.
- **Targets.** A ¹³C shift is predicted on the carbon's node. A ¹H shift is predicted on its host heavy atom's node.
- **Data.** NMRShiftDB2 assignments (the database does not mark which are experimental), split by Murcko scaffold into training, validation and test partitions. Training used the training partition; model selection, the agreement bands and every threshold that needed tuning used validation only.
- **Export.** ONNX opset 17, weights stored in fp16 and cast to fp32 inside the graph, so inference runs fp32 kernels.

## Runtime

- **ONNX Runtime Web 1.22.0**, pinned exactly in `package.json`, WebAssembly backend, `numThreads = 1`, no proxy worker. One binary (`ort-wasm-simd-threaded.wasm`) serves single-threaded use and needs no cross-origin isolation.
- **Lazy loading.** Nothing loads at plugin start, for capabilities, or for ³¹P. The first ¹H or ¹³C prediction loads that nucleus's model only; the runtime is imported then, as its own chunk. The result, success or failure, is cached for the worker's lifetime.
- **Checksum.** Each model's bytes are hashed with SHA-256 (Web Crypto) before use and must equal the frozen value in `src/providers/gnn/modelRelease.ts`. A mismatch, a missing file or a runtime that fails to load makes the model unavailable, and every atom falls back to the HOSE lookup.
- **Permission.** The manifest declares `model.load`. Nothing is downloaded: the models, the WebAssembly binary and its loader ship inside the plugin package and are read from the installed package. There is no `model.download` and no network access.
- **Size.** About 19 MB inside the package for ¹H/¹³C: the two models (2.3 MB ¹H, 5.1 MB ¹³C), the WebAssembly binary (11.2 MB), its loader module (21 KB) and the runtime's JavaScript (47 KB). ¹⁹F adds its model (5.1 MB) and its table and domain (0.5 MB).

| File | SHA-256 |
| --- | --- |
| `src/providers/gnn/model/1H.fp16.onnx` | `9220a054a8ff42fbc9fb5d7dc1ecd412ccc832ccebb261e4145df024724d67e8` |
| `src/providers/gnn/model/13C.fp16.onnx` | `17cfea4892b2f447a8d703095bb5025c0121a05402b735b2ad0ed2edbe95eade` |
| `src/providers/gnn/model/domain.json` | `d97f9f3fa7f594b64ec6f183ccb42e8fd9cade15b06dc0f25940a963d5582ee2` |

## Declines, fallback and tiers

The rules were written in the experiment's `ABSTENTION.md` before the test set was opened and are not changed here. `src/providers/gnn/domainRules.ts` ports the reference implementation (`py/abstention.py`, applied by `py/evaluate.py`) line by line.

### Declines (ABSTENTION.md section 1)

The GNN withholds its prediction for an atom when any rule below holds for the atom (for ¹H, its host heavy atom) or one of its graph neighbors. Counts come from the training partition and ship with the model in `domain.json`.

1. **Element.** The element is the featurizer's `other` bucket, or has fewer than 50 training atoms.
2. **Charge or radical.** The atom's (formal charge, radical state) pair has fewer than 20 training atoms of that element.
3. **Isotope.** Any isotope label other than ²H or ¹³C, including a folded tritium.
4. **Size.** The molecule has more heavy atoms than the training set's 99.9th percentile (nearest rank) or the 500-atom limit, whichever is lower: 103.
5. **Graph.** The featurizer rejects the molecule, or the atom has no heavy-atom node to predict on.

A declined atom gets the warning `NMR_GNN_DECLINED`, which names the rules and the atoms.

### Fallback (section 2)

When the model is missing, fails its checksum, fails to load, fails at inference, or declines an atom, that atom shows the HOSE engine's own result for it, unchanged, with its existing tiers and warnings, labeled **HOSE lookup**. That includes the engine's labeled rule estimates. When the lookup has nothing either, the atom gets no shift: nothing is fabricated.

### Tiers (section 3)

| Tier | Condition |
| --- | --- |
| **high** | A HOSE match at sphere ≥ 3 exists and \|GNN − lookup\| ≤ the agreement band |
| **medium** | A HOSE match at sphere 1–2 exists and \|GNN − lookup\| ≤ the band; or there is no HOSE match and the atom and each heavy neighbor have at least 500 training atoms of their element and charge state |
| **low** | \|GNN − lookup\| > the band; or no HOSE match and the atom is in the domain only by the minimum counts of rules 1–2 |

The agreement band is the 90th percentile (nearest rank) of \|GNN − observed\| on non-declined validation atoms, rounded up to 0.05 ppm for ¹H and 0.5 ppm for ¹³C: **0.65 ppm (¹H)** and **4.0 ppm (¹³C)**, as frozen in the experiment's `tuning.json` and `freeze.json`. A rule estimate is not a HOSE match: it neither sets a tier nor counts as a disagreement.

### Disagreement (section 4)

When \|GNN − lookup\| exceeds the band, the reported shift is still the GNN value, with tier **low**, the warning `NMR_MODEL_LOOKUP_DISAGREEMENT` ("model and reference lookup disagree"), and both values shown: the table's Confidence cell and the figure's comparison show the HOSE value beside the GNN value. The two are never averaged.

### Equivalent atoms

The plugin reports one resonance per constitutional class, the same classes the HOSE engine uses. A class is declined when the rules decline any member (constitutionally equivalent atoms share every input the rules read, so this equals the per-atom decision). Its GNN value and tier are those of the class's canonical representative atom. The class's HOSE value is the cross-check.

### Notices

HOSE notices that describe a value the GNN replaced (thin-match notices, "no database match" omissions) are dropped, and the rule-estimate summary and the omission count are recounted over what is shown. When the GNN shows nothing (model unavailable, every atom declined), the HOSE notices are kept exactly as the engine wrote them.

## Verification

What was checked, and how:

- **Numeric.** The ONNX Runtime Web outputs of both models on seven of the experiment's exported validation input tensors (`1H.latency_inputs.json`) match `py/model.py`'s forward pass evaluated independently in NumPy with the fp16 weights read from each ONNX file. On all 32 exported cases the largest difference was 1 × 10⁻⁵ ppm (¹H) and 2 × 10⁻⁴ ppm (¹³C). The test (`src/tests/gnnRuntime.test.ts`, fixture `src/tests/fixtures/gnn-onnx-reference.json`) allows 0.005 ppm and 0.05 ppm.
- **Tensor packing.** `packGnnInputs` reproduces the experiment's Python packing (`py/featurize.py`) byte for byte, neighbor order included, on all 32 exported cases; seven are in the committed fixture.
- **Worker-path parity.** `scripts/gnn-worker-parity.ts` sends every validation-partition molecule (4,667 records, partition `val` of the registered split) through the plugin's worker message handler to `GnnShiftPredictor`. All 4,667 canonical feature lines equal the training dump byte for byte (SHA-256 `0b7c4815060786e4c68f9ca4dc8d4c2b203fbe349ddb7bc56b0cd29c9a0f5ffc` on both sides), and in all 4,665 model runs the tensors handed to the model equal the training packing. The committed fixture (`src/tests/fixtures/gnn-worker-parity.json`) records these hashes, 29 validation hard cases by identifier and hash only, and 35 hand-authored hard cases (charged, aromatic heterocycles, stereo, isotopes, radicals, declined elements, size, hydrogen-only graphs, an unparsable molfile) that `src/tests/gnnWorkerParity.test.ts` runs through the worker path. No corpus record or bulk feature file is committed.
- **Decline and tier decisions.** On all 38,985 validation targets (10,641 ¹H, 28,344 ¹³C), the plugin's `assessNode` gives the same declines and margins as the experiment's `abstention.assess`, and `shippedDecision` gives the same method, value and tier as `abstention.shipped`. The validation decline counts reproduce the frozen record: 26 ¹H declines (6 element, 20 size) and none for ¹³C.
- **Bands.** With the plugin's ONNX models, the validation 90th-percentile errors are 0.604 ppm (¹H) and 3.778 ppm (¹³C), against 0.606 and 3.784 ppm from the experiment's own predictions; both round up to the frozen bands.
- **Package.** A build with the packaging tool's settings emits both models, the WebAssembly binary and its loader as co-located files. The built `entry.js`, run in Node, loaded no model at start, fetched only the ¹³C model for a ¹³C command and only the ¹H model for a ¹H command, and left ³¹P to the HOSE lookup.

Rerun the worker-path check against an experiment extraction:

```sh
node --import tsx scripts/gnn-worker-parity.ts \
  --extract <run>/extract --split <run>/split/split.json \
  --fixture src/tests/fixtures/gnn-worker-parity.json
```

It exits 2 on any difference.

## Limitations

- The Web Worker in the desktop app (WKWebView) has not been exercised by these tests; there, a missing WebAssembly SIMD feature or Web Crypto makes the model unavailable and the HOSE lookup is used.
- Node's `fetch` cannot read `file:` URLs, so a Node host using the default `GnnShiftPredictor` gets the HOSE fallback with `NMR_GNN_MODEL_UNAVAILABLE` (reason `missing`). A Node host passes its own reader instead: `new GnnShiftPredictor({ models: new GnnModelRuntime({ fetchAsset: async (url) => new Uint8Array(await readFile(url)) }) })`. In Node, ONNX Runtime Web's Emscripten loader also sets `globalThis.Worker` to `worker_threads.Worker` when it first loads.
- The stereo and second-order disclosure notices are computed by the HOSE engine for the classes it emits. A class the GNN predicts but the HOSE engine omitted still gets the stereo and second-order notices: `GnnShiftPredictor` calls `discloseResonanceLimitations` for it.
- Equivalent atoms that differ only in configuration (for example the two carbinol carbons of a meso diol) share one resonance, valued at the representative atom.
- Schema 1 does not distinguish ring cis/trans configurations or enhanced stereo (see [gnn-features.md](gnn-features.md)), and the model sees no solvent.

## ¹⁹F: CF3 only

¹⁹F prediction follows the pre-registered protocol [f19-benchmark.md](f19-benchmark.md) (commit `7794cd9`; clarifications in its §10). The owner approved shipping it after that test: CF3 is the only fluorine type that passed the protocol's type rule, so this version predicts **CF3 only**.

### What is predicted

A ¹⁹F shift is given only when all the molecule's fluorine atoms form **one fluorine environment** and that environment's type is **CF3**. Environments are the plugin's stereo-free constitutional symmetry classes, and the molecule is the fluorine-bearing fragment (counterions and solvent fragments are removed), as the reviewed cleaning code (`src/providers/ocl/f19/clean.ts`) defines them for training and scoring. Types are those of protocol §6 (`src/providers/ocl/f19/fluorineType.ts`): `hetero-F`, `CF3`, `CF2`, `aryl-F`, `acyl-F`, `vinyl-F`, `alkyl-F`, `other`.

Every other fluorinated molecule gets **no ¹⁹F shift** and one plain warning. It is never given a guess and never a HOSE-only value. Neither the model nor the table is consulted for it:

| Case | Warning |
| --- | --- |
| More than one fluorine environment | `NMR_F19_MULTIPLE_ENVIRONMENTS`: "¹⁹F prediction is limited to molecules with one fluorine environment in this version." |
| One environment, fluorine in separate fragments (for example two trifluoroacetate ions) | `NMR_F19_MULTIPLE_ENVIRONMENTS`: the same sentence, then "here the fluorine atoms are in N separate fragments, which this version does not treat as one environment." |
| One environment of another type | `NMR_F19_TYPE_NOT_PREDICTED`: "¹⁹F prediction covers CF3 groups only in this version; <type> is not predicted." (for example `aryl-F`) |

A molecule with no fluorine gets nothing for ¹⁹F and no ¹⁹F notice. ¹H, ¹³C and ³¹P behave exactly as before. A ¹⁹F request never touches their models, and their requests never load the ¹⁹F model or table.

### Measured accuracy (CF3 only)

Both figures describe the shipped combined predictor (the GNN with the gate-table HOSE fallback) on CF3 molecules given a shift. They describe this model release with this table only.

| Set | Figure |
| --- | --- |
| Gate (primary) | NMRShiftDB2 single-environment CF3 molecules (selected on the gate; the model and table did not train on it): MAE 3.47 ppm [95% interval 2.25, 5.02], 157 molecules |
| In-source test (secondary) | held-out NMRexp source files (10%, molecule-deduplicated), CF3: MAE 3.53 ppm [2.10, 5.23], 6,903 molecules |

- The intervals are the protocol's percentile bootstrap (§7: 1,000 resamples, groups are gate molecules or source keys).
- NMRShiftDB2 was never a training label or a table input, so the gate is independent of the model and the table. The type rule that picked CF3 was applied on that same gate, so the held-out NMRexp figure is the check that is independent of that choice.
- The NMRexp partition is held out by **source file**. The protocol does not claim paper-level independence (§3).
- These are not per-tier figures, and tiers are names, not probabilities. No percentage confidence is shown anywhere.
- The panel shows both figures, with their partitions, in its "¹⁹F GNN model (CF3 only)" section. It shows them only when the result names this exact model release (`chemdraft.gnn-shift-19F 19F-seed-1`, loaded only after its SHA-256 matched) and its ¹⁹F table carries the frozen input checksum. A HOSE-only fallback result shows the tier and no figures.

### Method

- **Features.** The same schema-1 featurizer as ¹H/¹³C ([gnn-features.md](gnn-features.md)). The model predicts each fluorine class on the node of its canonical representative fluorine atom.
- **Network and training.** The experiment's `py/train.py` at commit `3dcc982`, with the shipped ¹³C model's configuration: hidden 384, 8 layers, learning rate 0.002, `atoms_per_batch` 3072, at most 400 epochs, patience 25. Seeds 1, 2 and 3 were trained; seed 1 had the lowest validation MAE and is shipped unchanged (kept checkpoint SHA-256 `59923f6d…4afc`).
- **Data.** NMRexp ¹⁹F rows (Wang and Zhu, Zenodo `10.5281/zenodo.17296666`). They were cleaned to one fluorine environment and one peak per row (§2), split by source file (§3), identity-guarded against the in-source test, validation and the NMRShiftDB2 gate, collapsed per molecule and outlier-filtered (§4). The model trained on the training partition. Validation chose the seed and set the band.
- **HOSE fallback table.** The protocol's gate table: training plus validation rows (never in-source test rows). Spheres 4, 3, 2 and 1 come from the plugin's production environment codes. Environments need at least 5 observations after filtering, and the value is the median of the deepest matching sphere.
- **Export.** ONNX opset 17, with weights stored as fp16 and cast to fp32 inside the graph. The training normalization is built in (ppm = output × 22.115 − 76.224). The same inputs and output as the ¹³C model.

### Runtime

- **Lazy loading.** Nothing ¹⁹F loads at plugin start, for capabilities, or for ¹H/¹³C/³¹P. When ¹⁹F is requested:
  - for a molecule with no fluorine, or one the scope declines (more than one fluorine environment, fluorine in separate fragments, or a type other than CF3), nothing ¹⁹F loads;
  - for a single-environment CF3 molecule, the table and the training domain load first, because the decline assessment and the HOSE fallback need them. They form their own chunk, a dynamic import. If a domain rule declines the molecule, that is all that loads: the model and ONNX Runtime are never requested and the HOSE value is shown;
  - the model loads only when the GNN will run, after the domain assessment passes. It is fetched, checked and run by the same `GnnModelRuntime` as ¹H/¹³C.
- **Checksum.** The model's bytes must hash to the SHA-256 in `src/providers/gnn/modelRelease.ts` (`GNN_MODEL_FILES["19F"]`) before ONNX Runtime is even imported. A missing file, a mismatch, a runtime that fails to load, or a failure at inference makes the model unavailable. The class then takes the HOSE fallback, with `NMR_GNN_MODEL_UNAVAILABLE` or `NMR_GNN_INFERENCE_FAILED`.
- **Command.** **Analyze → Predict ¹⁹F NMR Shifts (CF3 only)**. It needs the same permissions as the other commands; `model.load` covers the bundled ¹⁹F model.

| File | SHA-256 |
| --- | --- |
| `src/providers/gnn/model-19F/19F.fp16.onnx` (5,128,032 bytes) | `fc2abb4f978b873fc899b8d57834c6df4daa19a1a2b23caf25ff58e388ea31aa` |
| `src/providers/gnn/model-19F/domain.json` | `add7e563af39fa8ebb33685d02dc7d86a0c3bd784455d7af7b837196fb19f0e7` |
| `src/providers/gnn/model-19F/hose-table.json` (533,804 bytes) | `ea9d980d8f924309afa2a7179e01f21cb576b17d56c295c423a86a89a3bce758` |

### Declines, fallback and tiers (protocol §5)

- **Declines.** These are the same five rules as ¹H/¹³C (`domainRules.assessNode`), read against the ¹⁹F model's own training domain (`model-19F/domain.json`). They are applied to every fluorine atom of the class and its neighbors: an element outside the featurizer's set or with fewer than 50 training atoms; an (element, charge, radical) state with fewer than 20; an isotope label other than ²H or ¹³C; a structure the featurizer cannot represent; more heavy atoms than the size limit, which is 64 for ¹⁹F. A declined class carries `NMR_GNN_DECLINED`, which names the rules.
- **Fallback.** A declined class, or the class when the model is unavailable or fails, takes the gate table's HOSE match. That match is labeled **HOSE lookup** and carries its own tier: low at sphere 1 or with fewer than 3 observations, high at sphere 3 or deeper with at least 8, medium otherwise. With no match, there is no shift (`NMR_NO_FRAGMENT_MATCH`). Values are never averaged.
- **Tiers of a GNN value.** The agreement band is **5.5 ppm**: the 90th percentile (nearest rank) of \|GNN − observed\| on non-declined validation observations, rounded up to the next 0.5 ppm. A HOSE match within the band gives **high** at sphere 3 or 4 and **medium** at sphere 1 or 2. Beyond the band, the GNN value is kept with tier **low**, the warning "model and reference lookup disagree" (`NMR_MODEL_LOOKUP_DISAGREEMENT`), and both values. With no HOSE match, the tier is **medium** when every member atom and its neighbors have at least 500 training atoms of their state, else **low**.

Every ¹⁹F resonance carries its method label (**GNN prediction** or **HOSE lookup**) and a tier.

### Verification

- **Numeric parity.** The fixture `src/tests/fixtures/gnn-onnx-reference-19F.json` holds seven validation molecules, labeled by their extraction record numbers. For each, it holds the packed input tensors, the schema-1 features and the outputs of `19F.fp16.onnx` under ONNX Runtime 1.19.2 on the CPU. ONNX Runtime Web (WASM, one thread) must match every node within 0.05 ppm. The largest difference measured was 2.1 × 10⁻⁴ ppm. `packGnnInputs` reproduces the fixture's tensors byte for byte (`src/tests/f19Runtime.test.ts`).
- **Export check.** The experiment compared the exported ONNX graph with the PyTorch checkpoint on all 13,552 validation molecules: mean 0.0033 ppm, maximum 0.049 ppm (`onnx/export_check.json`, limits 0.05 mean and 0.5 maximum).
- **Scope, fallback and loading.** `src/tests/f19Prediction.test.ts` covers the following:
  - a CF3 molecule is predicted;
  - CF2, aryl-F, hetero-F, acyl-F, vinyl-F, alkyl-F and two-environment molecules are declined with the exact warnings;
  - the scope agrees with `cleanRow` on a set of molecules;
  - a tampered, missing or failing model falls back to the HOSE lookup;
  - ¹H/¹³C/³¹P never load the ¹⁹F model or table;
  - the panel shows the figures only for this release.

### Licensing (¹⁹F)

The ¹⁹F model weights, training-domain counts and HOSE table are derived from **NMRexp** (Wang, Jun-Jie and Zhu, Rong; Zenodo, doi:10.5281/zenodo.17296666; dataset paper Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025), doi:10.1038/s41597-025-06245-5). They are under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/), never under the plugin's MIT code license and never under the nmrshiftdb2 Database License. Changes were made: rows were filtered, deduplicated, outlier-cleaned and transformed into HOSE statistics and GNN weights, and no structures are included. The notice is `src/providers/gnn/model-19F/NMREXP_LICENSE.md`. `package.json` declares the files under `dataLicenses`, `THIRD_PARTY_NOTICES.md` carries the credit, and the panel's reference-database section shows it for every ¹⁹F result. **NMRShiftDB2 was used only as the independent test gate.** It is not a source of the ¹⁹F model or table.

## Licensing

The ¹H/¹³C model weights and `model/domain.json` are fitted to NMRShiftDB2 assignments, so they are NMRShiftDB2-derived data under the **nmrshiftdb2 Database License (ODbL-derived)**, never under the plugin's MIT code license. `package.json` declares them under `dataLicenses`; the notice is `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`. ONNX Runtime Web is MIT-licensed by Microsoft; see `THIRD_PARTY_NOTICES.md`.
