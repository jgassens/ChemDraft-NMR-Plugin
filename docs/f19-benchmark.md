# ¹⁹F HOSE benchmark (pre-registered protocol)

Status: **protocol only.** Written and committed before any split assignment is computed and
before any test or gate data is scored. Nothing in this file may change after the split is
computed except the owner's shipping band (§7), which must be set before either test set is
opened. Any later change is recorded under "Changes after the split" with its reason, and every
figure produced after it is reported as a non-independent opening.

## 1. Sources

- **Training and in-source test: NMRexp.** Wang, Jun-Jie and Zhu, Rong, Zenodo
  `10.5281/zenodo.17296666`, CC BY 4.0. Rows are literature-mined (molecule from image
  recognition, peak list from Supporting Information text). Rows carry no atom assignment and no
  per-row referencing standard. The exact file used and its SHA-256 are recorded in the build log
  and in `freeze.json` (§8) before the split is computed.
- **Independent gate: NMRShiftDB2 ¹⁹F assignments**, from the same NMReDATA export the plugin's
  ¹H/¹³C table is built from (`scripts/build-database.ts`), atom-assigned. Its file SHA-256 is
  recorded the same way.

Predictions do not condition on solvent. ¹⁹F shifts are taken as reported, on the CFCl₃ = 0 ppm
scale; rows referenced otherwise are not detectable per row and are left to the outlier rule
(§4). The CDCl₃ fraction of kept rows is reported.

## 2. Cleaning (applied to every NMRexp ¹⁹F row before the split)

Every drop is counted by reason.

1. Keep rows whose nucleus is ¹⁹F.
2. Parse the SMILES with the plugin's OpenChemLib path. Drop rows that fail to parse, whose
   molecule has no fluorine, or that contain more than one disconnected fragment with fluorine.
3. **Single environment.** Group the molecule's fluorine atoms by the plugin's own constitutional
   symmetry classes (the classes the lookup uses for equivalent nuclei). Keep only molecules whose
   fluorines all fall in ONE class.
4. **Single peak.** Parse the row's ¹⁹F peak list into shift values. A value written as a range
   `a–b` counts as one peak at its midpoint when |a − b| ≤ 1 ppm; a wider range drops the row.
   Values within 0.05 ppm of each other count as one peak. Keep only rows with exactly one peak.
5. Drop rows whose shift lies outside −300 to +250 ppm.
6. **Source key.** The row's source DOI, lowercased, trimmed, with a leading `https://doi.org/`,
   `http://dx.doi.org/`, `https://dx.doi.org/` or `doi:` removed. Rows without a DOI are dropped.
7. **Identity.** A stereo-free OpenChemLib idcode per molecule (as in the ³¹P benchmark).

NMRShiftDB2 gate records go through steps 2, 3 and 5 (they are assigned, so step 4 does not
apply; repeat assignments of one fluorine class within one record take their median). Gate
molecules with more than one fluorine environment are counted and not scored: the first version
declines them by design (§6).

## 3. Split (pre-registered)

Hash each row's source key (UTF-8) with SHA-256, read the first four bytes as an unsigned
big-endian integer, take it modulo 1000, and hold out rows with buckets below 100 as the
**in-source test** ("held-out source papers, 10%, molecule-deduplicated"). All others are
training.

Leakage guards:

- Drop every training row whose idcode occurs in the in-source test.
- For the gate table (§5), drop every NMRexp row whose idcode occurs in the scored gate set.

Within each partition, collapse rows to **one observation per molecule**: the median of that
molecule's shifts, with the spread (max − min) and row count recorded.

## 4. Outlier rule (pre-registered; training data only)

Applied when compiling a table, never to test or gate observations. For each HOSE environment at
each sphere (4, 3, 2, 1) with at least 5 molecule observations: compute the median and the scaled
MAD (1.4826 × median absolute deviation, with a floor of 1 ppm), and drop observations more than
3 scaled MADs from the median. The environment's stored statistics are computed over the kept
observations, and the 5-observation cutoff (§5) is applied after dropping. Drops are counted per
sphere-4 environment and per source DOI, and the DOIs with the most drops are listed by count
only.

## 5. Predictor

