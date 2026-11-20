# Charge-aware ¹H and ¹³C HOSE environments

On 2026-11-20, the owner decided to encode the formal charge of every neighbor at every sphere for ¹H and ¹³C. This is a correctness fix decided before seeing the new benchmark results. The previous codes could pool observations for charged and neutral neighbors. All three nuclei now use the same charge-aware encoder. An omitted neighbor charge represents zero for ¹H and ¹³C, preserving their neutral codes. The ³¹P keys continue to spell out zero as `q0`.

## Benchmark partition

The benchmark splits the full NMRShiftDB2 NMReDATA export by OpenChemLib structure idcode. It computes a 32-bit FNV-1a hash of `${idcode}#${seed}`, takes the unsigned remainder modulo 1000, and holds out buckets below `holdOutPerMille`. Both runs use seed `1` and `holdOutPerMille = 20`. Duplicate structures go to the same partition and unparseable records stay in training. The 64,710 usable records split into 63,372 training records (including 6 unparseable records) and 1,338 held-out records.

The benchmark compiles statistics only from the training partition and keeps environments with at least five observations. Held-out assignments use the median shift from the deepest available sphere (4 through 1). Coverage is the fraction of held-out assignments with a match. Each tier's count is its matched subset, and error statistics use matched assignments only. A match is low tier at sphere 1 or with fewer than three observations, high tier at sphere 3 or 4 with at least eight observations, and medium tier otherwise.

## Before and after

For ¹H and ¹³C, the before values are the published 2026-09-25 benchmark and the after values are from the 2026-11-20 rerun. Each table cell gives before → after.

### ¹H

Coverage 99.2% → 98.7% (2,684 → 2,673 of 2,707 assignments across 376 structures).

| Match tier | Matched | MAE (ppm) | Median AE (ppm) | P90 AE (ppm) |
| --- | ---: | ---: | ---: | ---: |
| All | 2,684 → 2,673 | 0.361 → 0.358 | 0.17 → 0.17 | 0.92 → 0.92 |
| High | 987 → 976 | 0.21 → 0.207 | 0.08 → 0.08 | 0.49 → 0.489 |
| Medium | 1,178 → 1,172 | 0.341 → 0.332 | 0.17 → 0.17 | 0.802 → 0.78 |
| Low | 519 → 525 | 0.694 → 0.695 | 0.51 → 0.51 | 1.53 → 1.49 |

### ¹³C

Coverage 99.4% → 99.3% (7,234 → 7,227 of 7,280 assignments across 795 structures).

| Match tier | Matched | MAE (ppm) | Median AE (ppm) | P90 AE (ppm) |
| --- | ---: | ---: | ---: | ---: |
| All | 7,234 → 7,227 | 3.563 → 3.517 | 1.57 → 1.56 | 8.8 → 8.69 |
| High | 2,585 → 2,579 | 1.531 → 1.507 | 0.68 → 0.66 | 4.32 → 4.32 |
| Medium | 3,230 → 3,210 | 3.172 → 3.071 | 1.78 → 1.747 | 7.5 → 7.35 |
| Low | 1,419 → 1,438 | 8.152 → 8.117 | 5.6 → 5.51 | 18.22 → 17.88 |

### ³¹P

The published ³¹P results are from **held-out source references, 10%, molecule-deduplicated**. Coverage is 94.6% (5,278/5,577 assignments). [³¹P benchmark protocol](p31-benchmark.md)

| Match tier | Matched | MAE (ppm) | Median AE (ppm) | P90 AE (ppm) |
| --- | ---: | ---: | ---: | ---: |
| All | 5,278 → 5,278 | 7.565 → 7.565 | 2.23 → 2.23 | 17.5 → 17.5 |
| High | 886 → 886 | 1.727 → 1.727 | 0.93 → 0.93 | 3.52 → 3.52 |
| Medium | 1,700 → 1,700 | 4.92 → 4.92 | 1.58 → 1.58 | 8.24 → 8.24 |
| Low | 2,692 → 2,692 | 11.158 → 11.158 | 4.2 → 4.2 | 27.5 → 27.5 |

## Test expectations changed

All 14 affected tests passed on the parent commit (`1de50a9`). Comparing its serialized outputs against the charge-aware build showed identical environment codes throughout. All ten fixtures in [deuterium.test.ts](../src/tests/deuterium.test.ts) produced byte-identical SVGs and the same predicted shifts. Their reports show the new benchmark date (2026-11-20), including a ¹³C median absolute error of 1.56 ppm (previously 1.57). The ¹H benchmark row changed only in date.

