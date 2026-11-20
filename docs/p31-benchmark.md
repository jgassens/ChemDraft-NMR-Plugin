# ³¹P HOSE benchmark

## Split (pre-registered)

Group each Ilm-NMR-P31 SDF entry by its CSV `ref` string, lowercased with each run of whitespace collapsed to one space and leading and trailing whitespace removed. For `NA` or empty references, use `stem:` followed by the SDF file stem with its trailing `-CMP<n>` removed. Hash the UTF-8 key with SHA-256, interpret the first four bytes as an unsigned big-endian integer, and take its remainder modulo 1000. Hold out entries with buckets below 100 and assign the others to training.

Compute a stereo-free OpenChemLib idcode for every entry. Drop every training entry whose idcode also occurs in the test set. Keep the held-out entries as assigned by reference. Compile the benchmark table from the remaining training entries and the local production table from all entries.

Use median lookup from the deepest available match (spheres 4 through 1), retaining all observed training environments. Compute errors over matched assignments. Use a percentile bootstrap with 1000 resamples and seed 1. Draw as many source groups as are in the held-out partition, with replacement, and carry all matched errors in each drawn group into the replicate. Report the 2.5th and 97.5th percentiles.

## Results

Partition **held-out source references, 10%, molecule-deduplicated**. The 43,317-entry corpus yielded 5,189 held-out structures across 758 source groups. After dropping 1,074 training entries with a held-out structure identity, 37,054 training entries remained.

In **held-out source references, 10%, molecule-deduplicated**, the lookup matched 5,278 of 5,577 phosphorus observations, for coverage of 0.946. Each assignment contributes one observation per listed phosphorus symmetry class.

Match errors for **held-out source references, 10%, molecule-deduplicated**.

| Match tier | Matched | MAE (ppm) | RMSE (ppm) | Median AE (ppm) | P90 AE (ppm) |
| --- | ---: | ---: | ---: | ---: | ---: |
| All | 5278 | 7.565 | 20.002 | 2.23 | 17.5 |
| High | 886 | 1.727 | 3.42 | 0.93 | 3.52 |
| Medium | 1700 | 4.92 | 18.025 | 1.58 | 8.24 |
| Low | 2692 | 11.158 | 23.987 | 4.2 | 27.5 |

The source-group bootstrap 95% intervals for **held-out source references, 10%, molecule-deduplicated** are [6.309, 8.86] ppm for MAE and [16.097, 23.623] ppm for RMSE.

Hack et al. (2023) reported HOSE MAE 11.9 ppm and RMSE 27.1 ppm using a different split. The figures are not directly comparable. [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y)

### Changes after review

The previous run on **held-out source references, 10%, molecule-deduplicated** reported coverage of 0.949, MAE of 7.599 ppm, and RMSE of 19.857 ppm. Code review found two correctness defects. The rerun encodes phosphorus neighbor charges and counts each phosphorus symmetry class once per assignment, using the same pre-registered split and lookup settings.

## Reproduce

Set `ILM_P31` to the checkout directory of `clacor/Ilm-NMR-P31` at `ead6f914d2bdfb60e4befea72ea503d32978d358`. The pinned CSV uses numeric R row names and puts the SDF stem in the named `num` column. The join reads `ref` and `LM` by name. `LM` is used for metadata counts. Predictions do not condition on solvent.

```sh
mkdir -p local-data
node --import tsx scripts/run-benchmark.ts "$ILM_P31/SDFs" \
  --metadata "$ILM_P31/Ilm-NMR-P31.csv" \
  --json local-data/ilm-nmr-p31.benchmark.json
node --import tsx scripts/build-database.ts "$ILM_P31/SDFs" \
  local-data/ilm-nmr-p31.database.json
```

The scripts hash the exact bytes in byte-sorted filename order and insert a `$$$$` terminator or linefeed where one is missing. The pinned files are already terminated. Parsing realigns over-width V2000 atom fields in memory. On OpenChemLib stereo perception failure for a V2000 record with no property records, parsing retries without stereo coordinates and preserves the atom and bond records. The hash covers the original bytes.

Rebuild any local ³¹P table generated before the review fixes to pick up the revised environment codes. For local predictions, read the generated JSON and pass the compiled table as `new OclHosePredictor({ phosphorusDatabase })`. Request `nuclei: ["31P"]`. The worker handler also accepts a `createPredictor` factory that can supply the table. The table lives in gitignored `local-data/` and stays outside the installable package.

## Data license (pending owner decision)

**DRAFT `dataLicenses` entry for owner review**

- **Name and path** Ilm-NMR-P31-derived ³¹P HOSE shift statistics, `local-data/ilm-nmr-p31.database.json`.
- **License status** Pending owner decision. The pinned GitHub repository carries a BSD-3-Clause notice, copyright (c) 2026 Robert Geitner. [Pinned GitHub license](https://github.com/clacor/Ilm-NMR-P31/blob/ead6f914d2bdfb60e4befea72ea503d32978d358/LICENSE)
- **Published archive** Zenodo `10.5281/zenodo.8260783` is the 2023 release of 14,250 entries under CC BY 4.0. [Versioned Zenodo record](https://doi.org/10.5281/zenodo.8260783)
- **Paper's data availability** Hack et al. make the underlying Ilm-NMR-P31 dataset publicly available. The publication's companion repository points readers to Zenodo for the archived data. [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y) · [Publication repository](https://github.com/jcheminform/Ilm-NMR-P31)
- **Source handbooks** The paper describes shifts transcribed from *Landolt-Boernstein* (2014) and *Handbook of ³¹P NMR Data* (1991). [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y)
