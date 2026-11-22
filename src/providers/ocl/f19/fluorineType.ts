import * as OCL from "openchemlib";

import { countBondedTo, isCarbonyl } from "../oclTopology";

/** docs/f19-benchmark.md §6, in first-match order. */
export const FLUORINE_TYPES = ["hetero-F", "CF3", "CF2", "aryl-F", "acyl-F", "vinyl-F", "alkyl-F", "other"] as const;
export type FluorineType = (typeof FLUORINE_TYPES)[number];

/**
 * The type of one fluorine atom, by the atom it is bonded to. "Bearing three/two/one F" counts
 * the fluorines on that carbon exactly, so CF4 falls through to `other`. A fluorine with only an
 * (implicit or explicit) hydrogen partner is bonded to a non-carbon atom, so HF is `hetero-F`; a
 * fluorine with no partner, or more than one, is `other`.
 */
export function fluorineType(molecule: OCL.Molecule, fluorineAtom: number): FluorineType {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  if (molecule.getAtomicNo(fluorineAtom) !== 9) {
    throw new Error(`Atom ${fluorineAtom} is not fluorine.`);
  }
  const partners = molecule.getAllConnAtoms(fluorineAtom) + molecule.getImplicitHydrogens(fluorineAtom);
  if (partners !== 1) return "other";
  if (molecule.getAllConnAtoms(fluorineAtom) === 0) return "hetero-F"; // H–F with implicit H

  const host = molecule.getConnAtom(fluorineAtom, 0);
  if (molecule.getAtomicNo(host) !== 6) return "hetero-F";

  const aromatic = molecule.isAromaticAtom(host);
  const sp3 = !aromatic && molecule.getAtomPi(host) === 0;
  const fluorineCount = countBondedTo(molecule, host, 9);
  if (sp3 && fluorineCount === 3) return "CF3";
  if (sp3 && fluorineCount === 2) return "CF2";
  if (aromatic) return "aryl-F";
  if (isCarbonyl(molecule, host)) return "acyl-F";
  if (molecule.getAtomPi(host) === 1) return "vinyl-F";
  if (sp3 && fluorineCount === 1) return "alkyl-F";
  return "other";
}
