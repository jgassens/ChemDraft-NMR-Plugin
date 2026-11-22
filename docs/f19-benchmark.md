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
   Because the key comes from one column with one rule, the same paper cannot appear under two
   spellings; supplement files of one paper share a key.
7. **Identity.** A stereo-free OpenChemLib idcode per molecule (as in the ³¹P benchmark).

NMRShiftDB2 gate records go through steps 2 and 5 (they are assigned, so steps 3 and 4 do not
apply). The shift of a fluorine class in a record is the median of its assignments. All gate
records with the same idcode are then collapsed: one gate observation per (idcode, fluorine
class), the median over its records. Gate molecules are labeled **single-environment** (one
fluorine class) or **multi-environment** (more than one); the two strata are scored separately
(§7).

## 3. Split (pre-registered)

Hash each row's source key (UTF-8) with SHA-256, read the first four bytes as an unsigned
big-endian integer and take it modulo 1000. Buckets below 100 are the **in-source test**
("held-out source papers, 10%, molecule-deduplicated"), 100 to 199 are **validation**, and the
rest are **train**.

Identity guards (applied to rows before anything is collapsed or trained):

- drop from train and validation every row whose idcode occurs in the in-source test;
- drop from train every row whose idcode occurs in validation;
- drop from train, validation and test every row whose idcode occurs among the gate molecules
  (both strata), so the model and every scored table have never seen a gate molecule.

## 4. Observations and table compilation (fixed order)

**Scored in-source test unit:** one observation per (idcode, source key) pair in the test
partition, the median of that pair's row shifts. Each observation belongs to exactly one source,
which the bootstrap resamples (§7). Validation observations are formed the same way.

**Table and training inputs.** Every HOSE table and the GNN training set are compiled in this
order:

1. **Identity exclusion** (§3).
2. **Molecule collapse.** One observation per idcode: the median of that molecule's row shifts
   across all of its sources, with spread (max − min), row count and the list of contributing
   source keys recorded.
3. **Outlier filtering (pre-registered; never applied to validation, test or gate
   observations).** Each sphere (4, 3, 2, 1) is filtered independently: for each environment at
   that sphere with at least 5 molecule observations, compute the median and the scaled MAD
   (1.4826 × median absolute deviation, floor 1 ppm) and drop observations more than 3 scaled
   MADs from the median. A drop removes the observation from that sphere's environment only.
   Drops are counted per sphere and per environment, and attributed once to each contributing
   source key; the most-affected source keys are listed by count only. **GNN training** uses the
   same filter: a training molecule is excluded from GNN training when the filter drops it at
   the deepest sphere whose environment has at least 5 observations.
4. **Minimum-n pruning** (tables only). Keep environments with at least 5 observations after
   filtering.

## 5. Predictor

The shipped ¹⁹F predictor has the same architecture as the shipped ¹H/¹³C predictor
(nmrexp-02): a trained per-atom GNN is the main predictor, and the plugin's HOSE lookup is its
cross-check and fallback.

