# GNN shift predictor (¹H and ¹³C)

Since experiment run nmrexp-02, a per-atom graph neural network (GNN) is the plugin's main ¹H and ¹³C predictor. The HOSE lookup over NMRShiftDB2 statistics stays as the cross-check and the fallback. ³¹P is unchanged: HOSE lookup over the Ilm-NMR-P31 table only.

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
- **Size.** About 19 MB inside the package: the two models (2.3 MB ¹H, 5.1 MB ¹³C), the WebAssembly binary (11.2 MB), its loader module (21 KB) and the runtime's JavaScript (47 KB).

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
- The stereo and second-order disclosure notices are computed by the HOSE engine for the classes it emits. A class the GNN predicts but the HOSE engine omitted gets no such notice.
- Equivalent atoms that differ only in configuration (for example the two carbinol carbons of a meso diol) share one resonance, valued at the representative atom.
- Schema 1 does not distinguish ring cis/trans configurations or enhanced stereo (see [gnn-features.md](gnn-features.md)), and the model sees no solvent.

## Licensing

The model weights and `domain.json` are fitted to NMRShiftDB2 assignments, so they are NMRShiftDB2-derived data under the **nmrshiftdb2 Database License (ODbL-derived)**, never under the plugin's MIT code license. `package.json` declares them under `dataLicenses`; the notice is `src/providers/ocl/NMRSHIFTDB2_LICENSE.md`. ONNX Runtime Web is MIT-licensed by Microsoft; see `THIRD_PARTY_NOTICES.md`.
