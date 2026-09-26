import { describe, expect, it } from "vitest";

import { parseNmredataMolecule } from "../providers/ocl/nmredataMolecule";

// Methanol written H-first with distinct x coordinates, so each molfile index is identifiable after
// OCL has reordered the atoms (it swaps explicit H to the end while parsing).
const V2000_H_FIRST = `
  test

  6  5  0  0  0  0  0  0  0  0999 V2000
    1.0000    0.0000    0.0000 H   0  0
    2.0000    0.0000    0.0000 H   0  0
    3.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    4.0000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
    5.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    6.0000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  3  1  0  0  0  0
  2  3  1  0  0  0  0
  4  3  1  0  0  0  0
  3  5  1  0  0  0  0
  6  5  1  0  0  0  0
M  END`;

const V3000_H_FIRST = `
  test

  0  0  0     0  0            999 V3000
M  V30 BEGIN CTAB
M  V30 COUNTS 6 5 0 0 0
M  V30 BEGIN ATOM
M  V30 1 H 1 0 0 0
M  V30 2 H 2 0 0 0
M  V30 3 C 3 0 0 0
M  V30 4 H 4 0 0 0
M  V30 5 O 5 0 0 0
M  V30 6 H 6 0 0 0
M  V30 END ATOM
M  V30 BEGIN BOND
M  V30 1 1 1 3
M  V30 2 1 2 3
M  V30 3 1 4 3
M  V30 4 1 3 5
M  V30 5 1 6 5
M  V30 END BOND
M  V30 END CTAB
M  END`;

const V3000_NONCONSECUTIVE = `
  test

  0  0  0     0  0            999 V3000
M  V30 BEGIN CTAB
M  V30 COUNTS 2 1 0 0 0
M  V30 BEGIN ATOM
M  V30 10 C 0.866 0 0 0
M  V30 20 O 1.732 0 0 0
M  V30 END ATOM
M  V30 BEGIN BOND
M  V30 1 1 10 20
M  V30 END BOND
M  V30 END CTAB
M  END`;

describe("parseNmredataMolecule", () => {
  it.each([
    ["V2000", V2000_H_FIRST],
    ["V3000", V3000_H_FIRST]
  ])("maps every %s molfile index to the OCL atom that was written there", (_format, molfile) => {
    const parsed = parseNmredataMolecule(molfile);
    expect(parsed).toBeDefined();
    const { molecule, oclAtomByMolfileIndex } = parsed!;

    expect(oclAtomByMolfileIndex.size).toBe(6);
    // OCL really did reorder: the carbon (molfile 3) is not at OCL index 2.
    expect(oclAtomByMolfileIndex.get(3)).not.toBe(2);
    const labels = ["H", "H", "C", "H", "O", "H"];
    for (let molfileIndex = 1; molfileIndex <= 6; molfileIndex += 1) {
      const atom = oclAtomByMolfileIndex.get(molfileIndex)!;
      expect(molecule.getAtomLabel(atom)).toBe(labels[molfileIndex - 1]);
      expect(molecule.getAtomX(atom)).toBeCloseTo(molfileIndex);
    }
  });

  it("returns undefined for text that is not a molfile", () => {
    expect(parseNmredataMolecule("not a molfile")).toBeUndefined();
  });

  it("normalizes CRLF before stamping short V2000 atom lines", () => {
    const parsed = parseNmredataMolecule(V2000_H_FIRST.replace(/\n/g, "\r\n"));
    expect(parsed).toBeDefined();
    expect(parsed?.oclAtomByMolfileIndex.size).toBe(6);
    expect(parsed?.molecule.getAtomLabel(parsed.oclAtomByMolfileIndex.get(3)!)).toBe("C");
  });

  it("maps nonconsecutive V3000 atom IDs rather than atom-block positions", () => {
    const parsed = parseNmredataMolecule(V3000_NONCONSECUTIVE);
    expect(parsed).toBeDefined();
    expect([...parsed!.oclAtomByMolfileIndex.keys()].sort((a, b) => a - b)).toEqual([10, 20]);
    expect(parsed?.oclAtomByMolfileIndex.has(1)).toBe(false);
    expect(parsed?.molecule.getAtomLabel(parsed.oclAtomByMolfileIndex.get(20)!)).toBe("O");
  });

  it("assembles continued V3000 atom records before tokenizing lists, quotes, and properties", () => {
    const molfile = V3000_NONCONSECUTIVE.replace(
      "M  V30 10 C 0.866 0 0 0",
      'M  V30 10 NOT [C,N] 0.866 0 0 -\nM  V30 0 LABEL="quoted value" RGROUPS=(2 1 2)'
    );
    const parsed = parseNmredataMolecule(molfile);

    expect(parsed).toBeDefined();
    expect(parsed?.oclAtomByMolfileIndex.size).toBe(2);
    expect(parsed?.molecule.getAtomX(parsed.oclAtomByMolfileIndex.get(10)!)).toBeCloseTo(0.866);
    expect(parsed?.molecule.getAtomLabel(parsed.oclAtomByMolfileIndex.get(20)!)).toBe("O");
  });
});
