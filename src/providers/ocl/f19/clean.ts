import * as OCL from "openchemlib";

import { normalizeStructure } from "../../../application/normalizeStructure";
import { prepareProductionLookup, productionClassRepresentative } from "../productionLookup";
import { fluorineType, type FluorineType } from "./fluorineType";

/**
 * NMRexp ¹⁹F cleaning, docs/f19-benchmark.md §2 steps 2–7. Step 1 (`NMR_type` exactly `19F NMR`)
 * is applied by scripts/f19/extract_nmrexp_19f.py, which also parses `NMR_processed` with a
 * literal parser and hands over each tuple's first element as JSON, every number as its shortest
 * round-trip decimal string (Python `repr`).
 */

/** One row as written by the extractor. */
export interface ExtractedRow {
  /** 0-based row index in the parquet. */
  row: number;
  filename: string;
  smiles: string | null;
  solvent: string | null;
  /**
   * Each `NMR_processed` tuple's first element, numbers as decimal strings; null when the column did
   * not parse.
   */
  peaks: unknown[] | null;
}

export interface CleanedRecord {
  row: number;
  sourceKey: string;
  /** §2.7 stereo-free idcode of the fluorine-bearing fragment: identity guards, HOSE-table collapse. */
  stereoFreeIdcode: string;
  /** §2.7 OpenChemLib's default idcode of that fragment (keeps R/S and E/Z): GNN observations. */
  stereoIdcode: string;
  shift: number;
  solvent: string | null;
  /** Number of fluorine atoms in the fragment (all in one symmetry class). */
  fluorineAtoms: number;
  fluorineType: FluorineType;
  /** Number of other fragments (counterions, solvent) removed by §2.2. */
  removedFragments: number;
}

/** Fixed drop reasons, in the order the rules are applied. */
export const DROP_REASONS = [
  // §2.2
  "smiles-unparseable",
  "no-fluorine",
  "fluorine-in-multiple-fragments",
  // §2.2 (OpenChemLib could not remove the other fragments)
  "fragment-extraction-failed",
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

/**
 * §2.4 limits, as exact decimal strings. Shifts are reported as decimals, and a binary-float
 * difference such as 120.15 − 120.10 can land a few ulps above 0.05, while any rounding (to
 * micro-ppm, say) would accept values just above a limit. So the extractor hands over each value as
 * its shortest round-trip decimal string, and the width and spread rules compare those decimals
 * exactly as scaled integers. Midpoints and medians are still computed as numbers from the strings.
 */
export const MAX_RANGE_WIDTH_PPM = "1";
export const MAX_PEAK_SPREAD_PPM = "0.05";
export const MIN_SHIFT_PPM = -300;
export const MAX_SHIFT_PPM = 250;

/** An exact decimal: `coefficient × 10^−scale`, normalized (no trailing zeros; zero has scale 0). */
interface Decimal {
  coefficient: bigint;
  scale: number;
}

/**
 * A plain decimal as written by Python's `repr` of an int or float: optional minus sign, digits,
 * optional fraction, optional exponent. No leading plus, no whitespace, no bare dot, no inf/nan.
 */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
/** Python's shortest float repr needs at most 17 digits and exponent −324; far more than enough. */
const MAX_DECIMAL_SCALE = 400;
const ZERO = BigInt(0);
const TEN = BigInt(10);

/** Exact value and number of a decimal string, or null if it is malformed or not finite. */
export function parseDecimal(text: string): { exact: Decimal; value: number } | null {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const exponentValue = Number(exponent);
  if (!Number.isSafeInteger(exponentValue)) return null;
  let coefficient = BigInt(`${sign}${whole}${fraction}`);
  let scale = fraction.length - exponentValue;
  if (coefficient === ZERO) return { exact: { coefficient: ZERO, scale: 0 }, value };
  while (coefficient % TEN === ZERO) {
    coefficient /= TEN;
    scale -= 1;
  }
  if (scale > MAX_DECIMAL_SCALE) return null;
  if (scale < 0) {
    // Bounded: a finite double is below 1e309.
    coefficient *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { exact: { coefficient, scale }, value };
}

/** The coefficient of `d` at the (larger or equal) scale `scale`. */
function atScale(d: Decimal, scale: number): bigint {
  return d.coefficient * TEN ** BigInt(scale - d.scale);
}

function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: atScale(a, scale) + atScale(b, scale), scale };
}

function subtract(a: Decimal, b: Decimal): Decimal {
  return add(a, { coefficient: -b.coefficient, scale: b.scale });
}

function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = atScale(a, scale);
  const y = atScale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function abs(d: Decimal): Decimal {
  return d.coefficient < ZERO ? { coefficient: -d.coefficient, scale: d.scale } : d;
}

function exactLimit(text: string): Decimal {
  const parsed = parseDecimal(text);
  if (!parsed) throw new Error(`invalid limit ${text}`);
  return parsed.exact;
}

const MAX_RANGE_WIDTH = exactLimit(MAX_RANGE_WIDTH_PPM);
/** Spread is compared on doubled values, so a range midpoint (a + b) / 2 stays exact as a + b. */
const MAX_DOUBLED_SPREAD = add(exactLimit(MAX_PEAK_SPREAD_PPM), exactLimit(MAX_PEAK_SPREAD_PPM));

