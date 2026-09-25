import * as OCL from "openchemlib";

export interface IndexedNmredataMolecule {
  molecule: OCL.Molecule;
  /** 1-based molfile atom index (what NMReDATA assignments cite) → OCL atom index in `molecule`. */
  oclAtomByMolfileIndex: ReadonlyMap<number, number>;
}

/**
 * Parse an NMReDATA molfile and map its 1-based atom indices onto OCL atom indices. OCL reorders
 * atoms while parsing (explicit H are swapped to the end, which also moves the heavy atom they
 * traded places with), so indices cannot be tagged after parsing. Instead each atom's molfile index
 * is written into the atom-atom mapping field first; OCL carries mapping numbers through the
 * reorder. Returns undefined when the molfile cannot be parsed or the mapping is not one-to-one.
 */
export function parseNmredataMolecule(molfile: string): IndexedNmredataMolecule | undefined {
  const stamped = stampMolfileAtomIndexes(molfile);
  if (!stamped) return undefined;

  let molecule: OCL.Molecule;
  try {
    molecule = OCL.Molecule.fromMolfile(stamped.molfile);
  } catch {
    return undefined;
  }
  if (molecule.getAllAtoms() === 0 || molecule.getAllAtoms() !== stamped.atomCount) return undefined;
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);

  const oclAtomByMolfileIndex = new Map<number, number>();
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const molfileIndex = molecule.getAtomMapNo(atom);
    if (molfileIndex < 1 || molfileIndex > stamped.atomCount || oclAtomByMolfileIndex.has(molfileIndex)) {
      return undefined;
    }
    oclAtomByMolfileIndex.set(molfileIndex, atom);
  }
  return { molecule, oclAtomByMolfileIndex };
}

function stampMolfileAtomIndexes(molfile: string): { molfile: string; atomCount: number } | undefined {
  const lines = molfile.split("\n");
  const countsIndex = lines.findIndex((line) => /V2000|V3000/.test(line));
  if (countsIndex < 0) return undefined;
  return /V3000/.test(lines[countsIndex])
    ? stampV3000(lines)
    : stampV2000(lines, countsIndex);
}

/** V2000 atom line: the atom-atom mapping number occupies columns 61–63 (0-based 60–62). */
function stampV2000(lines: string[], countsIndex: number): { molfile: string; atomCount: number } | undefined {
  const atomCount = Number(lines[countsIndex].slice(0, 3));
  if (!Number.isInteger(atomCount) || atomCount <= 0 || countsIndex + atomCount >= lines.length) return undefined;
  const out = [...lines];
  for (let index = 1; index <= atomCount; index += 1) {
    const line = out[countsIndex + index].padEnd(69, " ");
    out[countsIndex + index] = `${line.slice(0, 60)}${String(index).padStart(3)}${line.slice(63)}`;
  }
  return { molfile: out.join("\n"), atomCount };
}

/** V3000 atom line: `M  V30 index type x y z aamap [props]` — aamap is set to the atom's own index. */
function stampV3000(lines: string[]): { molfile: string; atomCount: number } | undefined {
  const out = [...lines];
  let inAtomBlock = false;
  let continued = false;
  let atomCount = 0;
  for (let row = 0; row < out.length; row += 1) {
    const line = out[row];
    if (/^M {2}V30 BEGIN ATOM/.test(line)) {
      inAtomBlock = true;
      continue;
    }
    if (/^M {2}V30 END ATOM/.test(line)) break;
    if (!inAtomBlock || !line.startsWith("M  V30 ")) continue;
    const wasContinuation = continued;
    continued = line.trimEnd().endsWith("-");
    if (wasContinuation) continue;
    const fields = line.slice("M  V30 ".length).trim().split(/\s+/);
    if (fields.length < 6) return undefined;
    atomCount += 1;
    fields[5] = fields[0];
    out[row] = `M  V30 ${fields.join(" ")}`;
  }
  return atomCount > 0 ? { molfile: out.join("\n"), atomCount } : undefined;
}