**GNN.** The plugin's own featurizer (Path B, `docs/gnn-features.md`) extended to target ¹⁹F,
with a TypeScript/Python parity check on validation molecules passing before any training run.
Architecture, loss, optimizer and every hyperparameter are those of the shipped ¹³C model
(nmrexp-02's selected configuration), fixed; nothing is searched. Each training molecule labels
all of its fluorine atoms with its collapsed shift. Label centering and scaling are computed on
train. Three seeds (1, 2, 3) are trained on train only with early stopping on validation; the
seed with the lowest validation MAE is selected. The selected model is the shipped model (no
retraining on more data).

**HOSE lookup**, unchanged from ¹H/¹³C/³¹P: median from the deepest matching sphere (4 through
1), environments with at least 5 observations, tiers by sphere exactly as the production lookup
assigns them. No shift is ever produced for an unmatched environment.

| HOSE table | Built from | Used for |
|---|---|---|
| benchmark table | train | validation (band) and in-source test |
| gate table | train, validation and test, minus gate identities (§3) | gate |
| production table | all NMRexp rows | shipped fallback; not scored |

The production table contains NMRexp data only. NMRShiftDB2 ¹⁹F atoms stay the independent gate
and are not mixed into any table or into GNN training in this version.

**Combined predictor (what ships and what is scored).** The decline, fallback, tier and
disagreement rules of the experiment repository's `ABSTENTION.md` (commit `69463fb`), applied to
¹⁹F: domain counts (element, charge and radical state, size) come from the ¹⁹F training
partition; an atom the GNN declines, or every atom when the model is missing or fails its
checksum, falls back to HOSE; with no HOSE match it gets no shift. The **agreement band** is the
90th percentile of |GNN − observed| on validation, rounded up to 0.5 ppm. Tiers and the
disagreement warning follow `ABSTENTION.md` §3 and §4 with that band. Nothing is averaged.

## 6. Declining

**Multi-environment molecules.** The GNN is trained only on single-environment molecules but
predicts per atom. Multi-environment molecules ship only if their gate stratum passes rule 4 in
§7; otherwise the first version declines every molecule with more than one fluorine environment
(no shift, a warning naming the reason). A fluorine type that does not pass the type rule in §7,
including an unjudged type, is declined in production.

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

**Intervals.** Percentile bootstrap, 1000 resamples, seed 1, with the PRNG, the group draw and
the percentile method of `src/providers/ocl/benchmark.ts` at commit `eb5210a`: draw as many
groups as the scored set has, with replacement; every drawn group contributes all of its errors
(a group with none is drawn and contributes none); report the 2.5th and 97.5th percentiles.
Concretely: the generator is the 32-bit LCG `state = state × 1664525 + 1013904223 mod 2³²`
starting from 1; each draw picks group `floor(state / 2³² × groupCount)`; a resample with no
errors is skipped; the interval ends are the values at sorted positions `ceil(0.025 × n) − 1`
and `ceil(0.975 × n) − 1`. Groups are source keys for the in-source test and gate idcodes for the
gate, in byte-sorted order of the key. Paired comparisons use the same draws, computing both
sides on each resample.

**Type baseline ("no prediction" comparator).** For each fluorine type, predict the median shift
of that type over the train partition's collapsed molecule observations (after identity
exclusion and molecule collapse, before outlier filtering), scored on the same observations.

**Decision rule, fixed before opening:**

1. **Primary (gate, single-environment stratum).** The upper end of the 95% interval for the
   combined predictor's MAE is at most **B ppm**.
2. **Secondary (in-source test).** The same on the in-source test. If 1 passes and 2 fails, ¹⁹F
   does not ship in this version.
3. **Types.** A fluorine type ships only if, on the gate single-environment stratum, it has at
   least 20 scored molecules, the upper end of its combined MAE interval is at most B ppm, and
   the lower end of the paired interval for (baseline AE − combined AE) is above 0. Every other
   type, including one with fewer than 20 scored gate molecules ("unjudged"), is declined in this
   version.
4. **Multi-environment molecules.** They ship only if the gate multi-environment stratum has at
   least 20 molecules and the upper end of its combined MAE interval is at most B ppm; otherwise
   they are declined in this version.
5. Coverage is reported for every set and stratum; it is not a threshold.

No result in this section can be overridden after opening. Shipping anything that failed or was
unjudged needs a new pre-registered protocol scored on data not yet opened; every figure from this
protocol's sets is then reported as a non-independent opening.

**B = 7 ppm** (owner, 2026-11-22, set before any split and before either scored set was
opened). The scoring command reads B from the frozen record and refuses to run if it is not 7.

## 8. Opening

The split assignment (source key → partition) is computed only after this protocol is committed
and reviewed, and records this protocol's commit hash. Training and seed selection use train and
validation only. Before scoring, `freeze.json` records the SHA-256 of both source files, the split
assignment, the three HOSE tables, the selected model and its `domain.json`, the agreement band,
the featurizer parity result, the scoring code commit, and B. The in-source test and the gate are
each scored once. Any rerun after opening is reported as a second, non-independent opening, with
the first figures kept.

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
