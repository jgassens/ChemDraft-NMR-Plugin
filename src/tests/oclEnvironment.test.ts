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