/** §2.6: lowercase, trim, then remove ONE trailing supplement suffix. */
export function sourceKey(filename: string): string {
  return filename
    .toLowerCase()
    .trim()
    .replace(/(?:_moesm\d+_esm|_si_\d+|-sup-\d+-misc_information)$/, "");
}

/**
 * §2.4: the row's single shift from its tuples' shift elements, or the reason it drops. Each
 * element is a decimal string or a two-element list of decimal strings (a range); anything else,
 * malformed strings included, drops as peak shape.
 */
export function peakShift(peaks: readonly unknown[]): { shift: number } | { drop: PeakDropReason } {
  if (peaks.length === 0) return { drop: "no-peak-values" };
  const values: number[] = [];
  const doubled: Decimal[] = [];
  for (const peak of peaks) {
    const single = typeof peak === "string" ? parseDecimal(peak) : null;
    if (single) {
      values.push(single.value);
      doubled.push(add(single.exact, single.exact));
      continue;
    }
    if (Array.isArray(peak) && peak.length === 2 && typeof peak[0] === "string" && typeof peak[1] === "string") {
      const a = parseDecimal(peak[0]);
      const b = parseDecimal(peak[1]);
      if (a && b) {
        if (compare(abs(subtract(a.exact, b.exact)), MAX_RANGE_WIDTH) > 0) return { drop: "peak-range-too-wide" };
        values.push((a.value + b.value) / 2);
        doubled.push(add(a.exact, b.exact));
        continue;
      }
    }
    return { drop: "peak-shape" };
  }
  let min = doubled[0];
  let max = doubled[0];
  for (const d of doubled) {
    if (compare(d, min) < 0) min = d;
    if (compare(d, max) > 0) max = d;
  }
  if (compare(subtract(max, min), MAX_DOUBLED_SPREAD) > 0) return { drop: "peak-spread" };
  return { shift: median(values) };
}

/** §2.7: stereo-free OpenChemLib idcode, as in the ³¹P benchmark (`benchmark.ts`). */
export function stereoFreeIdcode(molecule: OCL.Molecule): string {
  return new OCL.Canonizer(molecule, { neglectAnyStereoInformation: true }).getIDCode();
}

/** §2.7: OpenChemLib's default idcode, keeping R/S and E/Z. */
export function stereoIdcode(molecule: OCL.Molecule): string {
  return new OCL.Canonizer(molecule).getIDCode();
}

/**
 * §2.2: remove, in place, every atom outside the fragment `fragment` (as numbered by
 * `getFragmentNumbers(fragmentNo, false, false)`), explicit hydrogens included. Returns the number of
 * other fragments removed.
 */
function keepOnlyFragment(molecule: OCL.Molecule, fragmentNo: readonly number[], fragment: number): number {
  const others = new Set<number>();
  const remove: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (fragmentNo[atom] !== fragment) {
      remove.push(atom);
      others.add(fragmentNo[atom]);
    }
  }
  if (remove.length > 0) molecule.deleteAtoms(remove);
  // Deletion leaves the helper arrays stale (atom counts included); re-materialize them as
  // normalizeStructure does. This may reorder hydrogens, so atom indices are re-read afterwards.
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return others.size;
}

function fluorineAtoms(molecule: OCL.Molecule): number[] {
  const fluorines: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 9) fluorines.push(atom);
  }
  return fluorines;
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
  const allFluorines = fluorineAtoms(molecule);
  if (allFluorines.length === 0) return { drop: "no-fluorine" };
  const fragmentNo = new Array<number>(molecule.getAllAtoms()).fill(-1);
  molecule.getFragmentNumbers(fragmentNo, false, false);
  const fluorineFragments = new Set(allFluorines.map((atom) => fragmentNo[atom]));
  if (fluorineFragments.size > 1) {
    return { drop: "fluorine-in-multiple-fragments" };
  }

  // §2.2 from here on the molecule is the fluorine-bearing fragment only: counterions and solvent
  // are removed before symmetry classes, fluorine type and identity, so a salt and its fluorinated
  // component are the same molecule.
  let removedFragments: number;
  let fluorines: number[];
  try {
    removedFragments = keepOnlyFragment(molecule, fragmentNo, [...fluorineFragments][0]);
    fluorines = fluorineAtoms(molecule);
  } catch {
    return { drop: "fragment-extraction-failed" };
  }
  if (fluorines.length !== allFluorines.length) return { drop: "fragment-extraction-failed" };

  // §2.3 the production lookup's stereo-free constitutional classes: atoms of one class share a
  // representative.
  let representatives: Set<number>;
  try {
    const context = prepareProductionLookup(molecule);
    representatives = new Set(fluorines.map((atom) => productionClassRepresentative(context, atom)));
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
  let stereoFree: string;
  let stereo: string;
  try {
    stereoFree = stereoFreeIdcode(molecule);
    stereo = stereoIdcode(molecule);
  } catch {
    return { drop: "idcode-failed" };
  }
  if (!stereoFree || !stereo) return { drop: "idcode-failed" };

  return {
    row: row.row,
    sourceKey: key,
    stereoFreeIdcode: stereoFree,
    stereoIdcode: stereo,
    shift: peak.shift,
    solvent: row.solvent,
    fluorineAtoms: fluorines.length,
    fluorineType: fluorineType(molecule, fluorines[0]),
    removedFragments
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
