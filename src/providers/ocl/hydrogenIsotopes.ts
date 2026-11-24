import type * as OCL from "openchemlib";

/** Both molfile D and H + M ISO 2 parse as atomic number 1, mass 2 in OpenChemLib. */
export function isDeuterium(molecule: OCL.Molecule, atom: number): boolean {
  return molecule.getAtomicNo(atom) === 1 && molecule.getAtomMass(atom) === 2;
}

export function attachedDeuteriumAtoms(molecule: OCL.Molecule, host: number): number[] {
  const atoms: number[] = [];
  for (let connection = 0; connection < molecule.getAllConnAtoms(host); connection += 1) {
    const neighbor = molecule.getConnAtom(host, connection);
    if (isDeuterium(molecule, neighbor)) atoms.push(neighbor);
  }
  return atoms;
}

/** OCL's total includes explicit D. D is a coupling partner, never an observed ¹H nucleus. */
export function protonCount(molecule: OCL.Molecule, host: number): number {
  return Math.max(0, molecule.getAllHydrogens(host) - attachedDeuteriumAtoms(molecule, host).length);
}
