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

## Reproduce

Set `NMRSHIFTDB2_SD` to the read-only `nmrshiftdb2.nmredata.sd` export (284,380,903 bytes, SHA-256 `831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720`). The shipped table uses the full corpus.

```sh
NODE_OPTIONS=--max-old-space-size=6144 node --import tsx scripts/build-database.ts \
  "$NMRSHIFTDB2_SD" src/providers/ocl/nmrshiftdb2.database.json --min-observations 5

NODE_OPTIONS=--max-old-space-size=6144 node --import tsx scripts/run-benchmark.ts \
  "$NMRSHIFTDB2_SD" --seed 1 --hold-out-per-mille 20 --min-observations 5 \
  --statistic median --json charge-aware-benchmark.json
```