The plugin's HOSE lookup, unchanged from ¹H/¹³C/³¹P: median from the deepest matching sphere
(4 through 1), environments with at least 5 observations, tiers by sphere exactly as the
production lookup assigns them. No shift is ever produced for an unmatched environment. Nothing
in this protocol is tuned; there is no validation partition.

Three tables are compiled with the same code and rules:

| Table | Built from | Scored on |
|---|---|---|
| benchmark table | NMRexp training partition | in-source test |
| gate table | all NMRexp rows minus gate identities | NMRShiftDB2 gate |
| production table | all NMRexp rows (plus the NMRShiftDB2 ¹⁹F atoms as a separate, labeled source if step 5 decides so) | not scored |

## 6. Declining

The first version declines every molecule with more than one fluorine environment (no shift, a
warning naming the reason), in prediction as in training. A fluorine type that fails the type
rule in §7 is declined in production too.

**Fluorine types**, by the atom the fluorine is bonded to: `CF3` (sp³ carbon bearing three F),
`CF2` (sp³ carbon bearing two F), `alkyl-F` (sp³ carbon bearing one F), `aryl-F` (aromatic
carbon), `vinyl-F` (non-aromatic sp² carbon), `acyl-F` (carbonyl carbon), `hetero-F` (any
non-carbon atom), `other` (anything else).

## 7. Metrics and decision rule

For each scored set, named with its partition on every figure: coverage (matched molecules over
scored molecules), MAE, RMSE, median AE and P90 AE over matched molecules; the same by tier and by
fluorine type. 95% intervals by percentile bootstrap, 1000 resamples, seed 1, resampling source
DOIs for the in-source test and molecules for the gate.

**Type baseline ("no prediction" comparator).** For each fluorine type, predicting the median
shift of that type in the table's own training data, scored on the same matched molecules.

**Decision rule, fixed before opening:**

1. **Primary (gate).** On the NMRShiftDB2 gate, the upper end of the 95% interval for MAE over
   matched molecules is at most **B ppm**.
2. **Secondary (in-source).** The same for the in-source test. If 1 passes and 2 fails, the
   result goes to the owner; it does not ship by default.
3. **Types.** A fluorine type ships only if its gate MAE is below its type-baseline MAE. A type
   with fewer than 20 matched gate molecules is reported as "unjudged" and goes to the owner.
4. Coverage on both sets is reported; it is not a threshold.

**B = TBD-owner.** The owner sets B before either test set is opened. The scoring command refuses
to run while B is unset.

## 8. Opening

The split assignment (source key → partition) is computed only after this protocol is committed,
and records this protocol's commit hash. Before scoring, `freeze.json` records the SHA-256 of
both source files, the split assignment, the three tables, the scoring code commit, and B. The
in-source test and the gate are each scored once. Any rerun after opening is reported as a
second, non-independent opening, with the first figures kept.

## 9. Data licenses and credit

- **NMRexp**: CC BY 4.0, which asks only for credit, so it is credited: Wang, Jun-Jie and Zhu,
  Rong, NMRexp, Zenodo, doi:10.5281/zenodo.17296666, CC BY 4.0; dataset paper Wang, J.-J., Jin,
  Y., Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025), doi:10.1038/s41597-025-06245-5.
  Changes: rows were filtered (single fluorine environment, single peak), deduplicated, cleaned by
  the outlier rule, and transformed into aggregated HOSE shift statistics; no structures are
  included. When a ¹⁹F table ships, the same credit becomes its `dataLicenses` entry in
  `package.json` (with `attribution` and `url`), a `THIRD_PARTY_NOTICES.md` paragraph, and its
  notice file, separate from the MIT code license and the NMRShiftDB2 terms.
- **NMRShiftDB2**: already declared for the ¹H/¹³C table (nmrshiftdb2 Database License,
  ODbL-derived); if its ¹⁹F atoms enter the production table, that table's entry names both
  sources.
- **Terms that are not credit-only.** The Scientific Data article text is CC BY-NC-ND; nothing
  is copied from it (only its citation is used). No non-commercial or no-derivatives term applies
  to the NMRexp data deposit itself. If a later check finds one, the work stops and it goes to
  the owner.
