# NMRexp-derived ¹⁹F model and HOSE statistics: attribution and license

The ¹⁹F predictor's bundled files are derived from **NMRexp**:

- `src/providers/gnn/model-19F/19F.fp16.onnx`: GNN shift model weights
- `src/providers/gnn/model-19F/domain.json`: the model's training-domain counts
- `src/providers/gnn/model-19F/hose-table.json`: aggregated ¹⁹F HOSE shift statistics

They are data derived from NMRexp under **CC BY 4.0**. They are separate from the plugin's MIT code
license and from the nmrshiftdb2 Database License of the ¹H/¹³C files.

## CC BY 4.0 attribution

Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0):
https://creativecommons.org/licenses/by/4.0/

- **Creators.** Wang, Jun-Jie and Zhu, Rong.
- **Work.** NMRexp, Zenodo, DOI 10.5281/zenodo.17296666
  (https://doi.org/10.5281/zenodo.17296666). File used:
  `NMRexp_10to24_1_1004.parquet` (SHA-256
  `f438d0052f3b36594e35f7141257b1533be2ec5f1680019e62ee556964281b7d`).
- **Dataset paper.** Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025),
  DOI 10.1038/s41597-025-06245-5. Only its citation is used; no article text is copied.
- **License notice.** The NMRexp deposit is published on Zenodo under CC BY 4.0. Its notices are
  carried here as this credit, the license name and the license link above.
- **Disclaimer.** The licensed material is offered as-is and as-available, with no warranties, as
  stated in Section 5 of the CC BY 4.0 license.

**Change notice.** Changes were made. Only the ¹⁹F rows were used. They were filtered to molecules
with a single fluorine environment and a single reported peak, deduplicated, and cleaned by a
pre-registered outlier rule (docs/f19-benchmark.md, §2 and §4). They were then transformed into
aggregated HOSE environment shift statistics and into the weights of a graph neural network, with
its training-domain counts. The files hold no structures and no original records. They are not
endorsed by the dataset's creators.

## What NMRShiftDB2 did and did not contribute

NMRShiftDB2 ¹⁹F assignments were used only as the test gate that decided whether ¹⁹F
ships, and for which fluorine type (CF3). They are not a source of the ¹⁹F model, its
training-domain counts or the ¹⁹F HOSE table: none of them was trained on or compiled from
NMRShiftDB2 shifts.
