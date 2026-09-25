import type * as OCL from "openchemlib";

import type { NmrNucleus } from "../../domain/contracts";
import { describeAtomEnvironment } from "../fixture/fixtureEnvironment";

/** Deepest HOSE-style sphere depth generated/searched. Query falls back from here toward sphere 1. */
export const MAX_SPHERES = 4;

/** Database key namespacing the environment code by nucleus so ¹³C and ¹H codes never collide. */
export function environmentKey(nucleus: NmrNucleus, code: string): string {
  return `${nucleus}@${code}`;
}

/** Number of sphere groups `( … )` in a code — i.e. the depth it represents. */
export function sphereDepthOf(code: string): number {
  return (code.match(/\(/g) ?? []).length;
}

/**
 * Environment codes for one atom at every sphere depth, deepest first (index 0 = MAX_SPHERES).
 * The same describeAtomEnvironment used by the fixture provider. Its breadth-first walk depends on
 * atom order at deep spheres, so on its own it does NOT give identical codes for the same atom in
 * two differently ordered inputs (e.g. an NMReDATA molfile vs. a user's SMILES). Database ingestion
 * and production lookup therefore never call this directly on their input; both go through
 * `productionEnvironmentCodes` (productionLookup.ts), which applies it to an explicit-H-stripped,
 * OCL-canonical copy at the canonical index of the atom's symmetry-class representative.
 */
export function atomEnvironmentCodes(molecule: OCL.Molecule, atom: number, maxSpheres = MAX_SPHERES): string[] {
  const codes: string[] = [];
  for (let spheres = maxSpheres; spheres >= 1; spheres -= 1) {
    codes.push(describeAtomEnvironment(molecule, atom, spheres).environmentCode);
  }
  return codes;
}

/** The heavy atom a hydrogen is attached to (its first neighbor), or -1 if none. */
export function protonHostAtom(molecule: OCL.Molecule, hydrogenAtom: number): number {
  return molecule.getConnAtoms(hydrogenAtom) > 0 ? molecule.getConnAtom(hydrogenAtom, 0) : -1;
}
