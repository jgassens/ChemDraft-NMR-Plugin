# ¹⁹F GNN and HOSE benchmark (pre-registered protocol)

Status: **protocol only.** Written and committed before any split assignment is computed and
before any test or gate data is scored. Nothing in this file may change after the split is
computed. The owner's shipping band B (§7) was set to 7 ppm before the split. Any later change is recorded under "Changes after the split" with its reason, and every
figure produced after it is reported as a non-independent opening.

## 1. Sources

- **Training and in-source test: NMRexp.** Wang, Jun-Jie and Zhu, Rong, Zenodo
  `10.5281/zenodo.17296666`, CC BY 4.0. File `NMRexp_10to24_1_1004.parquet`, 661,259,287 bytes,
  MD5 `2f9ed8bc533364dfb9dce96c83703dd4`, SHA-256
  `f438d0052f3b36594e35f7141257b1533be2ec5f1680019e62ee556964281b7d`, 3,372,987 rows. Rows are
  literature-mined (molecule from image recognition, peaks from Supporting Information text) and
  carry no atom assignment and no per-row referencing standard. Columns used: `Filename`,
  `SMILES`, `NMR_type`, `NMR_solvent`, `NMR_processed`. The authors' `Atom_number_diff_env` is not
  used; the environment rule below uses the plugin's own symmetry classes.
- **Independent gate: NMRShiftDB2 ¹⁹F assignments**, from the same NMReDATA export the plugin's
  ¹H/¹³C table is built from (`scripts/build-database.ts`), atom-assigned. Its SHA-256 is
  recorded in `freeze.json` (§8).

Predictions do not condition on solvent. ¹⁹F shifts are taken as reported, on the CFCl₃ = 0 ppm
scale; rows referenced otherwise cannot be detected per row and are left to the outlier rule
(§4). The CDCl₃ fraction of kept rows is reported.

## 2. Cleaning (every NMRexp row, before the split)

Every drop is counted by reason.

1. Keep rows with `NMR_type` exactly `19F NMR`.
2. Parse `SMILES` with the plugin's OpenChemLib path. Drop rows that fail to parse, whose
   molecule has no fluorine, or in which more than one disconnected fragment contains fluorine.
   From here on the **molecule is the fluorine-bearing fragment only**; other fragments
   (counterions, solvent) are removed before every later step, so a salt and its fluorinated
   component have the same identity.
3. **Single environment.** Group the molecule's fluorine atoms by the plugin's stereo-free
   constitutional symmetry classes (`prepareProductionLookup`, `src/providers/ocl/productionLookup.ts`).
   Keep only molecules whose fluorines all fall in one class.
4. **Single peak.** `NMR_processed` is a Python-literal list of `(shift, multiplicity, J)`
   tuples. Parse it with a literal parser (never evaluated as code). Each tuple's shift is either a
   number, or a two-number list `[a, b]` read as a range; a range with |a − b| > 1 ppm drops the
   row, otherwise its value is the midpoint. Any other shape drops the row. With the values
   v₁…vₙ (n ≥ 1): keep the row only if max(v) − min(v) ≤ 0.05 ppm, and its shift is then the
   median of the values. Rows with no values, or a spread above 0.05 ppm, are dropped.
5. Drop rows whose shift lies outside −300 to +250 ppm.
6. **Source key.** `Filename` (the DOI with `/` written as `_`, or a publisher supplement name),
   lowercased and trimmed, with one trailing `_moesm<digits>_esm`, `_si_<digits>` or
   `-sup-<digits>-misc_information` removed. Every row has a `Filename`; no row is dropped here.
   Supplement files of one paper that differ only by these suffixes share a key; other ways one
   paper could appear under two keys are not detected (§3).
