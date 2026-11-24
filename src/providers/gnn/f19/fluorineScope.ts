/**
 * Which fluorinated molecules the ¹⁹F predictor answers for (docs/f19-benchmark.md §2.2, §2.3, §6).
 *
 * The rules are those of the reviewed cleaning code (`src/providers/ocl/f19/clean.ts`, `cleanRow`),
 * which defined every molecule the model was trained, selected and scored on:
 *
 * - fluorine environments are the plugin's stereo-free constitutional symmetry classes
 *   (`prepareProductionLookup`), so atoms of one class share a canonical representative;
 * - the molecule is the fluorine-bearing fragment only: other fragments (counterions, solvent) are
 *   removed, and fluorine in more than one fragment is outside the scored domain;
 * - the fluorine type is `fluorineType` of the class (§6, first matching rule).
 *
 * This version predicts a molecule only when all its fluorines form one environment, in one fragment,
 * of type CF3. Everything else is declined with a plain warning and no shift.
 *
 * Pure and worker-safe.
 */
import * as OCL from "openchemlib";

import { fluorineType, type FluorineType } from "../../ocl/f19/fluorineType";
import { productionClassRepresentative, type ProductionLookupContext } from "../../ocl/productionLookup";

export type FluorineScope =
  /** No fluorine: nothing to predict and nothing to say. */
  | { kind: "none" }
  /** More than one symmetry class of fluorine. */
  | { kind: "multiple-environments"; fluorines: number[]; environments: number }
  /** One symmetry class, but spread over more than one disconnected fragment (§2.2). */
  | { kind: "multiple-fragments"; fluorines: number[]; fragments: number }
  /** One environment of a type this version does not predict. */
  | { kind: "type-not-predicted"; fluorines: number[]; type: FluorineType }
  /** One environment, one fragment, CF3: predicted. */
  | { kind: "cf3"; fluorines: number[] };

/** Fluorine atoms of `molecule`, ascending. */
export function fluorineAtoms(molecule: OCL.Molecule): number[] {
  const fluorines: number[] = [];
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 9) fluorines.push(atom);
  }
  return fluorines;
}

function fragmentNumbers(molecule: OCL.Molecule): number[] {
  const fragmentNo = new Array<number>(molecule.getAllAtoms()).fill(-1);
  molecule.getFragmentNumbers(fragmentNo, false, false);
  return fragmentNo;
}

/**
 * Classify `molecule` (the normalized input) for ¹⁹F. `context` must be the production lookup prepared
 * on this same molecule.
 */
export function fluorineScope(molecule: OCL.Molecule, context: ProductionLookupContext): FluorineScope {
  const fluorines = fluorineAtoms(molecule);
  if (fluorines.length === 0) return { kind: "none" };
  const environments = new Set(fluorines.map((atom) => productionClassRepresentative(context, atom))).size;
  if (environments > 1) return { kind: "multiple-environments", fluorines, environments };
  const fragmentNo = fragmentNumbers(molecule);
  const fragments = new Set(fluorines.map((atom) => fragmentNo[atom])).size;
  if (fragments > 1) return { kind: "multiple-fragments", fluorines, fragments };
  const type = fluorineType(molecule, fluorines[0]);
  return type === "CF3" ? { kind: "cf3", fluorines } : { kind: "type-not-predicted", fluorines, type };
}

/** The fluorine-bearing fragment as its own molecule, with the atom mapping back to the input. */
export interface FluorineFragment {
  molecule: OCL.Molecule;
  /** Fragment atom index → input atom index. */
  toInput: readonly number[];
  /** Input atom index → fragment atom index, or −1 for an atom of another fragment. */
  fromInput: readonly number[];
}

/**
 * §2.2: the fragment holding `fluorines` (all in one fragment), other fragments removed exactly as
 * `cleanRow` removes them. When the molecule is a single fragment it is returned as is. Throws when
 * OpenChemLib does not keep the atom identities, so the caller can decline instead of guessing.
 */
export function fluorineFragment(molecule: OCL.Molecule, fluorines: readonly number[]): FluorineFragment {
  const atoms = molecule.getAllAtoms();
  const fragmentNo = fragmentNumbers(molecule);
  const keep = fragmentNo[fluorines[0]];
  const remove: number[] = [];
  for (let atom = 0; atom < atoms; atom += 1) if (fragmentNo[atom] !== keep) remove.push(atom);
  if (remove.length === 0) {
    const identity = Array.from({ length: atoms }, (_, atom) => atom);
    return { molecule, toInput: identity, fromInput: identity };
  }
  const fragment = molecule.getCompactCopy();
  const fromInput = Array.from(fragment.deleteAtoms(remove), (index) => (Number.isInteger(index) ? index : -1));
  fragment.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const toInput = new Array<number>(fragment.getAllAtoms()).fill(-1);
  for (let atom = 0; atom < atoms; atom += 1) {
    const mapped = fromInput[atom];
    if (fragmentNo[atom] === keep) {
      if (mapped === undefined || mapped < 0 || mapped >= toInput.length) {
        throw new Error("Removing the other fragments lost an atom of the fluorine-bearing fragment.");
      }
      if (
        fragment.getAtomicNo(mapped) !== molecule.getAtomicNo(atom) ||
        fragment.getAtomCharge(mapped) !== molecule.getAtomCharge(atom) ||
        fragment.getAtomMass(mapped) !== molecule.getAtomMass(atom)
      ) {
        throw new Error("Removing the other fragments changed an atom of the fluorine-bearing fragment.");
      }
      toInput[mapped] = atom;
    } else if (mapped !== undefined && mapped >= 0) {
      throw new Error("Removing the other fragments kept an atom of another fragment.");
    }
  }
  if (toInput.some((atom) => atom < 0)) {
    throw new Error("The fluorine-bearing fragment has an atom with no input atom.");
  }
  return { molecule: fragment, toInput, fromInput: fromInput.slice(0, atoms) };
}
