import * as OCL from "openchemlib";

import { normalizeStructure } from "../../../application/normalizeStructure";
import { prepareProductionLookup } from "../productionLookup";
import { fluorineType, type FluorineType } from "./fluorineType";

/**
 * NMRexp ¹⁹F cleaning, docs/f19-benchmark.md §2 steps 2–7. Step 1 (`NMR_type` exactly `19F NMR`)
 * is applied by scripts/f19/extract_nmrexp_19f.py, which also parses `NMR_processed` with a
 * literal parser and hands over each tuple's first element as JSON.
 */

/** One row as written by the extractor. */
export interface ExtractedRow {
  /** 0-based row index in the parquet. */
  row: number;
  filename: string;
  smiles: string | null;
  solvent: string | null;
  /** Each `NMR_processed` tuple's first element; null when the column did not parse. */
  peaks: unknown[] | null;
  parseError: string | null;
}

export interface CleanedRecord {
  row: number;
  sourceKey: string;
  idcode: string;
  shift: number;
  solvent: string | null;
  /** Number of fluorine atoms in the molecule (all in one symmetry class). */
  fluorineAtoms: number;
  fluorineType: FluorineType;
}

/** Fixed drop reasons, in the order the rules are applied. */
export const DROP_REASONS = [
  // §2.2
  "smiles-unparseable",
  "no-fluorine",
  "fluorine-in-multiple-fragments",
  // §2.3 (symmetry classes could not be prepared, then more than one class)
  "symmetry-classes-failed",
  "multiple-fluorine-environments",
  // §2.4
  "peaks-unparseable",
  "no-peak-values",
  "peak-shape",
  "peak-range-too-wide",
  "peak-spread",
  // §2.5
  "shift-out-of-range",
  // §2.7 (OpenChemLib could not produce an idcode)
  "idcode-failed"
] as const;

export type DropReason = (typeof DROP_REASONS)[number];
export type PeakDropReason = Extract<DropReason, "no-peak-values" | "peak-shape" | "peak-range-too-wide" | "peak-spread">;

export const MAX_RANGE_WIDTH_PPM = 1;
export const MAX_PEAK_SPREAD_PPM = 0.05;
export const MIN_SHIFT_PPM = -300;
export const MAX_SHIFT_PPM = 250;
/**
 * Shifts are reported as decimals, so differences such as 120.05 − 120.00 can land a few ulps
 * above 0.05 in binary floating point. The tolerance only absorbs that representation error; it is
 * eight orders of magnitude below the 0.001 ppm a reported value can resolve.
 */
const DECIMAL_TOLERANCE = 1e-9;

/** §2.6: lowercase, trim, then remove ONE trailing supplement suffix. */
export function sourceKey(filename: string): string {
  return filename
    .toLowerCase()
    .trim()
    .replace(/(?:_moesm\d+_esm|_si_\d+|-sup-\d+-misc_information)$/, "");
}

/** §2.4: the row's single shift from its tuples' shift elements, or the reason it drops. */
export function peakShift(peaks: readonly unknown[]): { shift: number } | { drop: PeakDropReason } {
  if (peaks.length === 0) return { drop: "no-peak-values" };
  const values: number[] = [];
  for (const peak of peaks) {
    if (isFiniteNumber(peak)) {
      values.push(peak);
    } else if (Array.isArray(peak) && peak.length === 2 && isFiniteNumber(peak[0]) && isFiniteNumber(peak[1])) {
      const [a, b] = peak;
      if (Math.abs(a - b) > MAX_RANGE_WIDTH_PPM + DECIMAL_TOLERANCE) return { drop: "peak-range-too-wide" };
      values.push((a + b) / 2);
    } else {
      return { drop: "peak-shape" };
    }
  }
  if (Math.max(...values) - Math.min(...values) > MAX_PEAK_SPREAD_PPM + DECIMAL_TOLERANCE) {
    return { drop: "peak-spread" };
  }
  return { shift: median(values) };
}

/** §2.7: stereo-free OpenChemLib idcode, as in the ³¹P benchmark (`benchmark.ts`). */
export function stereoFreeIdcode(molecule: OCL.Molecule): string {
  return new OCL.Canonizer(molecule, { neglectAnyStereoInformation: true }).getIDCode();
}

/** §2.2–2.7 in protocol order. */
export function cleanRow(row: ExtractedRow): CleanedRecord | { drop: DropReason } {
  // §2.2 parse through the plugin's structure path.
  let molecule: OCL.Molecule;
  try {
    if (typeof row.smiles !== "string") return { drop: "smiles-unparseable" };
    molecule = normalizeStructure({ format: "smiles", value: row.smiles }).molecule;
  } catch {
    return { drop: "smiles-unparseable" };
  }
  const fluorines: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 9) fluorines.push(atom);
  }
  if (fluorines.length === 0) return { drop: "no-fluorine" };
  const fragmentNo = new Array<number>(molecule.getAllAtoms()).fill(-1);
  molecule.getFragmentNumbers(fragmentNo, false, false);
  if (new Set(fluorines.map((atom) => fragmentNo[atom])).size > 1) {
    return { drop: "fluorine-in-multiple-fragments" };
  }

  // §2.3 the production lookup's stereo-free constitutional classes: atoms of one class share a
  // representative.
  let representatives: Set<number>;
  try {
    const context = prepareProductionLookup(molecule);
    representatives = new Set(fluorines.map((atom) => context._representativeByAtom[atom]));
  } catch {
    return { drop: "symmetry-classes-failed" };
  }
  if (representatives.size !== 1) return { drop: "multiple-fluorine-environments" };

  // §2.4 single peak.
  if (row.peaks === null || !Array.isArray(row.peaks)) return { drop: "peaks-unparseable" };
  const peak = peakShift(row.peaks);
  if ("drop" in peak) return peak;

  // §2.5 range, inclusive at both ends.
  if (!(peak.shift >= MIN_SHIFT_PPM && peak.shift <= MAX_SHIFT_PPM)) return { drop: "shift-out-of-range" };

  // §2.6 never drops.
  const key = sourceKey(row.filename);

  // §2.7 identity.
  let idcode: string;
  try {
    idcode = stereoFreeIdcode(molecule);
  } catch {
    return { drop: "idcode-failed" };
  }
  if (!idcode) return { drop: "idcode-failed" };

  return {
    row: row.row,
    sourceKey: key,
    idcode,
    shift: peak.shift,
    solvent: row.solvent,
    fluorineAtoms: fluorines.length,
    fluorineType: fluorineType(molecule, fluorines[0])
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
