# Follow-ups

Planned work that is decided but not started. Nothing here ships until its own check passes.

## 1.3 experiment: numbered NMReDATA spectra in the 1H/13C table

**Finding (2026-11-21, measurement only, nothing changed).** The NMReDATA label reader
(`extractTag` / `parseSpectrumLabels` in `src/providers/ocl/nmredata.ts`) reads only the first
spectrum of each kind (`NMREDATA_1D_13C`, `NMREDATA_1D_1H`) and skips numbered repeats (`#2`, `#3`,
...). In the NMRShiftDB2 corpus the shipped table is built from, 4,427 records have extra 13C
spectra and 101 have extra 1H spectra. Of the 39,387 skipped 13C assignments, 6,889 repeat spectrum
#1 within 0.1 ppm, 32,813 give the same atom a different shift (median difference 0.88 ppm, likely
another solvent or condition), and 613 cover atoms spectrum #1 leaves unassigned (1H: 436, 260 and
96 of 496). Including them would add up to 5,794 13C and 106 1H table entries (41,874 today) and move
1,210 13C medians by more than 1 ppm. The effect on accuracy is not measured.

**Plan.**
1. Build two candidate tables: "drop duplicates of spectrum #1" and "all spectra, one median per
   atom per record".
2. Rerun the existing benchmark on its existing held-out partition for both candidates and the
   current table, and state that partition with every figure.
3. Adopt a candidate only if it beats the current table on that partition without making the
   worst-covered element worse.
4. Apply the same reader change to the GNN training extract (`node/extract.ts` in the experiment
   repo) inside this experiment only, not before.

Until then, the shipped table and its checksum-gated accuracy figures stay as they are.
