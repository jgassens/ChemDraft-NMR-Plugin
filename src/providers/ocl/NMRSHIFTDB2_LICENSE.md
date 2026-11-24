# Reference database provenance & license

`nmrshiftdb2.database.json` is a **compiled data artifact**: aggregated HOSE-code →
chemical-shift statistics (median/mean/stdev/min/max/n per ¹H and ¹³C atom
environment). It is a *derivative database* built by ChemDraft from NMRShiftDB2 atom assignments (the database does not mark
which are experimental) — it contains **no structures**, only statistics.

| Field | Value |
|---|---|
| Asset | NMRShiftDB2 compiled HOSE-shift statistics (ChemDraft-derived) |
| Upstream source | NMRShiftDB2 — `nmrshiftdb2rawdata.nmredata.sd` (NMReDATA export) |
| Upstream URL | https://sourceforge.net/projects/nmrshiftdb2/files/data/ |
| Original authors | nmrshiftdb2 contributors |
| Upstream license | nmrshiftdb2 Database License (derived from ODbL) — https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/nmrshiftdb2datalicense.txt |
| Nuclei | ¹H, ¹³C |
| Modifications | Parsed atom assignments → OpenChemLib environment codes (spheres 1–4) → per-environment shift statistics. Raw structures discarded. |

## License terms (summary — the upstream text governs)

The nmrshiftdb2 Database License is ODbL-derived. It **permits use, including
commercial use**, with these obligations relevant here:

- **Share-alike:** a *derivative database* (this compiled artifact is one) must be
  offered under the same license. This compiled database is offered under the
  nmrshiftdb2 Database License linked above. This notice ships in the plugin
  package; the full governing terms are available at the upstream license URL.
- **Attribution:** credit nmrshiftdb2 (surfaced at runtime in the prediction
  panel's "Reference database" section).
- **Open-source prediction software:** software relying on the database for
  prediction must be under an OSI-approved license — satisfied (this plugin's
  **code** is MIT/open-source; the database is tracked as a separate data asset).

Rebuild with `scripts/build-database.ts` from the upstream NMReDATA export.

## GNN shift model weights (also NMRShiftDB2-derived)

The plugin also bundles a trained graph neural network (GNN) for ¹H and ¹³C shifts. Its
weights were fitted to NMRShiftDB2 atom assignments, so they are treated as NMRShiftDB2-derived
data and are offered under the **same nmrshiftdb2 Database License** as the statistics above,
never under the plugin's MIT code license. The same share-alike, attribution and
open-source-software terms apply.

| Field | Value |
|---|---|
| Asset | GNN shift model weights (ONNX, fp16-stored) and training-domain counts (ChemDraft-derived) |
| Files | `src/providers/gnn/model/1H.fp16.onnx`, `src/providers/gnn/model/13C.fp16.onnx`, `src/providers/gnn/model/domain.json` |
| In the package | `1H.fp16-*.onnx` and `13C.fp16-*.onnx` at the ZIP root; the domain counts are compiled into `nmrWorker-*.js` and `GnnShiftPredictor-*.js` |
| Upstream source | NMRShiftDB2 — `nmrshiftdb2rawdata.nmredata.sd` (NMReDATA export, SHA-256 `831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720`) |
| Original authors | nmrshiftdb2 contributors |
| Upstream license | nmrshiftdb2 Database License (derived from ODbL) — https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/nmrshiftdb2datalicense.txt |
| Modifications | Training-partition records of a Murcko-scaffold split → plugin-computed atom and bond features → per-atom GNN regression (experiment run nmrexp-02). `domain.json` holds per-element and per-charge-state training atom counts and a size percentile. No structures are stored. |

To ship a purely permissive/attribution-only alternative, swap in a CC BY 4.0
corpus such as NMRexp (see ADR-0014); the engine is unchanged.