7. **Identity.** Two idcodes of the fluorine-bearing fragment: the **stereo-free idcode** (as
   in the ³¹P benchmark), used for every identity guard and for HOSE-table collapse; and the
   **stereo idcode** (OpenChemLib's default idcode, keeping R/S and E/Z), used for GNN
   observations, so every GNN observation has exactly one input graph.

NMRShiftDB2 gate records go through steps 2 and 7 (they are assigned, so steps 3 and 4 do not
apply). Every parsed gate record, before any label filtering, defines the gate identities and
gate DOIs used by the §3 guards. A gate **class** is a fluorine symmetry class of the
fluorine-bearing fragment, keyed by (stereo idcode, the lowest **canonical** atom index among the
class's members in OpenChemLib's canonical numbering of that fragment); each record's assigned
atoms are mapped into that canonical numbering first, so records that number their atoms
differently join on the same key. Then, in this order: each assignment value outside −300 to
+250 ppm is dropped (step 5 applied per assignment); a class's shift in a record is the median of
its remaining assignments; a class's gate observation is the median over all records with that
key. A class with no remaining assignment has no observation; drops are counted. Gate molecules with one fluorine class form the
**single-environment stratum**; the rest form the **multi-environment stratum**, which is
reported descriptively only (§6, §7).

## 3. Split (pre-registered)

Hash each row's source key (UTF-8) with SHA-256, read the first four bytes as an unsigned
big-endian integer and take it modulo 1000. Buckets below 100 are the **in-source test**, 100 to
199 are **validation**, and the rest are **train**. The partition is named "held-out source
files, 10%, molecule-deduplicated" with every figure.

**What the split guarantees, stated exactly.** Rows sharing a normalized source key (§2.6) never
cross partitions. Two different keys that belong to the same paper (for example a DOI-named file
and a publisher-supplement-named file of one article) are not merged, because the pinned file
has no other source metadata; this residual is reported as the count of non-DOI-shaped source
keys. Paper-level independence is therefore not claimed; the claims are source-file and
molecular independence.

Identity guards (stereo-free idcode, applied to rows before anything is collapsed or trained):

- drop from train and validation every row whose idcode occurs in the in-source test;
- drop from train every row whose idcode occurs in validation;
- drop from train, validation and test every row whose idcode occurs among the gate molecules
  (both strata);
- **gate source overlap:** where a gate record carries a DOI, normalize it exactly as §2.6
  (lowercase, `/` written as `_`, trimmed) and drop from train, validation and test every row
  whose source key equals one of those DOIs. The number of gate DOIs, matched keys and dropped
  rows is reported. Gate records without a DOI are kept; their count is reported.

## 4. Observations and compilation (fixed order)

**Scored in-source test and validation unit:** one observation per (stereo idcode, source key)
pair in that partition, the median of the pair's row shifts. Each observation belongs to exactly
one source, which the bootstrap resamples (§7).

Every HOSE table and the GNN training set are compiled in this order:

1. **Identity exclusion** (§3).
2. **Collapse.** HOSE tables: one observation per stereo-free idcode, the median of its row
   shifts across all of its sources. GNN training: one observation per stereo idcode, the median
   of its row shifts. Spread (max − min), row count and contributing source keys are recorded.
3. **Outlier filtering (pre-registered; never applied to validation, test or gate
   observations).** Each sphere (4, 3, 2, 1) is filtered independently: for each environment at
   that sphere with at least 5 molecule observations (stereo-free collapse), compute the median
   and the scaled MAD (1.4826 × median absolute deviation, floor 1 ppm) and drop observations
   more than 3 scaled MADs from the median. A drop removes the observation from that sphere's
   environment only. Drops are counted per sphere and per environment and attributed once to
   each contributing source key; the most-affected source keys are listed by count only.
   **GNN training** excludes a stereo idcode when its stereo-free molecule is dropped at the
   deepest sphere whose environment has at least 5 observations; a molecule with no such sphere
   is kept.
4. **Minimum-n pruning** (tables only). Keep environments with at least 5 observations after
   filtering.

## 5. Predictor

The shipped ¹⁹F predictor has the same architecture as the shipped ¹H/¹³C predictor: a trained
per-atom GNN is the main predictor and the plugin's HOSE lookup is its cross-check and fallback.
**What ships is exactly what the gate scores**: the selected model with the gate table.

| HOSE table | Rows (after §3 guards and §4) | Used for |
|---|---|---|
| benchmark table | train | every validation and in-source-test prediction path: the band, the disagreement check, tiers and fallback |
| gate table | train + validation (never in-source test rows) | every gate prediction path, and the shipped fallback |

Validation labels enter the gate table as table inputs only. In-source test rows are never an
input to any table or model, so nothing in the in-source test can influence which types are
eligible; the gate table and its diagnostics are never used for training, seed selection, the
band or the in-source test. NMRShiftDB2 ¹⁹F data are never a table input or a training label.

**HOSE lookup statistic:** search spheres 4, 3, 2, 1 in that order; the prediction is the
**median** of the deepest sphere with a surviving environment (after §4 pruning). Its tier is the
production `benchmarkTier`: **low** when the sphere is 1 or the environment has fewer than 3
observations, **high** when the sphere is at least 3 and it has at least 8, **medium**
otherwise.

**GNN.**

- Featurizer: the plugin's Path B featurizer (`docs/gnn-features.md`), extended to target ¹⁹F.
  The model predicts each class from its canonical representative atom.
- **Parity gate (pass/fail, before any training run):** for every validation molecule, the
  TypeScript featurizer and the Python training pipeline produce byte-identical packed feature
  tensors and identical target-node indices for every fluorine atom. Any mismatch stops the run.
- Training code and configuration, fixed: the experiment repository's `py/train.py` at commit
  `3dcc982`, with the configuration of the shipped ¹³C model as recorded in that repository's
  `runs/nmrexp-02/selection.json` (SHA-256
  `b485f1c658a225aa30156136ac4874bf5e20b123be059ee54a2a85a489124651`): hidden 384, layers 8,
  learning rate 0.002, at most 400 epochs, patience 25, bf16, `atoms_per_batch` 3072 (the
  shipped ¹³C model's value), on H200 GPUs. If a run cannot fit, it stops; no setting is changed.
  Nothing is searched.
- Labels: each training observation labels every fluorine atom of its molecule with the
  observation's shift. Label center and scale are computed by `py/train.py` over training
  fluorine atoms after the §4 exclusions.
- Early stopping: after each epoch, validation MAE over validation observations (each weighted
  once, predicted at its class representative); the checkpoint with the strictly lowest value is
  kept; stop after 25 epochs without improvement or at 400.
- Seeds 1, 2 and 3; the seed whose kept checkpoint has the lowest validation MAE is selected; a
  tie goes to the lower seed. The selected model is the shipped model; nothing is retrained.

**Decline rules** (the conditions of the plugin's `src/providers/gnn/domainRules.ts`, listed
here in this document's own order, applied to every member atom of the class and its heavy
neighbors; counts from the training graphs after the §4 exclusions, stored in
the model's `domain.json`). The GNN declines a class when, for any member atom:

1. the atom or a heavy neighbor has an element outside the featurizer's known set, or an element
   with fewer than 50 training atoms;
2. its (element, formal charge, radical state) has fewer than 20 training atoms;
3. the atom or a neighbor carries an isotope other than ²H or ¹³C (tritium included, even when
   folded into a hydrogen count);
4. the featurizer cannot represent the graph or the node is missing;
5. the molecule has more heavy atoms than min(500, the nearest-rank 99.9th percentile of
   training molecules).

**Fallback.** A declined class, or every class when the model is missing, fails its checksum or
fails at inference, takes the HOSE match of the table assigned to that path above (benchmark
table for validation and the in-source test, gate table for the gate and in production) with
its `benchmarkTier` tier, labeled "HOSE lookup"; with no match it gets no shift. Nothing is ever
averaged.

**Agreement band:** with the selected model and the benchmark table, the nearest-rank 90th
percentile of |GNN − observed| over non-declined validation observations (each weighted once),
rounded up to the next 0.5 ppm.

**Tiers for a GNN prediction:** with a HOSE match, |GNN − HOSE| ≤ band gives **high** at sphere 3
or 4 and **medium** at sphere 1 or 2; |GNN − HOSE| strictly above the band keeps the GNN value,
gives **low**, and adds the warning "model and reference lookup disagree" with both values.
Without a HOSE match: **medium** when every member atom of the class and every heavy neighbor
of every member has an (element, charge, radical) state with at least 500 training atoms,
otherwise **low**.

## 6. Declining in the shipped predictor

Every molecule with more than one fluorine environment is declined in this version (no shift, a
warning naming the reason). Its gate stratum is scored and reported but cannot make it ship. A
fluorine type that does not pass the type rule in §7, including an unjudged type, is declined in
production.

**Fluorine types**, by the atom the fluorine is bonded to, assigned by the first rule that
applies, in this order:

1. `hetero-F`: a non-carbon atom.
2. `CF3`: an sp³ carbon bearing three F.
3. `CF2`: an sp³ carbon bearing two F.
4. `aryl-F`: an aromatic carbon.
5. `acyl-F`: a carbon double-bonded to oxygen.
6. `vinyl-F`: any other non-aromatic sp² carbon.
7. `alkyl-F`: an sp³ carbon bearing one F.
8. `other`: anything else.

## 7. Metrics and decision rule

For each scored set and stratum, named with its partition on every figure: coverage (observations
given a shift over scored observations), MAE, RMSE, median AE and P90 AE over observations given
a shift; the same by tier, by method actually used (GNN or HOSE fallback) and by fluorine type.
GNN-alone and HOSE-alone figures on the same observations are reported beside the combined
predictor; only the combined predictor is judged.

**Intervals.** Percentile bootstrap, 1000 resamples, seed 1: draw as many groups as the scored
set has, with replacement; every drawn group contributes all of its errors (a group with none is
drawn and contributes none); a resample with no errors is skipped. The generator is the 32-bit
LCG `state = state × 1664525 + 1013904223 mod 2³²` starting from 1; each draw picks group
`floor(state / 2³² × groupCount)`; the interval ends are the values at sorted positions
`ceil(0.025 × n) − 1` and `ceil(0.975 × n) − 1`. Groups are source keys for the in-source test
and gate stereo idcodes for the gate, in byte-sorted order of the key. Paired comparisons use the
same draws, computing both sides on each resample. **Every comparison in the decision rule uses
unrounded values; rounding is for display only.**

**Type baseline ("no prediction" comparator).** For each fluorine type, predict the median shift
of that type over the train partition's stereo-free collapsed observations (after identity
exclusion, before outlier filtering), scored on the same observations.

**Decision rule, fixed before opening.** Applied in this order:

1. **Types (gate, single-environment stratum).** A fluorine type is *eligible* only if at least
   20 distinct gate molecules of that type receive both a combined prediction and a baseline
   prediction, the upper end of its combined MAE interval is at most B ppm, and the lower end of
   the paired interval for (baseline AE − combined AE) is strictly above 0. A type that fails,
   has fewer than 20 such molecules, or has an undefined interval ("unjudged") is declined in
   this version.
2. **Primary (gate, single-environment stratum, eligible types only).** At least 20 distinct gate
   molecules of eligible types receive a shift, and the upper end of the 95% interval for the
   combined MAE over them is at most **B ppm**. Because the eligible types were chosen on the
   same gate, this figure is labeled "selected on the gate"; rule 3 is the independent check.
3. **Secondary (in-source test, eligible types only).** At least 20 distinct in-source test
   molecules of eligible types receive a shift, and the upper end of the 95% interval for the
   combined MAE over them is at most B ppm.

¹⁹F ships, for the eligible types only, if at least one type is eligible and rules 2 and 3 both
pass; otherwise it does not ship in this version. Every coverage and error figure is reported
twice and labeled: over all types ("before the type filter") and over eligible types ("shipped
types"). In addition, for the gate and the in-source test, **shipped coverage** is reported:
observations that receive a shipped prediction (single-environment molecule of an eligible type,
given a shift) over all scored observations of that set, both strata and all types included.
Coverage is never a threshold. The multi-environment stratum's figures are labeled
"diagnostic: not shipped"; the shipped predictor's coverage of multi-environment molecules is
zero in this version, and the stratum never changes a decision.

No result in this section can be overridden after opening. Shipping anything that failed or was
unjudged needs a new pre-registered protocol scored on data not yet opened; every figure from this
protocol's sets is then reported as a non-independent opening.

**B = 7 ppm** (owner, 2026-11-22, set before any split and before either scored set was
opened). The scoring command reads B from the frozen record and refuses to run if it is not 7.

## 8. Opening

The split assignment (source key → partition) is computed only after this protocol is committed
and reviewed, and records this protocol's commit hash. Training, seed selection and the band use
train and validation only. Before scoring, `freeze.json` records the SHA-256 of both source files,
the split assignment, both HOSE tables, the selected model, its `domain.json`, the band, the
parity result, the scoring code commit, and B. The in-source test and the gate are each scored
once. Any rerun after opening is reported as a second, non-independent opening, with the first
figures kept.

## 9. Data licenses and credit

- **NMRexp: CC BY 4.0.** Its conditions are attribution conditions, so they are met in full,
  not treated as a blocker. When a ¹⁹F table ships, its `dataLicenses` entry in `package.json`
  (with `attribution` and `url`), a `THIRD_PARTY_NOTICES.md` paragraph and a bundled notice file
  carry, as CC BY 4.0 §3(a) requires:
  - the creators: Wang, Jun-Jie and Zhu, Rong; NMRexp; Zenodo, doi:10.5281/zenodo.17296666;
    dataset paper Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025),
    doi:10.1038/s41597-025-06245-5;
  - any copyright, license and disclaimer notices supplied with the deposit, reproduced as
    supplied;
  - the license name and URI, https://creativecommons.org/licenses/by/4.0/;
  - the changes: rows filtered (single fluorine environment, single peak), deduplicated, cleaned
    by the outlier rule, and transformed into aggregated HOSE shift statistics and GNN model weights; no
    structures are included.
  This is kept separate from the MIT code license.
- **NMRShiftDB2**: used only as the gate in this version; not in any ¹⁹F table or in GNN training. If a
  later version ships its ¹⁹F atoms, that table carries the NMRShiftDB2 license and attribution
  obligations in full.
- **Terms that are not attribution-only.** The Scientific Data article text is CC BY-NC-ND;
  nothing is copied from it (only its citation is used). The Zenodo deposit is CC BY 4.0, with no
  non-commercial or no-derivatives term. If a later check finds one, the work stops and goes to
  the owner.
