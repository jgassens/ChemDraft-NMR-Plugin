# ¹⁹F HOSE benchmark (pre-registered protocol)

Status: **protocol only.** Written and committed before any split assignment is computed and
before any test or gate data is scored. Nothing in this file may change after the split is
computed except the owner's shipping band B (§7), which must be set before either scored set is
opened. Any later change is recorded under "Changes after the split" with its reason, and every
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

NMRShiftDB2 gate records go through steps 2, 3 and 5. They are assigned, so the shift of a record
is the median of its assignments to the single fluorine class. All gate records with the same
idcode are then collapsed to one gate molecule: the median over its records. Gate molecules with
more than one fluorine environment are counted and not scored (§6).

## 3. Split (pre-registered)

Hash each row's source key (UTF-8) with SHA-256, read the first four bytes as an unsigned
big-endian integer, take it modulo 1000, and hold out rows with buckets below 100 as the
**in-source test** ("held-out source papers, 10%, molecule-deduplicated"). All others are
training.

## 4. Observations and table compilation (fixed order)

**Scored in-source test unit:** one observation per (idcode, source key) pair in the test
partition, the median of that pair's row shifts. Each observation belongs to exactly one source,
which the bootstrap resamples (§7).

**Table inputs.** Every table is compiled in this order:

1. **Identity exclusion.** Benchmark table: drop training rows whose idcode occurs in the
   in-source test. Gate table: drop NMRexp rows whose idcode occurs among the scored gate
   molecules. Production table: none.
2. **Molecule collapse.** One observation per idcode: the median of that molecule's row shifts
   across all of its sources, with spread (max − min), row count and the list of contributing
   source keys recorded.
3. **Outlier filtering (pre-registered; table inputs only, never scored observations).** Each
   sphere (4, 3, 2, 1) is filtered independently: for each environment at that sphere with at
   least 5 molecule observations, compute the median and the scaled MAD (1.4826 × median absolute
   deviation, floor 1 ppm) and drop observations more than 3 scaled MADs from the median. A drop
   removes the observation from that sphere's environment only; it stays in the other spheres'
   environments unless their own filtering drops it. Drops are counted per sphere and per
   environment, and attributed once to each contributing source key; the most-affected source
   keys are listed by count only.
4. **Minimum-n pruning.** Keep environments with at least 5 observations after filtering.

## 5. Predictor

The plugin's HOSE lookup, unchanged from ¹H/¹³C/³¹P: median from the deepest matching sphere
(4 through 1), tiers by sphere exactly as the production lookup assigns them. No shift is ever
produced for an unmatched environment. Nothing in this protocol is tuned; there is no validation
partition.

| Table | Built from | Scored on |
|---|---|---|
| benchmark table | NMRexp training partition | in-source test |
| gate table | all NMRexp rows minus gate identities | NMRShiftDB2 gate |
| production table | all NMRexp rows | not scored |

The production table contains NMRexp data only. NMRShiftDB2 ¹⁹F atoms stay the independent gate
and are not mixed into any table in this version.

## 6. Declining

The first version declines every molecule with more than one fluorine environment (no shift, a
warning naming the reason), in prediction as in training. A fluorine type that does not pass the
type rule in §7, including an unjudged type, is declined in production.

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

For each scored set, named with its partition on every figure: coverage (matched observations
over scored observations), MAE, RMSE, median AE and P90 AE over matched observations; the same by
tier and by fluorine type.

**Intervals.** Percentile bootstrap, 1000 resamples, seed 1, with the PRNG, the group draw and
the percentile method of `src/providers/ocl/benchmark.ts` at commit `eb5210a`: draw as many
groups as the scored set has, with replacement; every drawn group contributes all of its matched
errors (a group with no matches is drawn and contributes none); report the 2.5th and 97.5th
percentiles. Concretely: the generator is the 32-bit LCG `state = state × 1664525 + 1013904223
mod 2³²` starting from 1; each draw picks group `floor(state / 2³² × groupCount)`; a resample with
no matched errors is skipped; the interval ends are the values at sorted positions
`ceil(0.025 × n) − 1` and `ceil(0.975 × n) − 1`. Groups are source keys for the in-source test
and gate idcodes for the gate, in byte-sorted order of the key. The paired type comparison in
rule 3 uses the same draws, computing both MAEs on each resample.

**Type baseline ("no prediction" comparator).** For each fluorine type, predict the median shift
of that type over the table's collapsed molecule observations (after identity exclusion and
molecule collapse, before outlier filtering), scored on the same matched observations.

**Decision rule, fixed before opening:**

1. **Primary (gate).** On the NMRShiftDB2 gate, the upper end of the 95% interval for MAE over
   matched molecules is at most **B ppm**.
2. **Secondary (in-source).** The same for the in-source test. If 1 passes and 2 fails, the
   ¹⁹F does not ship in this version.
3. **Types.** A fluorine type ships only if, on the gate, it has at least 20 matched molecules,
   the upper end of its MAE interval is at most B ppm, and the lower end of the paired bootstrap
   interval for (baseline AE − lookup AE), same resamples, is above 0. Every other type,
   including one with fewer than 20 matched gate molecules ("unjudged"), is declined in this
   version.

No result in this section can be overridden after opening. Shipping a failed or unjudged type, or
¹⁹F after a failed rule, needs a new pre-registered protocol scored on data not yet opened; every
figure from this protocol's sets is then reported as a non-independent opening.
4. Coverage on both sets is reported; it is not a threshold.

**B = TBD-owner.** The owner sets B before either scored set is opened. The scoring command
refuses to run while B is unset.

## 8. Opening

The split assignment (source key → partition) is computed only after this protocol is committed
and reviewed, and records this protocol's commit hash. Before scoring, `freeze.json` records the
SHA-256 of both source files, the split assignment, the three tables, the scoring code commit,
and B. The in-source test and the gate are each scored once. Any rerun after opening is reported
as a second, non-independent opening, with the first figures kept.

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
    by the outlier rule, and transformed into aggregated HOSE shift statistics; no structures are
    included.
  This is kept separate from the MIT code license.
- **NMRShiftDB2**: used only as the gate in this version and not shipped in any ¹⁹F table. If a
  later version ships its ¹⁹F atoms, that table carries the NMRShiftDB2 license and attribution
  obligations in full.
- **Terms that are not attribution-only.** The Scientific Data article text is CC BY-NC-ND;
  nothing is copied from it (only its citation is used). The Zenodo deposit is CC BY 4.0, with no
  non-commercial or no-derivatives term. If a later check finds one, the work stops and goes to
  the owner.
