import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { atomEnvironmentCodes, environmentKey, sphereDepthOf } from "../providers/ocl/environmentCode";
import { prepareProductionLookup, productionEnvironmentCodes } from "../providers/ocl/productionLookup";

describe("environment code helpers", () => {
  it("namespaces keys by nucleus", () => {
    expect(environmentKey("13C", "Cq0h3()")).toBe("13C@Cq0h3()");
    expect(environmentKey("1H", "Cq0h3()")).toBe("1H@Cq0h3()");
  });

  it("counts sphere groups as depth", () => {
    expect(sphereDepthOf("Cq0h3(1Ch0)")).toBe(1);
    expect(sphereDepthOf("Cq0h3(1Ch0)(1Ch3,2Oh0)")).toBe(2);
    expect(sphereDepthOf("Caq0h1()()()()")).toBe(4);
  });

  it("returns codes deepest-first, one per sphere depth", () => {
    const mol = OCL.Molecule.fromSmiles("CCO");
    mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const codes = atomEnvironmentCodes(mol, 0, 4);
    expect(codes).toHaveLength(4);
    expect(sphereDepthOf(codes[0])).toBe(4); // deepest first
    expect(sphereDepthOf(codes[3])).toBe(1); // shallowest last
  });

  it.each([1, 2, 3, 4])("encodes a neighboring oxygen's formal charge at sphere %i for 1H and 13C", (sphere) => {
    const chain = "C".repeat(sphere);
    const neutral = prepareProductionLookup(OCL.Molecule.fromSmiles(`${chain}[O]`));
    const charged = prepareProductionLookup(OCL.Molecule.fromSmiles(`${chain}[O-]`));

    for (const nucleus of ["1H", "13C"] as const) {
      const neutralCodes = productionEnvironmentCodes(neutral, nucleus, 0);
      const chargedCodes = productionEnvironmentCodes(charged, nucleus, 0);
      expect(neutralCodes[4 - sphere]).toContain("1Oh0");
      expect(chargedCodes[4 - sphere]).toContain("1Oq-1h0");
      expect(chargedCodes).toEqual(neutralCodes.map((code) => code.replace("1Oh0", "1Oq-1h0")));
    }
  });

  it("encodes both formal charges around the glycine zwitterion methylene", () => {
    const context = prepareProductionLookup(OCL.Molecule.fromSmiles("[NH3+]CC(=O)[O-]"));
    const methylene = 1;
    for (const nucleus of ["1H", "13C"] as const) {
      expect(productionEnvironmentCodes(context, nucleus, methylene)).toEqual([
        "Cq0h2(1Ch0,1Nq1h3)(1Oq-1h0,2Oh0)()()",
        "Cq0h2(1Ch0,1Nq1h3)(1Oq-1h0,2Oh0)()",
        "Cq0h2(1Ch0,1Nq1h3)(1Oq-1h0,2Oh0)",
        "Cq0h2(1Ch0,1Nq1h3)"
      ]);
    }
  });

  it("keeps charge-separated and pentavalent nitro codes distinct", () => {
    const chargeSeparated = OCL.Molecule.fromSmiles("C[N+](=O)[O-]");
    // The SMILES parser normalizes pentavalent nitro to its charge-separated form.
    const pentavalent = OCL.Molecule.fromMolfile(`Nitromethane
  ChemDraft

  4  3  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000    0.0000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
    2.0000    1.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    2.0000   -1.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  2  0  0  0  0
  2  4  2  0  0  0  0
M  END
`);
    const methyl = 0;
    const separatedCodes = productionEnvironmentCodes(prepareProductionLookup(chargeSeparated), "13C", methyl);
    const pentavalentCodes = productionEnvironmentCodes(prepareProductionLookup(pentavalent), "13C", methyl);

    expect(separatedCodes[0]).toBe("Cq0h3(1Nq1h0)(1Oq-1h0,2Oh0)()()");
    expect(pentavalentCodes[0]).toBe("Cq0h3(1Nh0)(2Oh0,2Oh0)()()");
  });

  it("encodes pyridinium nitrogen as aromatic and positively charged", () => {
    const context = prepareProductionLookup(OCL.Molecule.fromSmiles("c1cc[nH+]cc1"));
    const adjacentCarbon = 2;
    const nitrogen = 3;

    expect(productionEnvironmentCodes(context, "13C", adjacentCarbon)[0])
      .toBe("Caq0h1(~Cah1,~Naq1h1)(~Cah1,~Cah1)(~Cah1,~Cah1)(~Cah1)");
    expect(productionEnvironmentCodes(context, "1H", nitrogen)[0])
      .toBe("Naq1h1(~Cah1,~Cah1)(~Cah1,~Cah1)(~Cah1,~Cah1)(~Cah1)");
  });

  it("gives methylammonium nitrogen the same codes with explicit and implicit hydrogen", () => {
    const explicit = OCL.Molecule.fromMolfile(`Methylammonium
  ChemDraft

  3  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000    0.0000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0
    2.0000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
M  CHG  1   2   1
M  END
`);
    const implicit = OCL.Molecule.fromSmiles("C[NH3+]");
    const nitrogen = 1;
    explicit.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
    implicit.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
    expect(explicit.getExplicitHydrogens(nitrogen)).toBe(1);
    expect(implicit.getExplicitHydrogens(nitrogen)).toBe(0);

    const implicitCodes = productionEnvironmentCodes(prepareProductionLookup(implicit), "1H", nitrogen);
    expect(implicitCodes[0]).toBe("Nq1h3(1Ch3)()()()");
    expect(productionEnvironmentCodes(prepareProductionLookup(explicit), "1H", nitrogen)).toEqual(implicitCodes);
  });

  it("preserves neutral 1H and 13C environment codes", () => {
    const context = prepareProductionLookup(OCL.Molecule.fromSmiles("CCO"));
    for (const nucleus of ["1H", "13C"] as const) {
      expect(productionEnvironmentCodes(context, nucleus, 0)).toEqual([
        "Cq0h3(1Ch2)(1Oh1)()()",
        "Cq0h3(1Ch2)(1Oh1)()",
        "Cq0h3(1Ch2)(1Oh1)",
        "Cq0h3(1Ch2)"
      ]);
    }
  });

  it("preserves the 31P codes with explicit zero neighbor charges", () => {
    const context = prepareProductionLookup(OCL.Molecule.fromSmiles("PP"));
    expect(productionEnvironmentCodes(context, "31P", 0)).toEqual([
      "Pq0h2(1Pq0h2)()()()",
      "Pq0h2(1Pq0h2)()()",
      "Pq0h2(1Pq0h2)()",
      "Pq0h2(1Pq0h2)"
    ]);
  });
});
