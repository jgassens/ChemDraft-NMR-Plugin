# ³¹P HOSE benchmark

## Split (pre-registered)

Group each Ilm-NMR-P31 SDF entry by its CSV `ref` string, lowercased with each run of whitespace collapsed to one space and leading and trailing whitespace removed. For `NA` or empty references, use `stem:` followed by the SDF file stem with its trailing `-CMP<n>` removed. Hash the UTF-8 key with SHA-256, interpret the first four bytes as an unsigned big-endian integer, and take its remainder modulo 1000. Hold out entries with buckets below 100 and assign the others to training.

Compute a stereo-free OpenChemLib idcode for every entry. Drop every training entry whose idcode also occurs in the test set. Keep the held-out entries as assigned by reference. Compile the benchmark table from the remaining training entries and keep environments with at least five observations. The bundled production table uses all entries and applies the same cutoff, as does the bundled ¹H/¹³C table.

Use median lookup from the deepest available match (spheres 4 through 1). Compute errors over matched assignments. Use a percentile bootstrap with 1000 resamples and seed 1. Draw as many source groups as are in the held-out partition, with replacement, and carry all matched errors in each drawn group into the replicate. Report the 2.5th and 97.5th percentiles.

## Results

Partition **held-out source references, 10%, molecule-deduplicated**. The 43,317-entry corpus yielded 5,189 held-out structures across 758 source groups. After dropping 1,074 training entries with a held-out structure identity, 37,054 training entries remained. The five-observation cutoff retained 4,480 training environments.

In **held-out source references, 10%, molecule-deduplicated**, the lookup matched 4,812 of 5,577 phosphorus observations, for coverage of 0.863. Each assignment contributes one observation per listed phosphorus symmetry class.

Match errors for **held-out source references, 10%, molecule-deduplicated**.

| Match tier | Matched | MAE (ppm) | RMSE (ppm) | Median AE (ppm) | P90 AE (ppm) |
| --- | ---: | ---: | ---: | ---: | ---: |
| All | 4812 | 6.817 | 18.357 | 2.335 | 15.45 |
| High | 1198 | 1.923 | 5.652 | 0.96 | 3.5 |
| Medium | 1899 | 3.773 | 14.056 | 1.55 | 6.4 |
| Low | 1715 | 13.608 | 26.542 | 7.8 | 27.11 |

The source-group bootstrap 95% intervals for **held-out source references, 10%, molecule-deduplicated** are [5.633, 8.076] ppm for MAE and [14.054, 22.445] ppm for RMSE.

Hack et al. (2023) reported HOSE MAE 11.9 ppm and RMSE 27.1 ppm using a different split. The figures are not directly comparable. [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y)

### Changes after review

An early run on **held-out source references, 10%, molecule-deduplicated** reported coverage of 0.949, MAE of 7.599 ppm, and RMSE of 19.857 ppm. A subsequent rerun encoded phosphorus neighbor charges and counted each phosphorus symmetry class once per assignment, using the same pre-registered split and lookup settings.

On 2026-11-20, the benchmark adopted the bundled table's five-observation cutoff for **held-out source references, 10%, molecule-deduplicated**, keeping the pre-registered split. The prior figures used an unpruned training table and reported 5,278 matches out of 5,577 observations (94.6%), an MAE of 7.565 ppm, an RMSE of 20.002 ppm, and a median absolute error of 2.23 ppm. The cutoff can move a prediction to a shallower sphere or leave an observation unmatched. The revised figures measure lookup under the rule used in production.

## Reproduce

Set `ILM_P31` to the checkout directory of `clacor/Ilm-NMR-P31` at `ead6f914d2bdfb60e4befea72ea503d32978d358`. The pinned CSV uses numeric R row names and puts the SDF stem in the named `num` column. The join reads `ref` and `LM` by name. `LM` is used for metadata counts. Predictions do not condition on solvent.

```sh
mkdir -p local-data
node --import tsx scripts/run-benchmark.ts "$ILM_P31/SDFs" \
  --metadata "$ILM_P31/Ilm-NMR-P31.csv" \
  --json local-data/ilm-nmr-p31.benchmark.json
```

To rebuild the bundled production table from all SDF entries, run:

```sh
node --import tsx scripts/build-database.ts "$ILM_P31/SDFs" \
  src/providers/ocl/ilm-nmr-p31.database.json --min-observations 5
```

The scripts hash the exact bytes in byte-sorted filename order and insert a `$$$$` terminator or linefeed where one is missing. The pinned files are already terminated. Parsing realigns over-width V2000 atom fields in memory. On OpenChemLib stereo perception failure for a V2000 record with no property records, parsing retries without stereo coordinates and preserves the atom and bond records. The hash covers the original bytes.

## Data license

- **Name and path** Ilm-NMR-P31-derived ³¹P HOSE shift statistics, `src/providers/ocl/ilm-nmr-p31.database.json`. The table contains aggregated statistics only. [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y)
- **Source** `clacor/Ilm-NMR-P31` at commit `ead6f914d2bdfb60e4befea72ea503d32978d358`. [Pinned GitHub source](https://github.com/clacor/Ilm-NMR-P31/tree/ead6f914d2bdfb60e4befea72ea503d32978d358)
- **License** BSD-3-Clause, copyright (c) 2026 Robert Geitner. Redistributed with the author's permission (owner, 2026-11-20). The final declaration is under `dataLicenses` in `package.json`. [Bundled license text](../src/providers/ocl/ILM_NMR_P31_LICENSE.md)
- **Published archive** Zenodo `10.5281/zenodo.8260783` is the 2023 release of 14,250 entries under CC BY 4.0. [Versioned Zenodo record](https://doi.org/10.5281/zenodo.8260783)
- **Paper's data availability** Hack et al. make the underlying Ilm-NMR-P31 dataset publicly available. The publication's companion repository points readers to Zenodo for the archived data. [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y) · [Publication repository](https://github.com/jcheminform/Ilm-NMR-P31)
- **Source handbooks** The paper describes shifts transcribed from *Landolt-Boernstein* (2014) and *Handbook of ³¹P NMR Data* (1991). [Hack et al. (2023)](https://doi.org/10.1186/s13321-023-00792-y)