| Test in `deuterium.test.ts` | Reason for the changed expectation |
| --- | --- |
| `preserves all bytes for 'CCO'` | Ethanol's sphere-1 methyl ¹H count fell from 3,696 to 3,681 and its ¹³C count fell from 6,312 to 6,310. The excluded observations had a +1 carbon neighbor. The methyl ¹H standard deviation fell from 0.30 to 0.27 ppm and the maximum fell from 3.90 to 3.70 ppm. The result and report digests changed. |
| `preserves all bytes for 'CC'` | Ethane's report digest changed only for the benchmark rows. |
| `preserves all bytes for 'CC(C)Br'` | The sphere-1 methyl ¹³C count for 2-bromopropane fell from 7,324 to 7,323 when the observation with a −1 carbon neighbor moved to its own key. The result and report digests changed. |
| `preserves all bytes for 'CC=O'` | Acetaldehyde matches the same sphere-1 methyl ¹³C key as 2-bromopropane. The count fell from 7,324 to 7,323, changing the result and report digests. |
| `preserves all bytes for 'Cc1ccccc1'` | Toluene's sphere-2 meta ¹H count fell from 4,929 to 4,927 when two observations with a −1 aromatic carbon neighbor moved to their own key. The standard deviation fell from 0.33 to 0.32 ppm. The result and report digests changed. |
| `preserves all bytes for 'c1ccccc1'` | Benzene's report digest changed only for the benchmark rows. |
| `preserves all bytes for 'OCCO'` | Ethylene glycol's report digest changed only for the benchmark rows. |
| `preserves all bytes for 'C[C@H](Br)[C@H](Br)C'` | The 2,3-dibromobutane report digest changed only for the benchmark rows. |
| `preserves all bytes for 'CC(=O)C'` | Acetone's report digest changed only for the benchmark rows. |
| `preserves all bytes for 'C1CCCCC1'` | Cyclohexane's report digest changed only for the benchmark rows. |

| Test | Reason for the changed expectation |
| --- | --- |
| [`deuteratedEnvironments.test.ts`](../src/tests/deuteratedEnvironments.test.ts), `matches the unlabelled ethanol serialization baseline` | The host-molfile request includes OH. Its result digest reflects the methyl statistics above and the OH reference change detailed below. |
| [`phosphorusPrediction.test.ts`](../src/tests/phosphorusPrediction.test.ts), `preserves the serialized 1H/13C result from the existing ethanol baseline with the bundled P table` | In both builds the result matched the SMILES ethanol fixture byte for byte. This test uses the shared result digest updated for the two methyl reference populations. |
| [`composePredictionReport.test.ts`](../src/tests/composePredictionReport.test.ts), `shows the held-out benchmark line when the database checksum matches the benchmarked corpus` | The only serialized change was the ¹³C benchmark row. The 2026-11-20 rerun reports 1.56 ppm median absolute error and high/medium/low medians of 0.66/1.747/5.51 ppm. |
| [`oclHosePredictor.test.ts`](../src/tests/oclHosePredictor.test.ts), `uses the bundled NMRShiftDB2 database and surfaces its provenance` | The charge-aware compiler split pooled environments, increasing the pre-prune count from 533,324 to 537,122 and the retained count from 41,851 to 41,874. The provenance note and generation timestamp also reflect the rebuild. Both versions use the same corpus checksum and five-observation cutoff. |

The host-molfile OH resonance was the sole predicted shift change. Replaying the pinned export with both encoders traced two observations from the neutral sphere-1 key `1H@Oq0h1(1Ch2)` to `1H@Oq0h1(1Cq1h2)`. The two assignments were 13.85 ppm from NMRShiftDB2 record `20171716` (assignment `s4`, atom 28) and 11.60 ppm from record `20175140` (assignment `s3`, atom 27). Both have a +1 carbon neighbor. The new key has two observations and is pruned at the five-observation cutoff. The neutral key still matches ethanol's OH, with 416 → 414 observations, a median of 3.46 → 3.45 ppm, a standard deviation of 1.52 → 1.38 ppm, and a maximum of 13.85 → 9.95 ppm. The middle observations changed from 3.45 and 3.46 ppm to two at 3.45 ppm, which accounts for the change in the rounded median and the low-confidence warning that displays it.

## Reproduce

Set `NMRSHIFTDB2_SD` to the read-only `nmrshiftdb2.nmredata.sd` export (284,380,903 bytes, SHA-256 `831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720`). The shipped table uses the full corpus.

```sh
NODE_OPTIONS=--max-old-space-size=6144 node --import tsx scripts/build-database.ts \
  "$NMRSHIFTDB2_SD" src/providers/ocl/nmrshiftdb2.database.json --min-observations 5

NODE_OPTIONS=--max-old-space-size=6144 node --import tsx scripts/run-benchmark.ts \
  "$NMRSHIFTDB2_SD" --seed 1 --hold-out-per-mille 20 --min-observations 5 \
  --statistic median --json charge-aware-benchmark.json
```
